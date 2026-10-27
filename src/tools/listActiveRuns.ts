import type { ClusterReader } from "../k8s/client.js";
import { RETAINED_JOBS_NOTE, scopeOf } from "./basis.js";
import { summarizeActiveRuns, type ActiveRun } from "../analysis/active.js";

export interface ActiveRunsResult {
  scope: string;
  asOf: string;
  /** What the answer is based on, in one sentence. */
  basis: string;
  scannedJobs: number;
  counts: { running: number; pending: number; suspended: number; finishing: number; longRunning: number };
  runs: ActiveRun[];
  truncated: boolean;
}

export async function listActiveRuns(
  reader: ClusterReader,
  input: { namespace?: string; limit?: number },
  now: Date = new Date(),
): Promise<ActiveRunsResult> {
  const limit = input.limit ?? 50;
  const jobs = await reader.listJobs(input.namespace);
  const runs = summarizeActiveRuns(jobs, now);

  const counts = { running: 0, pending: 0, suspended: 0, finishing: 0, longRunning: 0 };
  for (const run of runs) {
    counts[run.state]++;
    if (run.longRunning) {
      counts.longRunning++;
    }
  }

  return {
    scope: scopeOf(reader, input.namespace),
    asOf: now.toISOString(),
    basis: `Jobs not finished as of now; "typical" duration is the median of the same CronJob's last successful runs (needs 3), from ${RETAINED_JOBS_NOTE}`,
    scannedJobs: jobs.length,
    counts,
    runs: runs.slice(0, limit),
    truncated: runs.length > limit,
  };
}
