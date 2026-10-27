import { CronExpressionParser } from "cron-parser";
import type { V1CronJob, V1Job } from "@kubernetes/client-node";

export type ScheduleVerdict = "on-schedule" | "late" | "missed" | "currently running" | "suspended";

export type ScheduleSource = "annotation" | "status" | "none";

export interface ScheduleEvaluation {
  verdict: ScheduleVerdict;
  expectedLastRun?: string;
  lastScheduledTime?: string;
  lagSeconds?: number;
  source: ScheduleSource;
  reason: string;
}

/** Controller sync slack: a run due less than this long ago is not yet "late". */
export const GRACE_SECONDS = 60;
/** Lateness cutoff used when the CronJob sets no startingDeadlineSeconds. */
export const DEFAULT_LATE_SECONDS = 300;

const SCHEDULED_TIMESTAMP_KEY = "batch.kubernetes.io/cronjob-scheduled-timestamp";

/**
 * Kubernetes evaluates a schedule without spec.timeZone in the
 * kube-controller-manager's timezone, which is almost always UTC. Never fall
 * back to the timezone of the machine running this server.
 */
export function defaultTimeZone(): string {
  const configured = process.env.CRON_DEFAULT_TIMEZONE?.trim();
  if (configured) {
    return configured;
  }
  return "UTC";
}

/** The timezone a CronJob's schedule is actually evaluated in. */
export function effectiveTimeZone(timeZone: string | undefined): string {
  return timeZone ?? defaultTimeZone();
}

export function previousFireTime(schedule: string, timeZone: string | undefined, now: Date): Date {
  const expression = CronExpressionParser.parse(schedule, { currentDate: now, tz: effectiveTimeZone(timeZone) });
  return expression.prev().toDate();
}

export function nextFireTime(schedule: string, timeZone: string | undefined, now: Date): Date {
  const expression = CronExpressionParser.parse(schedule, { currentDate: now, tz: effectiveTimeZone(timeZone) });
  return expression.next().toDate();
}

/** Seconds between the two most recent fire times (the schedule's current cadence). */
export function fireIntervalSeconds(schedule: string, timeZone: string | undefined, now: Date): number {
  const expression = CronExpressionParser.parse(schedule, { currentDate: now, tz: effectiveTimeZone(timeZone) });
  const latest = expression.prev().toDate();
  const before = expression.prev().toDate();
  return Math.round((latest.getTime() - before.getTime()) / 1000);
}

/**
 * Shortest gap between consecutive upcoming fire times. For irregular
 * schedules ("0 9,17 * * *") this is the tightest window a run must fit in.
 */
export function shortestIntervalSeconds(
  schedule: string,
  timeZone: string | undefined,
  now: Date,
  samples = 6,
): number {
  const expression = CronExpressionParser.parse(schedule, { currentDate: now, tz: effectiveTimeZone(timeZone) });
  let previous = expression.next().toDate().getTime();
  let shortest = Number.POSITIVE_INFINITY;
  for (let i = 0; i < samples; i++) {
    const current = expression.next().toDate().getTime();
    shortest = Math.min(shortest, current - previous);
    previous = current;
  }
  return Math.round(shortest / 1000);
}

/** Number of fire times in (from, to], capped so a fast schedule cannot loop for long. */
export function countFiresBetween(
  schedule: string,
  timeZone: string | undefined,
  from: Date,
  to: Date,
  cap = 1000,
): number {
  if (to.getTime() <= from.getTime()) {
    return 0;
  }
  const expression = CronExpressionParser.parse(schedule, {
    currentDate: from,
    endDate: to,
    tz: effectiveTimeZone(timeZone),
  });
  let count = 0;
  while (count < cap && expression.hasNext()) {
    expression.next();
    count++;
  }
  return count;
}

export interface LastScheduled {
  time?: Date;
  source: ScheduleSource;
}

/**
 * The scheduled-timestamp annotation (K8s 1.32+) records the intended fire
 * time on each Job; older clusters only expose status.lastScheduleTime.
 */
export function lastScheduled(cronJob: V1CronJob, jobs: V1Job[]): LastScheduled {
  const stamps: number[] = [];
  for (const job of jobs) {
    const raw =
      job.metadata?.annotations?.[SCHEDULED_TIMESTAMP_KEY] ??
      job.metadata?.labels?.[SCHEDULED_TIMESTAMP_KEY];
    if (raw) {
      const t = new Date(raw).getTime();
      if (!Number.isNaN(t)) {
        stamps.push(t);
      }
    }
  }
  if (stamps.length > 0) {
    return { time: new Date(Math.max(...stamps)), source: "annotation" };
  }
  const fromStatus = cronJob.status?.lastScheduleTime;
  if (fromStatus) {
    return { time: new Date(fromStatus), source: "status" };
  }
  return { source: "none" };
}

function formatLag(seconds: number): string {
  if (seconds < 120) {
    return `${seconds}s`;
  }
  if (seconds < 7200) {
    return `${Math.round(seconds / 60)}m`;
  }
  return `${(seconds / 3600).toFixed(1)}h`;
}

export function evaluateSchedule(input: {
  cronJob: V1CronJob;
  jobs: V1Job[];
  now: Date;
}): ScheduleEvaluation {
  const { cronJob, jobs, now } = input;
  const spec = cronJob.spec;
  const last = lastScheduled(cronJob, jobs);
  const base = {
    source: last.source,
    lastScheduledTime: last.time?.toISOString(),
  };

  if (!spec) {
    return { ...base, verdict: "missed", reason: "CronJob has no spec" };
  }

  if (spec.suspend) {
    return { ...base, verdict: "suspended", reason: "CronJob is suspended (spec.suspend=true)" };
  }

  const activeCount = cronJob.status?.active?.length ?? 0;
  if (activeCount > 0) {
    return {
      ...base,
      verdict: "currently running",
      reason: `${activeCount} Job(s) currently active (concurrencyPolicy=${spec.concurrencyPolicy ?? "Allow"})`,
    };
  }

  const expected = previousFireTime(spec.schedule, spec.timeZone, now);
  const withExpected = { ...base, expectedLastRun: expected.toISOString() };

  const created = cronJob.metadata?.creationTimestamp;
  if (!last.time && created && new Date(created).getTime() > expected.getTime()) {
    return {
      ...withExpected,
      verdict: "on-schedule",
      reason: "CronJob was created after its most recent fire time; no run is due yet",
    };
  }

  if (last.time && last.time.getTime() >= expected.getTime() - 1000) {
    return {
      ...withExpected,
      verdict: "on-schedule",
      reason: "Most recent scheduled run matches the expected fire time",
    };
  }

  const lagSeconds = Math.round((now.getTime() - expected.getTime()) / 1000);
  if (lagSeconds <= GRACE_SECONDS) {
    return {
      ...withExpected,
      lagSeconds,
      verdict: "on-schedule",
      reason: `Run was due ${lagSeconds}s ago, within the ${GRACE_SECONDS}s controller grace period`,
    };
  }

  let cutoff = DEFAULT_LATE_SECONDS;
  let cutoffSource = "default";
  if (spec.startingDeadlineSeconds !== undefined) {
    cutoff = spec.startingDeadlineSeconds;
    cutoffSource = "startingDeadlineSeconds";
  }
  let lastDescription = "it has never been scheduled";
  if (last.time) {
    lastDescription = `last scheduled ${last.time.toISOString()}`;
  }

  if (lagSeconds <= cutoff) {
    return {
      ...withExpected,
      lagSeconds,
      verdict: "late",
      reason: `Run due ${formatLag(lagSeconds)} ago has not started (${lastDescription}); within ${cutoffSource} of ${cutoff}s`,
    };
  }
  return {
    ...withExpected,
    lagSeconds,
    verdict: "missed",
    reason: `Run due ${formatLag(lagSeconds)} ago was not started (${lastDescription}); beyond ${cutoffSource} of ${cutoff}s`,
  };
}
