import type { CoreV1Event, V1CronJob, V1Job, V1Pod } from "@kubernetes/client-node";
import type { ClusterReader } from "../k8s/client.js";
import { jobOutcome } from "../analysis/jobs.js";
import { formatHours, RETAINED_JOBS_NOTE, scopeOf } from "./basis.js";
import { synthesizeCause, type FailureCause, type FailureCategory } from "../analysis/failureCause.js";

export interface RecentFailure {
  namespace: string;
  job: string;
  owner?: { kind: string; name: string };
  failedAt?: string;
  durationSeconds?: number;
  status: string;
  cause: FailureCause;
  /** A later run of the same CronJob succeeded. Undefined for Jobs without a CronJob owner. */
  recovered?: boolean;
}

export interface RecentFailuresResult {
  scope: string;
  asOf: string;
  /** Start of the window: failures that finished at or after this time. */
  since: string;
  /** What the answer is based on, in one sentence. */
  basis: string;
  windowHours: number;
  counts: { total: number; unrecovered: number; byCategory: Partial<Record<FailureCategory, number>> };
  failures: RecentFailure[];
  truncated: boolean;
  notes: string[];
}

function ownerOf(job: V1Job): { kind: string; name: string; uid: string } | undefined {
  const refs = job.metadata?.ownerReferences ?? [];
  const ref = refs.find((o) => o.controller) ?? refs[0];
  if (!ref) {
    return undefined;
  }
  return { kind: ref.kind, name: ref.name, uid: ref.uid };
}

/** Latest success time per CronJob UID, from retained Jobs and status.lastSuccessfulTime. */
function lastSuccessByOwner(cronJobs: V1CronJob[], jobs: V1Job[]): Map<string, number> {
  const latest = new Map<string, number>();
  const bump = (uid: string, t: number) => {
    if (t > (latest.get(uid) ?? 0)) {
      latest.set(uid, t);
    }
  };
  for (const cj of cronJobs) {
    const uid = cj.metadata?.uid;
    const t = cj.status?.lastSuccessfulTime;
    if (uid && t) {
      bump(uid, new Date(t).getTime());
    }
  }
  for (const job of jobs) {
    const owner = ownerOf(job);
    const outcome = jobOutcome(job);
    if (owner && outcome.status === "Succeeded" && outcome.endTime) {
      bump(owner.uid, outcome.endTime.getTime());
    }
  }
  return latest;
}

export async function listRecentFailures(
  reader: ClusterReader,
  input: { namespace?: string; hours?: number; limit?: number },
  now: Date = new Date(),
): Promise<RecentFailuresResult> {
  const hours = input.hours ?? 24;
  const limit = input.limit ?? 50;
  const since = now.getTime() - hours * 3600_000;
  const [cronJobs, jobs] = await Promise.all([reader.listCronJobs(input.namespace), reader.listJobs(input.namespace)]);

  const failed = jobs
    .map((job) => ({ job, outcome: jobOutcome(job) }))
    .filter(({ outcome }) => outcome.status === "Failed" || outcome.status === "DeadlineExceeded")
    .map((f) => ({ ...f, at: (f.outcome.endTime ?? f.outcome.startTime)?.getTime() ?? 0 }))
    .filter((f) => f.at >= since)
    .sort((a, b) => b.at - a.at);

  const successes = lastSuccessByOwner(cronJobs, jobs);
  const inspected = failed.slice(0, limit);

  const failures = await Promise.all(
    inspected.map(async ({ job, outcome, at }): Promise<RecentFailure> => {
      const namespace = job.metadata?.namespace ?? input.namespace ?? "";
      const name = job.metadata?.name ?? "";
      let pods: V1Pod[] = [];
      let events: CoreV1Event[] = [];
      try {
        [pods, events] = await Promise.all([
          reader.listPods(namespace, `job-name=${name}`),
          reader.listEvents(namespace, `involvedObject.name=${name}`),
        ]);
      } catch {
        // Evidence is best effort; the Job object alone still gives a cause.
      }
      const owner = ownerOf(job);
      let recovered: boolean | undefined = undefined;
      if (owner?.kind === "CronJob") {
        recovered = (successes.get(owner.uid) ?? 0) > at;
      }
      let publicOwner: RecentFailure["owner"] = undefined;
      if (owner) {
        publicOwner = { kind: owner.kind, name: owner.name };
      }
      return {
        namespace,
        job: name,
        owner: publicOwner,
        failedAt: outcome.endTime?.toISOString(),
        durationSeconds: outcome.durationSeconds,
        status: outcome.status,
        cause: synthesizeCause({ job, pods, events }),
        recovered,
      };
    }),
  );

  const byCategory: Partial<Record<FailureCategory, number>> = {};
  let unrecovered = 0;
  for (const f of failures) {
    byCategory[f.cause.category] = (byCategory[f.cause.category] ?? 0) + 1;
    if (f.recovered !== true) {
      unrecovered++;
    }
  }

  const notes: string[] = [];
  const blind = cronJobs.filter((cj) => cj.spec?.failedJobsHistoryLimit === 0).map((cj) => cj.metadata?.name ?? "");
  if (blind.length > 0) {
    notes.push(`These CronJobs keep no failed Jobs (failedJobsHistoryLimit=0), so their failures are invisible: ${blind.join(", ")}`);
  }
  notes.push("Only failed Jobs still retained by Kubernetes are listed; older ones are removed by history limits or ttlSecondsAfterFinished");

  return {
    scope: scopeOf(reader, input.namespace),
    asOf: now.toISOString(),
    since: new Date(since).toISOString(),
    basis: `Failed Jobs that finished in the last ${formatHours(hours)}, from ${RETAINED_JOBS_NOTE}; "recovered" means a later run of the same CronJob succeeded`,
    windowHours: hours,
    counts: { total: failed.length, unrecovered, byCategory },
    failures,
    truncated: failed.length > limit,
    notes,
  };
}
