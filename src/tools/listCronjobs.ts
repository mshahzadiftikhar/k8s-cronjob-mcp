import type { V1Job } from "@kubernetes/client-node";
import type { ClusterReader } from "../k8s/client.js";
import { assessCronJob, type CronJobAssessment } from "../analysis/silent.js";
import { jobOutcome } from "../analysis/jobs.js";
import { effectiveTimeZone, lastScheduled, nextFireTime } from "../analysis/schedule.js";
import { formatDays, RETAINED_JOBS_NOTE, scopeOf } from "./basis.js";

export type CronJobHealth =
  | "failing"
  | "stalled"
  | "never-succeeded"
  | "degraded"
  | "overrunning"
  | "at-risk"
  | "suspended"
  | "healthy";

export interface CronJobRow {
  namespace: string;
  name: string;
  schedule: string;
  timeZone: string;
  health: CronJobHealth;
  summary: string;
  nextRun?: string;
  lastScheduled?: string;
  lastSuccess?: string;
  lastResult?: { job: string; status: string; finishedAt?: string; durationSeconds?: number };
  activeRuns: number;
}

export interface ListCronjobsResult {
  scope: string;
  asOf: string;
  /** What the health verdicts are based on, in one sentence. */
  basis: string;
  total: number;
  counts: Record<CronJobHealth, number>;
  cronJobs: CronJobRow[];
  truncated: boolean;
}

const HEALTH_ORDER: Record<CronJobHealth, number> = {
  failing: 0,
  stalled: 1,
  "never-succeeded": 2,
  degraded: 3,
  overrunning: 4,
  "at-risk": 5,
  healthy: 6,
  suspended: 7,
};

export function healthOf(a: CronJobAssessment): CronJobHealth {
  if (a.status === "silent-failure") {
    return a.pattern ?? "stalled";
  }
  if (a.status === "suspended") {
    return "suspended";
  }
  if (a.status === "at-risk") {
    return "at-risk";
  }
  if (a.status === "degraded") {
    if (a.overrunning && a.consecutiveFailures < 2) {
      return "overrunning";
    }
    return "degraded";
  }
  return "healthy";
}

export async function listCronjobs(
  reader: ClusterReader,
  input: { namespace?: string; include_suspended?: boolean; days?: number; limit?: number },
  now: Date = new Date(),
): Promise<ListCronjobsResult> {
  const includeSuspended = input.include_suspended ?? true;
  const days = input.days ?? 7;
  const limit = input.limit ?? 200;
  const [cronJobs, jobs] = await Promise.all([reader.listCronJobs(input.namespace), reader.listJobs(input.namespace)]);

  const jobsByOwner = new Map<string, V1Job[]>();
  for (const job of jobs) {
    for (const owner of job.metadata?.ownerReferences ?? []) {
      if (owner.kind === "CronJob") {
        const list = jobsByOwner.get(owner.uid) ?? [];
        list.push(job);
        jobsByOwner.set(owner.uid, list);
      }
    }
  }

  const counts: Record<CronJobHealth, number> = {
    failing: 0,
    stalled: 0,
    "never-succeeded": 0,
    degraded: 0,
    overrunning: 0,
    "at-risk": 0,
    suspended: 0,
    healthy: 0,
  };

  const rows: CronJobRow[] = [];
  for (const cronJob of cronJobs) {
    const owned = jobsByOwner.get(cronJob.metadata?.uid ?? "") ?? [];
    const assessment = assessCronJob({ cronJob, jobs: owned, now, windowSeconds: days * 86400 });
    const health = healthOf(assessment);
    counts[health]++;
    if (health === "suspended" && !includeSuspended) {
      continue;
    }

    const spec = cronJob.spec;
    let nextRun: string | undefined = undefined;
    if (spec && !spec.suspend) {
      try {
        nextRun = nextFireTime(spec.schedule, spec.timeZone, now).toISOString();
      } catch {
        nextRun = undefined;
      }
    }

    let lastResult: CronJobRow["lastResult"] = undefined;
    const finished = owned
      .map((job) => ({ job, outcome: jobOutcome(job) }))
      .filter((o) => o.outcome.status !== "Running")
      .sort((a, b) => (b.outcome.startTime?.getTime() ?? 0) - (a.outcome.startTime?.getTime() ?? 0));
    const newest = finished[0];
    if (newest) {
      lastResult = {
        job: newest.job.metadata?.name ?? "",
        status: newest.outcome.status,
        finishedAt: newest.outcome.endTime?.toISOString(),
        durationSeconds: newest.outcome.durationSeconds,
      };
    }

    rows.push({
      namespace: assessment.namespace,
      name: assessment.name,
      schedule: assessment.schedule,
      timeZone: effectiveTimeZone(spec?.timeZone),
      health,
      summary: assessment.summary,
      nextRun,
      lastScheduled: lastScheduled(cronJob, owned).time?.toISOString(),
      lastSuccess: assessment.lastSuccess,
      lastResult,
      activeRuns: cronJob.status?.active?.length ?? 0,
    });
  }

  rows.sort((a, b) => {
    const byHealth = HEALTH_ORDER[a.health] - HEALTH_ORDER[b.health];
    if (byHealth !== 0) {
      return byHealth;
    }
    return `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`);
  });

  return {
    scope: scopeOf(reader, input.namespace),
    asOf: now.toISOString(),
    basis: `Health uses the last ${formatDays(days)} for "no recent success", missed scheduled runs, and the median duration of up to 5 recent runs vs the schedule interval; run data is ${RETAINED_JOBS_NOTE}`,
    total: cronJobs.length,
    counts,
    cronJobs: rows.slice(0, limit),
    truncated: rows.length > limit,
  };
}
