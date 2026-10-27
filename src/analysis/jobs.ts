import type { V1CronJob, V1Job, V1Pod } from "@kubernetes/client-node";

export type JobStatus = "Succeeded" | "Failed" | "DeadlineExceeded" | "Running";

export interface JobOutcome {
  status: JobStatus;
  startTime?: Date;
  endTime?: Date;
  durationSeconds?: number;
  reason?: string;
}

export function isOwnedBy(job: V1Job, cronJob: V1CronJob): boolean {
  const owners = job.metadata?.ownerReferences ?? [];
  return owners.some((o) => o.kind === "CronJob" && o.uid === cronJob.metadata?.uid);
}

function toDate(value: Date | string | undefined): Date | undefined {
  if (value === undefined) {
    return undefined;
  }
  return new Date(value);
}

export function jobOutcome(job: V1Job): JobOutcome {
  const conditions = job.status?.conditions ?? [];
  const complete = conditions.find((c) => c.type === "Complete" && c.status === "True");
  const failed = conditions.find((c) => c.type === "Failed" && c.status === "True");
  const startTime = toDate(job.status?.startTime) ?? toDate(job.metadata?.creationTimestamp);

  let status: JobStatus = "Running";
  let endTime: Date | undefined = undefined;
  let reason: string | undefined = undefined;

  if (complete) {
    status = "Succeeded";
    endTime = toDate(job.status?.completionTime) ?? toDate(complete.lastTransitionTime);
  } else if (failed) {
    reason = failed.reason;
    if (failed.reason === "DeadlineExceeded") {
      status = "DeadlineExceeded";
    } else {
      status = "Failed";
    }
    endTime = toDate(failed.lastTransitionTime);
  }

  let durationSeconds: number | undefined = undefined;
  if (startTime && endTime) {
    durationSeconds = Math.max(0, Math.round((endTime.getTime() - startTime.getTime()) / 1000));
  }
  return { status, startTime, endTime, durationSeconds, reason };
}

export interface PodExitInfo {
  exitCode?: number;
  reason?: string;
}

/** Exit info for the most relevant terminated container across a Job's pods. */
export function podExitInfo(pods: V1Pod[]): PodExitInfo {
  const newestFirst = [...pods].sort((a, b) => {
    const at = toDate(a.metadata?.creationTimestamp)?.getTime() ?? 0;
    const bt = toDate(b.metadata?.creationTimestamp)?.getTime() ?? 0;
    return bt - at;
  });
  for (const pod of newestFirst) {
    const statuses = pod.status?.containerStatuses ?? [];
    const terminated = statuses
      .map((s) => s.state?.terminated ?? s.lastState?.terminated)
      .filter((t) => t !== undefined);
    const failing = terminated.find((t) => t.exitCode !== 0);
    const picked = failing ?? terminated[0];
    if (picked) {
      return { exitCode: picked.exitCode, reason: picked.reason };
    }
  }
  return {};
}

export function jobPodsByJobName(pods: V1Pod[]): Map<string, V1Pod[]> {
  const byJob = new Map<string, V1Pod[]>();
  for (const pod of pods) {
    const jobName = pod.metadata?.labels?.["job-name"];
    if (jobName) {
      const list = byJob.get(jobName) ?? [];
      list.push(pod);
      byJob.set(jobName, list);
    }
  }
  return byJob;
}
