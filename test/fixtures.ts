import type { CoreV1Event, V1CronJob, V1Job, V1Pod } from "@kubernetes/client-node";
import type { ClusterReader } from "../src/k8s/client.js";

export const NOW = new Date("2026-10-05T12:30:30Z");

export function cronJob(overrides: Partial<NonNullable<V1CronJob["spec"]>> = {}, extra: Partial<V1CronJob> = {}): V1CronJob {
  return {
    metadata: { name: "nightly", namespace: "ops", uid: "cj-uid", creationTimestamp: new Date("2026-09-01T00:00:00Z") },
    spec: {
      schedule: "*/30 * * * *",
      jobTemplate: { spec: { template: { spec: { containers: [], restartPolicy: "Never" } } } },
      ...overrides,
    },
    status: {},
    ...extra,
  };
}

export function job(
  name: string,
  opts: {
    start: string;
    end?: string;
    result?: "Complete" | "Failed" | "DeadlineExceeded";
    scheduled?: string;
  },
): V1Job {
  const conditions = [];
  if (opts.result === "Complete") {
    conditions.push({ type: "Complete", status: "True", lastTransitionTime: opts.end ? new Date(opts.end) : undefined });
  } else if (opts.result === "Failed") {
    conditions.push({ type: "Failed", status: "True", reason: "BackoffLimitExceeded", lastTransitionTime: opts.end ? new Date(opts.end) : undefined });
  } else if (opts.result === "DeadlineExceeded") {
    conditions.push({ type: "Failed", status: "True", reason: "DeadlineExceeded", lastTransitionTime: opts.end ? new Date(opts.end) : undefined });
  }
  const annotations: Record<string, string> = {};
  if (opts.scheduled) {
    annotations["batch.kubernetes.io/cronjob-scheduled-timestamp"] = opts.scheduled;
  }
  return {
    metadata: {
      name,
      namespace: "ops",
      annotations,
      ownerReferences: [{ apiVersion: "batch/v1", kind: "CronJob", name: "nightly", uid: "cj-uid" }],
    },
    spec: { template: { spec: { containers: [], restartPolicy: "Never" } } },
    status: {
      startTime: new Date(opts.start),
      completionTime: opts.result === "Complete" && opts.end ? new Date(opts.end) : undefined,
      conditions,
    },
  };
}

export function pod(jobName: string, exitCode: number, reason?: string): V1Pod {
  return {
    metadata: { name: `${jobName}-abcde`, labels: { "job-name": jobName }, creationTimestamp: new Date("2026-10-05T12:00:00Z") },
    status: {
      containerStatuses: [
        { name: "main", image: "x", imageID: "x", ready: false, restartCount: 0, state: { terminated: { exitCode, reason } } },
      ],
    },
  };
}

export function fakeReader(data: {
  cronJobs?: V1CronJob[];
  jobs?: V1Job[];
  pods?: V1Pod[];
  events?: CoreV1Event[];
  logs?: Record<string, string | Error>;
}): ClusterReader {
  return {
    listCronJobs: async () => data.cronJobs ?? [],
    getCronJob: async () => {
      const first = data.cronJobs?.[0];
      if (!first) {
        throw new Error("no cronjob");
      }
      return first;
    },
    listJobs: async () => data.jobs ?? [],
    listPods: async () => data.pods ?? [],
    getJob: async (_ns, name) => {
      const found = data.jobs?.find((j) => j.metadata?.name === name);
      if (!found) {
        throw new Error("no job");
      }
      return found;
    },
    listEvents: async (_ns, fieldSelector) => {
      const target = fieldSelector?.replace("involvedObject.name=", "");
      return (data.events ?? []).filter((e) => e.involvedObject.name === target);
    },
    readPodLog: async (_ns, pod) => {
      const entry = data.logs?.[pod];
      if (entry === undefined) {
        throw new Error("pod not found");
      }
      if (entry instanceof Error) {
        throw entry;
      }
      return entry;
    },
  };
}
