import type { V1CronJob, V1Job } from "@kubernetes/client-node";
import { jobOutcome } from "./jobs.js";
import { shortestIntervalSeconds } from "./schedule.js";

export interface OverrunAssessment {
  /** Runs take longer than the gap between scheduled fire times. */
  overrunning: boolean;
  /** Not overrunning yet, but runs use more than AT_RISK_PERCENT of the gap. */
  atRisk: boolean;
  /** Typical run duration as a percentage of the gap between scheduled runs. */
  utilizationPercent?: number;
  /** What the typical duration is based on, e.g. "median of last 2 successful runs". */
  basis: string;
  concurrencyPolicy: string;
  intervalSeconds: number;
  /** Median duration of recent finished runs (successful ones when available). */
  typicalDurationSeconds?: number;
  sampleSize: number;
  /** Elapsed time of the longest currently active run. */
  activeRunSeconds?: number;
  /** Runs that started more than LATE_START_SECONDS after their scheduled time. */
  lateStarts: number;
  maxLateStartSeconds?: number;
  summary?: string;
}

/** Recent finished runs used for the typical duration. */
const RECENT_RUNS = 5;
/** A start this long after the scheduled time counts as late (controller slack is ~seconds). */
export const LATE_START_SECONDS = 60;
/** Runs using more than this share of the schedule interval are close to overrunning. */
export const AT_RISK_PERCENT = 80;

const SCHEDULED_TIMESTAMP_KEY = "batch.kubernetes.io/cronjob-scheduled-timestamp";

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid] ?? 0;
  }
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function formatSeconds(seconds: number): string {
  if (seconds < 120) {
    return `${seconds}s`;
  }
  if (seconds < 7200) {
    return `${Math.round(seconds / 60)}m`;
  }
  return `${(seconds / 3600).toFixed(1)}h`;
}

function effectOf(policy: string, typical: number | undefined, interval: number): string {
  if (policy === "Forbid") {
    let ratio = "";
    if (typical !== undefined && interval > 0) {
      const every = Math.ceil(typical / interval);
      if (every > 1) {
        ratio = `; only about 1 in ${every} scheduled runs actually starts`;
      }
    }
    return `with concurrencyPolicy=Forbid, scheduled runs are skipped or start late while the previous run is still going${ratio}`;
  }
  if (policy === "Replace") {
    return "with concurrencyPolicy=Replace, each new run cancels the one still in progress, so runs may never complete";
  }
  return "with concurrencyPolicy=Allow, runs overlap and pile up";
}

export function assessOverrun(input: { cronJob: V1CronJob; jobs: V1Job[]; now: Date }): OverrunAssessment {
  const { cronJob, jobs, now } = input;
  const spec = cronJob.spec;
  const policy = spec?.concurrencyPolicy ?? "Allow";
  const intervalSeconds = shortestIntervalSeconds(spec?.schedule ?? "", spec?.timeZone, now);

  const outcomes = jobs
    .map((job) => ({ job, outcome: jobOutcome(job) }))
    .sort((a, b) => (b.outcome.startTime?.getTime() ?? 0) - (a.outcome.startTime?.getTime() ?? 0));

  const finished = outcomes.filter((o) => o.outcome.status !== "Running" && o.outcome.durationSeconds !== undefined);
  let sample = finished.filter((o) => o.outcome.status === "Succeeded").slice(0, RECENT_RUNS);
  let sampleKind = "successful";
  if (sample.length === 0) {
    sample = finished.slice(0, RECENT_RUNS);
    sampleKind = "finished";
  }
  let basis = "no finished runs retained";
  if (sample.length > 0) {
    basis = `median of last ${sample.length} ${sampleKind} run${sample.length === 1 ? "" : "s"}`;
  }
  let typicalDurationSeconds: number | undefined = undefined;
  if (sample.length > 0) {
    typicalDurationSeconds = Math.round(median(sample.map((o) => o.outcome.durationSeconds ?? 0)));
  }

  let activeRunSeconds: number | undefined = undefined;
  if (!spec?.suspend) {
    for (const o of outcomes) {
      if (o.outcome.status === "Running" && o.outcome.startTime) {
        const elapsed = Math.round((now.getTime() - o.outcome.startTime.getTime()) / 1000);
        activeRunSeconds = Math.max(activeRunSeconds ?? 0, elapsed);
      }
    }
  }

  let lateStarts = 0;
  let timedRuns = 0;
  let maxLateStartSeconds: number | undefined = undefined;
  for (const o of outcomes) {
    const raw = o.job.metadata?.annotations?.[SCHEDULED_TIMESTAMP_KEY];
    const started = o.job.status?.startTime;
    if (!raw || !started) {
      continue;
    }
    timedRuns++;
    const delay = Math.round((new Date(started).getTime() - new Date(raw).getTime()) / 1000);
    if (delay > LATE_START_SECONDS) {
      lateStarts++;
      maxLateStartSeconds = Math.max(maxLateStartSeconds ?? 0, delay);
    }
  }

  const typicalOver = typicalDurationSeconds !== undefined && typicalDurationSeconds > intervalSeconds;
  const activeOver = activeRunSeconds !== undefined && activeRunSeconds > intervalSeconds;
  const overrunning = !spec?.suspend && intervalSeconds > 0 && (typicalOver || activeOver);
  let utilizationPercent: number | undefined = undefined;
  if (typicalDurationSeconds !== undefined && intervalSeconds > 0) {
    utilizationPercent = Math.round((typicalDurationSeconds / intervalSeconds) * 100);
  }
  const atRisk = !overrunning && !spec?.suspend && utilizationPercent !== undefined && utilizationPercent > AT_RISK_PERCENT;

  let summary: string | undefined = undefined;
  if (overrunning) {
    let evidence = "";
    if (typicalOver && typicalDurationSeconds !== undefined) {
      evidence = `Runs typically take ${formatSeconds(typicalDurationSeconds)} (${basis}) but the schedule fires every ${formatSeconds(intervalSeconds)}`;
    } else if (activeRunSeconds !== undefined) {
      evidence = `The current run has been going for ${formatSeconds(activeRunSeconds)}, longer than the ${formatSeconds(intervalSeconds)} between scheduled runs`;
    }
    summary = `${evidence}; ${effectOf(policy, typicalDurationSeconds, intervalSeconds)}`;
    if (lateStarts > 0 && maxLateStartSeconds !== undefined) {
      summary += `. ${lateStarts} of the ${timedRuns} retained runs started late (up to ${formatSeconds(maxLateStartSeconds)} after their scheduled time)`;
    }
  } else if (atRisk && typicalDurationSeconds !== undefined) {
    let effect = "the next run will start late or be skipped";
    if (policy === "Allow") {
      effect = "runs will start to overlap";
    } else if (policy === "Replace") {
      effect = "the next run will cancel it";
    }
    summary = `Close to overrunning: runs take ${formatSeconds(typicalDurationSeconds)}, ${utilizationPercent}% of the ${formatSeconds(intervalSeconds)} between scheduled runs (${basis}). If a run gets slower, ${effect}`;
  }

  return {
    overrunning,
    atRisk,
    utilizationPercent,
    basis,
    concurrencyPolicy: policy,
    intervalSeconds,
    typicalDurationSeconds,
    sampleSize: sample.length,
    activeRunSeconds,
    lateStarts,
    maxLateStartSeconds,
    summary,
  };
}
