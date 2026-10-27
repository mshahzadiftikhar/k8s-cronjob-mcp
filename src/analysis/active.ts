import type { V1Job } from "@kubernetes/client-node";
import { jobOutcome } from "./jobs.js";

/**
 * running:    pods are active
 * pending:    not started yet (no startTime), e.g. waiting for its first pod
 * suspended:  spec.suspend=true, the Job exists but runs no pods
 * finishing:  outcome decided (SuccessCriteriaMet / FailureTarget) but pods are still terminating
 */
export type ActiveState = "running" | "pending" | "suspended" | "finishing";

export interface ActiveRun {
  namespace: string;
  job: string;
  state: ActiveState;
  owner?: { kind: string; name: string };
  startTime?: string;
  runningSeconds?: number;
  activePods: number;
  readyPods?: number;
  failedPods: number;
  activeDeadlineSeconds?: number;
  secondsUntilDeadline?: number;
  typicalDurationSeconds?: number;
  longRunning: boolean;
  notes: string[];
}

/** Successful runs of the same CronJob needed before a "typical" duration is reported. */
export const MIN_TYPICAL_SAMPLES = 3;
/** A run taking longer than this multiple of its typical duration is flagged. */
export const LONG_RUNNING_FACTOR = 2;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid] ?? 0;
  }
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function ownerOf(job: V1Job): { kind: string; name: string; uid?: string } | undefined {
  const refs = job.metadata?.ownerReferences ?? [];
  const ref = refs.find((o) => o.controller) ?? refs[0];
  if (!ref) {
    return undefined;
  }
  return { kind: ref.kind, name: ref.name, uid: ref.uid };
}

function hasCondition(job: V1Job, type: string): boolean {
  return (job.status?.conditions ?? []).some((c) => c.type === type && c.status === "True");
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

/** Typical successful duration per owner UID, from the finished Jobs in the same list. */
function typicalDurations(jobs: V1Job[]): Map<string, number> {
  const byOwner = new Map<string, number[]>();
  for (const job of jobs) {
    const owner = ownerOf(job);
    const outcome = jobOutcome(job);
    if (owner?.uid && outcome.status === "Succeeded" && outcome.durationSeconds !== undefined) {
      const list = byOwner.get(owner.uid) ?? [];
      list.push(outcome.durationSeconds);
      byOwner.set(owner.uid, list);
    }
  }
  const typical = new Map<string, number>();
  for (const [uid, durations] of byOwner) {
    if (durations.length >= MIN_TYPICAL_SAMPLES) {
      typical.set(uid, Math.round(median(durations)));
    }
  }
  return typical;
}

/** Jobs that have not finished, longest-running first. */
export function summarizeActiveRuns(jobs: V1Job[], now: Date): ActiveRun[] {
  const typical = typicalDurations(jobs);
  const runs: ActiveRun[] = [];

  for (const job of jobs) {
    const outcome = jobOutcome(job);
    if (outcome.status !== "Running") {
      continue;
    }
    const notes: string[] = [];
    const owner = ownerOf(job);
    const rawStart = job.status?.startTime;

    let state: ActiveState = "running";
    if (job.spec?.suspend) {
      state = "suspended";
    } else if (hasCondition(job, "SuccessCriteriaMet") || hasCondition(job, "FailureTarget")) {
      state = "finishing";
    } else if (!rawStart) {
      state = "pending";
    }

    let startTime: string | undefined = undefined;
    let runningSeconds: number | undefined = undefined;
    if (rawStart) {
      const startMs = new Date(rawStart).getTime();
      startTime = new Date(startMs).toISOString();
      runningSeconds = Math.max(0, Math.round((now.getTime() - startMs) / 1000));
    }

    const activeDeadlineSeconds = job.spec?.activeDeadlineSeconds;
    let secondsUntilDeadline: number | undefined = undefined;
    if (activeDeadlineSeconds !== undefined && runningSeconds !== undefined) {
      secondsUntilDeadline = activeDeadlineSeconds - runningSeconds;
    }

    let typicalDurationSeconds: number | undefined = undefined;
    if (owner?.uid) {
      typicalDurationSeconds = typical.get(owner.uid);
    }
    let longRunning = false;
    if (
      state === "running" &&
      typicalDurationSeconds !== undefined &&
      typicalDurationSeconds > 0 &&
      runningSeconds !== undefined &&
      runningSeconds > typicalDurationSeconds * LONG_RUNNING_FACTOR
    ) {
      longRunning = true;
      notes.push(
        `Running for ${formatSeconds(runningSeconds)}, more than ${LONG_RUNNING_FACTOR}x its typical ${formatSeconds(typicalDurationSeconds)}`,
      );
    }

    const failedPods = job.status?.failed ?? 0;
    if (failedPods > 0) {
      const limit = job.spec?.backoffLimit ?? 6;
      notes.push(`${failedPods} pod(s) already failed; retrying (backoffLimit=${limit})`);
    }
    if (secondsUntilDeadline !== undefined && secondsUntilDeadline <= 0) {
      notes.push("Past its activeDeadlineSeconds; Kubernetes should terminate it shortly");
    }

    let publicOwner: ActiveRun["owner"] = undefined;
    if (owner) {
      publicOwner = { kind: owner.kind, name: owner.name };
    }

    runs.push({
      namespace: job.metadata?.namespace ?? "",
      job: job.metadata?.name ?? "",
      state,
      owner: publicOwner,
      startTime,
      runningSeconds,
      activePods: job.status?.active ?? 0,
      readyPods: job.status?.ready,
      failedPods,
      activeDeadlineSeconds,
      secondsUntilDeadline,
      typicalDurationSeconds,
      longRunning,
      notes,
    });
  }

  return runs.sort((a, b) => {
    const byFlag = Number(b.longRunning) - Number(a.longRunning);
    if (byFlag !== 0) {
      return byFlag;
    }
    const aSec = a.runningSeconds ?? -1;
    const bSec = b.runningSeconds ?? -1;
    if (aSec !== bSec) {
      return bSec - aSec;
    }
    return `${a.namespace}/${a.job}`.localeCompare(`${b.namespace}/${b.job}`);
  });
}
