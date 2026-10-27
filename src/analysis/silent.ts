import type { V1CronJob, V1Job } from "@kubernetes/client-node";
import { jobOutcome } from "./jobs.js";
import {
  countFiresBetween,
  evaluateSchedule,
  fireIntervalSeconds,
  GRACE_SECONDS,
  lastScheduled,
  type ScheduleVerdict,
} from "./schedule.js";
import { assessOverrun } from "./overrun.js";

export type SilentStatus = "silent-failure" | "degraded" | "at-risk" | "suspended" | "healthy";

/**
 * failing:          retained runs end in failure and nothing succeeded in the window
 * stalled:          last success is stale and there are no retained failures (not firing, or evidence evicted)
 * never-succeeded:  no success on record at all and no retained failures
 */
export type SilentPattern = "failing" | "stalled" | "never-succeeded";

export interface CronJobAssessment {
  namespace: string;
  name: string;
  status: SilentStatus;
  pattern?: SilentPattern;
  severity: "high" | "medium" | "low";
  summary: string;
  schedule: string;
  lastSuccess?: string;
  secondsSinceSuccess?: number;
  lastFailure?: { job: string; time?: string; reason?: string };
  consecutiveFailures: number;
  retainedRuns: number;
  scheduleVerdict?: ScheduleVerdict;
  /** Scheduled fire times since the CronJob last showed any activity (no run active). */
  missedRuns?: number;
  /** Runs take longer than the gap between scheduled fire times. */
  overrunning: boolean;
  /** Runs use more than 80% of the time between scheduled runs. */
  atRisk: boolean;
  notes: string[];
}

/** A window shorter than two cadences would flag every slow-cadence job, so widen it. */
const CADENCES_PER_WINDOW = 2;
/** Success inside the window but this many trailing failures is reported as degraded. */
const DEGRADED_FAILURES = 2;
/** This many scheduled fire times with no run started means the CronJob has stopped firing. */
export const MISSED_RUNS_THRESHOLD = 3;

function formatAge(seconds: number): string {
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)}m`;
  }
  if (seconds < 172800) {
    return `${(seconds / 3600).toFixed(1)}h`;
  }
  return `${(seconds / 86400).toFixed(1)}d`;
}

export function assessCronJob(input: {
  cronJob: V1CronJob;
  jobs: V1Job[];
  now: Date;
  windowSeconds: number;
}): CronJobAssessment {
  const { cronJob, jobs, now } = input;
  const namespace = cronJob.metadata?.namespace ?? "";
  const name = cronJob.metadata?.name ?? "";
  const schedule = cronJob.spec?.schedule ?? "";
  const notes: string[] = [];

  const runs = jobs
    .map((job) => ({ job, outcome: jobOutcome(job) }))
    .sort((a, b) => (a.outcome.startTime?.getTime() ?? 0) - (b.outcome.startTime?.getTime() ?? 0));
  const finished = runs.filter((r) => r.outcome.status !== "Running");

  let consecutiveFailures = 0;
  for (let i = finished.length - 1; i >= 0; i--) {
    if (finished[i]?.outcome.status === "Succeeded") {
      break;
    }
    consecutiveFailures++;
  }

  // status.lastSuccessfulTime survives Job eviction, so it covers history-limit gaps.
  let lastSuccessMs: number | undefined = undefined;
  const fromStatus = cronJob.status?.lastSuccessfulTime;
  if (fromStatus) {
    lastSuccessMs = new Date(fromStatus).getTime();
  }
  for (const run of finished) {
    if (run.outcome.status === "Succeeded" && run.outcome.endTime) {
      const t = run.outcome.endTime.getTime();
      if (lastSuccessMs === undefined || t > lastSuccessMs) {
        lastSuccessMs = t;
      }
    }
  }

  let lastFailure: CronJobAssessment["lastFailure"] = undefined;
  for (let i = finished.length - 1; i >= 0; i--) {
    const run = finished[i];
    if (run && run.outcome.status !== "Succeeded") {
      lastFailure = {
        job: run.job.metadata?.name ?? "",
        time: run.outcome.endTime?.toISOString(),
        reason: run.outcome.reason ?? run.outcome.status,
      };
      break;
    }
  }

  let windowSeconds = input.windowSeconds;
  let scheduleVerdict: ScheduleVerdict | undefined = undefined;
  let missedRuns: number | undefined = undefined;
  let overrunning = false;
  let atRisk = false;
  let overrunSummary: string | undefined = undefined;
  try {
    const timeZone = cronJob.spec?.timeZone;
    const interval = fireIntervalSeconds(schedule, timeZone, now);
    windowSeconds = Math.max(windowSeconds, interval * CADENCES_PER_WINDOW);
    scheduleVerdict = evaluateSchedule({ cronJob, jobs, now }).verdict;

    const overrun = assessOverrun({ cronJob, jobs, now });
    overrunning = overrun.overrunning;
    atRisk = overrun.atRisk;
    overrunSummary = overrun.summary;

    // Latest sign of life: a scheduled run, a job start or a success.
    const active = (cronJob.status?.active?.length ?? 0) > 0 || runs.some((r) => r.outcome.status === "Running");
    if (!active && !cronJob.spec?.suspend) {
      const evidence: number[] = [];
      const fromJobs = lastScheduled(cronJob, jobs).time;
      if (fromJobs) {
        evidence.push(fromJobs.getTime());
      }
      if (cronJob.status?.lastScheduleTime) {
        evidence.push(new Date(cronJob.status.lastScheduleTime).getTime());
      }
      if (lastSuccessMs !== undefined) {
        evidence.push(lastSuccessMs);
      }
      for (const run of runs) {
        if (run.outcome.startTime) {
          evidence.push(run.outcome.startTime.getTime());
        }
      }
      if (evidence.length > 0) {
        const since = new Date(Math.max(...evidence));
        missedRuns = countFiresBetween(schedule, timeZone, since, new Date(now.getTime() - GRACE_SECONDS * 1000));
      }
    }
  } catch {
    notes.push(`Could not parse schedule "${schedule}"; used the requested window as-is`);
  }

  const createdMs = new Date(cronJob.metadata?.creationTimestamp ?? now).getTime();
  const ageSeconds = Math.round((now.getTime() - createdMs) / 1000);
  let secondsSinceSuccess: number | undefined = undefined;
  if (lastSuccessMs !== undefined) {
    secondsSinceSuccess = Math.round((now.getTime() - lastSuccessMs) / 1000);
  }
  let lastSuccess: string | undefined = undefined;
  if (lastSuccessMs !== undefined) {
    lastSuccess = new Date(lastSuccessMs).toISOString();
  }

  const base = {
    namespace,
    name,
    schedule,
    lastSuccess,
    secondsSinceSuccess,
    lastFailure,
    consecutiveFailures,
    retainedRuns: runs.length,
    scheduleVerdict,
    missedRuns,
    overrunning,
    atRisk,
    notes,
  };

  if (cronJob.spec?.suspend) {
    return {
      ...base,
      status: "suspended",
      severity: "low",
      summary: "Suspended (spec.suspend=true); not expected to run",
    };
  }

  const stale = secondsSinceSuccess === undefined || secondsSinceSuccess > windowSeconds;
  // A brand-new CronJob with no failures has not had a fair chance to succeed yet.
  const tooNew = secondsSinceSuccess === undefined && consecutiveFailures === 0 && ageSeconds <= windowSeconds;

  if (stale && !tooNew) {
    let pattern: SilentPattern = "stalled";
    let severity: "high" | "medium" | "low" = "medium";
    let summary = "";
    let sinceText = "ever";
    if (lastSuccess !== undefined) {
      sinceText = `in ${formatAge(secondsSinceSuccess ?? 0)}`;
    }
    if (consecutiveFailures > 0) {
      pattern = "failing";
      severity = "high";
      summary = `No successful run ${sinceText}; the last ${consecutiveFailures} retained run(s) failed`;
      if (lastFailure?.reason) {
        summary += ` (${lastFailure.reason})`;
      }
    } else if (lastSuccess === undefined) {
      pattern = "never-succeeded";
      summary = `No successful run on record and no retained failures; either it has never run or its history was evicted`;
      const failedLimit = cronJob.spec?.failedJobsHistoryLimit;
      const successLimit = cronJob.spec?.successfulJobsHistoryLimit;
      if (failedLimit === 0 || successLimit === 0) {
        notes.push("History limit of 0 deletes finished Jobs, so failures may be invisible");
      }
    } else {
      summary = `Last success was ${formatAge(secondsSinceSuccess ?? 0)} ago and no failures are retained; the CronJob may not be firing`;
    }
    if (scheduleVerdict === "missed") {
      notes.push("Schedule check: the most recent expected run was missed");
    }
    if (missedRuns !== undefined && missedRuns >= MISSED_RUNS_THRESHOLD) {
      notes.push(`No run has started for the last ${missedRuns} scheduled time(s)`);
    }
    return { ...base, status: "silent-failure", pattern, severity, summary };
  }

  // A recent success does not help if the CronJob has since stopped firing.
  if (missedRuns !== undefined && missedRuns >= MISSED_RUNS_THRESHOLD) {
    let capped = `${missedRuns}`;
    if (missedRuns >= 1000) {
      capped = "1000+";
    }
    return {
      ...base,
      status: "silent-failure",
      pattern: "stalled",
      severity: "medium",
      summary: `No run has started for the last ${capped} scheduled times; the CronJob appears to have stopped firing (check startingDeadlineSeconds, controller errors or a schedule edit)`,
    };
  }

  if (consecutiveFailures >= DEGRADED_FAILURES) {
    return {
      ...base,
      status: "degraded",
      severity: "low",
      summary: `Succeeded within the window but the last ${consecutiveFailures} runs failed`,
    };
  }

  if (overrunning && overrunSummary) {
    return { ...base, status: "degraded", severity: "low", summary: overrunSummary };
  }
  if (atRisk && overrunSummary) {
    return { ...base, status: "at-risk", severity: "low", summary: overrunSummary };
  }

  return { ...base, status: "healthy", severity: "low", summary: "Recent successful run" };
}

const STATUS_ORDER: Record<SilentStatus, number> = {
  "silent-failure": 0,
  degraded: 1,
  "at-risk": 2,
  suspended: 3,
  healthy: 4,
};
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

/** Most urgent first: status, severity, then longest time without success. */
export function compareAssessments(a: CronJobAssessment, b: CronJobAssessment): number {
  const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
  if (byStatus !== 0) {
    return byStatus;
  }
  const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  if (bySeverity !== 0) {
    return bySeverity;
  }
  const aAge = a.secondsSinceSuccess ?? Number.POSITIVE_INFINITY;
  const bAge = b.secondsSinceSuccess ?? Number.POSITIVE_INFINITY;
  if (aAge === bAge) {
    return `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`);
  }
  if (aAge > bAge) {
    return -1;
  }
  return 1;
}
