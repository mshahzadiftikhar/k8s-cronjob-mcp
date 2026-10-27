import type { CoreV1Event, V1ContainerStatus, V1Job, V1Pod } from "@kubernetes/client-node";
import { jobOutcome } from "./jobs.js";

export type FailureCategory =
  | "not-failed"
  | "oom-killed"
  | "deadline-exceeded"
  | "image-pull"
  | "config-error"
  | "evicted"
  | "unschedulable"
  | "exit-code"
  | "unknown";

export interface FailureCause {
  category: FailureCategory;
  summary: string;
}

const EXIT_CODE_HINTS: Record<number, string> = {
  1: "general error",
  2: "misuse of shell builtin or invalid usage",
  126: "command found but not executable",
  127: "command not found",
  130: "terminated by SIGINT",
  137: "killed by SIGKILL",
  139: "segmentation fault (SIGSEGV)",
  143: "terminated by SIGTERM",
};

interface ContainerFacts {
  pod: V1Pod;
  status: V1ContainerStatus;
}

function containersOf(pods: V1Pod[]): ContainerFacts[] {
  const all: ContainerFacts[] = [];
  for (const pod of pods) {
    for (const status of pod.status?.containerStatuses ?? []) {
      all.push({ pod, status });
    }
    for (const status of pod.status?.initContainerStatuses ?? []) {
      all.push({ pod, status });
    }
  }
  return all;
}

function memoryLimit(pod: V1Pod, containerName: string): string | undefined {
  const spec = pod.spec?.containers?.find((c) => c.name === containerName);
  return spec?.resources?.limits?.["memory"];
}

function describeExit(exitCode: number): string {
  const hint = EXIT_CODE_HINTS[exitCode];
  if (hint) {
    return `exit code ${exitCode} (${hint})`;
  }
  return `exit code ${exitCode}`;
}

export function synthesizeCause(input: {
  job: V1Job;
  pods: V1Pod[];
  events: CoreV1Event[];
}): FailureCause {
  const { job, pods, events } = input;
  const outcome = jobOutcome(job);

  if (outcome.status === "Succeeded" || outcome.status === "Running") {
    return { category: "not-failed", summary: `Job has not failed (status: ${outcome.status})` };
  }

  const containers = containersOf(pods);

  for (const { pod, status } of containers) {
    const terminated = [status.state?.terminated, status.lastState?.terminated];
    if (terminated.some((t) => t?.reason === "OOMKilled")) {
      const limit = memoryLimit(pod, status.name);
      let at = "";
      if (limit) {
        at = ` at ${limit}`;
      }
      return {
        category: "oom-killed",
        summary: `Container "${status.name}" OOMKilled${at}, exit code 137`,
      };
    }
  }

  if (outcome.status === "DeadlineExceeded") {
    const deadline = job.spec?.activeDeadlineSeconds;
    let detail = "";
    if (deadline !== undefined) {
      detail = ` (activeDeadlineSeconds=${deadline})`;
    }
    return {
      category: "deadline-exceeded",
      summary: `Job exceeded its active deadline${detail} and was terminated`,
    };
  }

  const imageWaiting = containers.find(({ status }) => {
    const reason = status.state?.waiting?.reason;
    return reason === "ImagePullBackOff" || reason === "ErrImagePull" || reason === "InvalidImageName";
  });
  if (imageWaiting) {
    const w = imageWaiting.status.state?.waiting;
    return {
      category: "image-pull",
      summary: `Container "${imageWaiting.status.name}" could not pull image "${imageWaiting.status.image}": ${w?.reason}${detailSuffix(w?.message)}`,
    };
  }

  const configWaiting = containers.find(({ status }) => {
    const reason = status.state?.waiting?.reason;
    return reason === "CreateContainerConfigError" || reason === "CreateContainerError";
  });
  if (configWaiting) {
    const w = configWaiting.status.state?.waiting;
    return {
      category: "config-error",
      summary: `Container "${configWaiting.status.name}" failed to start: ${w?.reason}${detailSuffix(w?.message)}`,
    };
  }

  const evicted = pods.find((p) => p.status?.reason === "Evicted");
  if (evicted) {
    return {
      category: "evicted",
      summary: `Pod "${evicted.metadata?.name}" was evicted${detailSuffix(evicted.status?.message)}`,
    };
  }

  const failedExit = containers.find(
    ({ status }) => status.state?.terminated && status.state.terminated.exitCode !== 0,
  );
  if (failedExit) {
    const t = failedExit.status.state?.terminated;
    const code = t?.exitCode ?? 1;
    return {
      category: "exit-code",
      summary: `Container "${failedExit.status.name}" exited with ${describeExit(code)}${detailSuffix(t?.message)}`,
    };
  }

  const neverStarted = containers.every(({ status }) => !status.state?.terminated);
  if (neverStarted) {
    const scheduling = events.find((e) => e.reason === "FailedScheduling");
    if (scheduling) {
      return {
        category: "unschedulable",
        summary: `Pod could not be scheduled${detailSuffix(scheduling.message)}`,
      };
    }
  }

  const warning = events.find((e) => e.type === "Warning");
  if (warning) {
    return {
      category: "unknown",
      summary: `Job failed (${outcome.reason ?? "unknown reason"}); most relevant warning: ${warning.reason}${detailSuffix(warning.message)}`,
    };
  }
  if (pods.length === 0) {
    return { category: "unknown", summary: describeMissingEvidence(job, outcome.reason) };
  }
  return { category: "unknown", summary: `Job failed (${outcome.reason ?? "unknown reason"}) with no further evidence` };
}

/** What the Job object itself still says once its pods are gone, and why they are gone. */
function describeMissingEvidence(job: V1Job, reason: string | undefined): string {
  const failedCondition = (job.status?.conditions ?? []).find((c) => c.type === "Failed" && c.status === "True");
  let what = reason ?? "unknown reason";
  if (failedCondition?.message) {
    what += `: ${failedCondition.message}`;
  }
  const failedPods = job.status?.failed;
  let attempts = "";
  if (failedPods !== undefined && failedPods > 0) {
    attempts = ` after ${failedPods} failed pod(s)`;
  }
  let why = "";
  const ttl = job.spec?.ttlSecondsAfterFinished;
  if (ttl !== undefined) {
    why = ` (ttlSecondsAfterFinished=${ttl} deletes them after the Job finishes)`;
  }
  return `Job failed (${what})${attempts}; its pods no longer exist${why}, so there is no container evidence. Ship container logs to a log store to keep failure evidence longer`;
}

function detailSuffix(message: string | undefined): string {
  if (!message) {
    return "";
  }
  let trimmed = message;
  if (message.length > 200) {
    trimmed = `${message.slice(0, 200)}…`;
  }
  return ` - ${trimmed}`;
}
