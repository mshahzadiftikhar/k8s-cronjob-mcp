import type { CoreV1Event, V1Pod } from "@kubernetes/client-node";
import type { ClusterReader } from "../k8s/client.js";
import { jobOutcome } from "../analysis/jobs.js";
import { synthesizeCause, type FailureCause } from "../analysis/failureCause.js";
import { redactSecrets } from "../analysis/redact.js";

const MAX_PODS = 3;
const MAX_EVENTS = 20;
const LOG_LIMIT_BYTES = 16 * 1024;

export interface ContainerReport {
  name: string;
  exitCode?: number;
  reason?: string;
  message?: string;
  restartCount: number;
  waitingReason?: string;
}

export interface LogReport {
  container: string;
  previous: boolean;
  text?: string;
  unavailableReason?: string;
}

export interface PodReport {
  name: string;
  phase?: string;
  containers: ContainerReport[];
  logs?: LogReport;
}

export interface EventReport {
  object: string;
  type?: string;
  reason?: string;
  message?: string;
  count?: number;
  time?: string;
}

export interface FailureDetailsResult {
  asOf: string;
  /** What evidence was looked at, in one sentence. */
  basis: string;
  namespace: string;
  job: string;
  jobStatus: string;
  cause: FailureCause;
  pods: PodReport[];
  events: EventReport[];
  notes: string[];
}

function eventTime(e: CoreV1Event): number {
  const raw = e.lastTimestamp ?? e.eventTime ?? e.metadata?.creationTimestamp;
  if (!raw) {
    return 0;
  }
  return new Date(raw).getTime();
}

function newestFirst(pods: V1Pod[]): V1Pod[] {
  return [...pods].sort(
    (a, b) =>
      new Date(b.metadata?.creationTimestamp ?? 0).getTime() -
      new Date(a.metadata?.creationTimestamp ?? 0).getTime(),
  );
}

function containerReports(pod: V1Pod): ContainerReport[] {
  return (pod.status?.containerStatuses ?? []).map((s) => {
    const t = s.state?.terminated ?? s.lastState?.terminated;
    return {
      name: s.name,
      exitCode: t?.exitCode,
      reason: t?.reason,
      message: t?.message,
      restartCount: s.restartCount,
      waitingReason: s.state?.waiting?.reason,
    };
  });
}

/** Pick the container worth reading logs for: the failing one, else the first. */
function logTarget(pod: V1Pod): { container: string; previous: boolean } | undefined {
  const statuses = pod.status?.containerStatuses ?? [];
  const failing = statuses.find((s) => {
    const t = s.state?.terminated;
    return t !== undefined && t.exitCode !== 0;
  });
  const crashLooping = statuses.find((s) => s.state?.waiting && s.restartCount > 0);
  if (failing) {
    return { container: failing.name, previous: false };
  }
  // A restarting container has no current logs; read the last terminated instance.
  if (crashLooping) {
    return { container: crashLooping.name, previous: true };
  }
  const first = statuses[0];
  if (first) {
    return { container: first.name, previous: false };
  }
  return undefined;
}

async function readLogs(
  reader: ClusterReader,
  namespace: string,
  pod: V1Pod,
  tailLines: number,
): Promise<LogReport | undefined> {
  const target = logTarget(pod);
  const podName = pod.metadata?.name ?? "";
  if (!target) {
    return undefined;
  }
  try {
    const raw = await reader.readPodLog(namespace, podName, {
      container: target.container,
      previous: target.previous,
      tailLines,
      limitBytes: LOG_LIMIT_BYTES,
    });
    const text = redactSecrets(raw).trimEnd();
    if (text.length === 0) {
      return { ...target, unavailableReason: "container wrote no output" };
    }
    return { ...target, text };
  } catch (err) {
    let reason = "log retrieval failed";
    if (err instanceof Error) {
      reason = `log retrieval failed: ${err.message}`;
    }
    return { ...target, unavailableReason: reason };
  }
}

export async function getFailureDetails(
  reader: ClusterReader,
  input: { namespace: string; job_name: string; tail_lines?: number },
): Promise<FailureDetailsResult> {
  const { namespace } = input;
  const tailLines = input.tail_lines ?? 40;
  const job = await reader.getJob(namespace, input.job_name);
  const pods = newestFirst(await reader.listPods(namespace, `job-name=${input.job_name}`));
  const outcome = jobOutcome(job);
  const notes: string[] = [];

  const inspected = pods.slice(0, MAX_PODS);
  if (pods.length > MAX_PODS) {
    notes.push(`Job has ${pods.length} pods; inspecting the ${MAX_PODS} most recent`);
  }

  const objectNames = [input.job_name, ...inspected.map((p) => p.metadata?.name ?? "")];
  const eventLists = await Promise.all(
    objectNames.map((name) => reader.listEvents(namespace, `involvedObject.name=${name}`)),
  );
  const allEvents = eventLists.flat().sort((a, b) => eventTime(b) - eventTime(a));
  if (allEvents.length === 0) {
    notes.push("No Events found; Kubernetes expires Events after about an hour by default");
  }

  const podReports: PodReport[] = [];
  for (const pod of inspected) {
    const logs = await readLogs(reader, namespace, pod, tailLines);
    podReports.push({
      name: pod.metadata?.name ?? "",
      phase: pod.status?.phase,
      containers: containerReports(pod),
      logs,
    });
  }
  if (pods.length === 0) {
    notes.push("No pods remain for this Job (deleted or garbage-collected), so logs are unavailable");
  }

  // Warnings are usually the most informative, so list them before Normal events.
  const ranked = [...allEvents].sort((a, b) => {
    const aw = Number(a.type === "Warning");
    const bw = Number(b.type === "Warning");
    if (aw !== bw) {
      return bw - aw;
    }
    return eventTime(b) - eventTime(a);
  });
  const events: EventReport[] = ranked.slice(0, MAX_EVENTS).map((e) => ({
    object: `${e.involvedObject.kind ?? ""}/${e.involvedObject.name ?? ""}`,
    type: e.type,
    reason: e.reason,
    message: e.message,
    count: e.count,
    time: new Date(eventTime(e)).toISOString(),
  }));

  return {
    asOf: new Date().toISOString(),
    basis: `Pod state and the last ${tailLines} log lines of up to ${MAX_PODS} most recent pod(s) (${pods.length} found), plus Events still kept by Kubernetes (usually about the last hour)`,
    namespace,
    job: input.job_name,
    jobStatus: outcome.status,
    cause: synthesizeCause({ job, pods, events: allEvents }),
    pods: podReports,
    events,
    notes,
  };
}
