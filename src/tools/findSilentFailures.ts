import type { V1Job } from "@kubernetes/client-node";
import type { ClusterReader } from "../k8s/client.js";
import { assessCronJob, compareAssessments, type CronJobAssessment } from "../analysis/silent.js";
import { formatDays, RETAINED_JOBS_NOTE, scopeOf } from "./basis.js";

export interface SuspendedSummary {
  namespace: string;
  name: string;
  lastSuccess?: string;
}

export interface SilentFailuresResult {
  scope: string;
  asOf: string;
  /** What the answer is based on, in one sentence. */
  basis: string;
  windowDays: number;
  scannedCronJobs: number;
  counts: { silentFailures: number; degraded: number; atRisk: number; suspended: number; healthy: number };
  findings: CronJobAssessment[];
  /** Suspended CronJobs, one short entry each (full entries in findings when include_suspended=true). */
  suspended: SuspendedSummary[];
  truncated: boolean;
}

export async function findSilentFailures(
  reader: ClusterReader,
  input: { namespace?: string; days?: number; limit?: number; include_suspended?: boolean },
  now: Date = new Date(),
): Promise<SilentFailuresResult> {
  const days = input.days ?? 7;
  const limit = input.limit ?? 50;
  const includeSuspended = input.include_suspended ?? false;
  const [cronJobs, jobs] = await Promise.all([reader.listCronJobs(input.namespace), reader.listJobs(input.namespace)]);

  // Group Jobs by owning CronJob UID once, instead of rescanning per CronJob.
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

  const assessments = cronJobs.map((cronJob) =>
    assessCronJob({
      cronJob,
      jobs: jobsByOwner.get(cronJob.metadata?.uid ?? "") ?? [],
      now,
      windowSeconds: days * 86400,
    }),
  );

  const counts = { silentFailures: 0, degraded: 0, atRisk: 0, suspended: 0, healthy: 0 };
  for (const a of assessments) {
    if (a.status === "silent-failure") {
      counts.silentFailures++;
    } else if (a.status === "degraded") {
      counts.degraded++;
    } else if (a.status === "at-risk") {
      counts.atRisk++;
    } else if (a.status === "suspended") {
      counts.suspended++;
    } else {
      counts.healthy++;
    }
  }

  const attention = assessments
    .filter((a) => a.status !== "healthy" && (includeSuspended || a.status !== "suspended"))
    .sort(compareAssessments);
  const suspended = assessments
    .filter((a) => a.status === "suspended")
    .map((a) => ({ namespace: a.namespace, name: a.name, lastSuccess: a.lastSuccess }));

  return {
    scope: scopeOf(reader, input.namespace),
    asOf: now.toISOString(),
    basis: `No success in the last ${formatDays(days)} (widened to 2 schedule intervals for slow schedules), 3+ missed scheduled runs, or runs using >80% of the schedule interval; run data is ${RETAINED_JOBS_NOTE}`,
    windowDays: days,
    scannedCronJobs: cronJobs.length,
    counts,
    findings: attention.slice(0, limit),
    suspended: includeSuspended ? [] : suspended,
    truncated: attention.length > limit,
  };
}
