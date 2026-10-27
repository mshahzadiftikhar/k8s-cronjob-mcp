import type { ClusterReader } from "../k8s/client.js";
import { isOwnedBy, jobOutcome, jobPodsByJobName, podExitInfo } from "../analysis/jobs.js";
import { durationTrend, MIN_TREND_SAMPLES, type DurationTrend } from "../analysis/trend.js";

export interface RunRecord {
  job: string;
  status: string;
  startTime?: string;
  durationSeconds?: number;
  exitCode?: number;
  reason?: string;
}

export interface RunHistoryResult {
  namespace: string;
  name: string;
  asOf: string;
  /** What the history covers, in one sentence. */
  basis: string;
  historyLimits: { successful: number; failed: number };
  retainedJobs: number;
  runs: RunRecord[];
  trend?: DurationTrend;
  warnings: string[];
}

// Kubernetes defaults when the CronJob leaves these unset.
const DEFAULT_SUCCESSFUL_LIMIT = 3;
const DEFAULT_FAILED_LIMIT = 1;

export async function getRunHistory(
  reader: ClusterReader,
  input: { namespace: string; name: string; limit?: number },
): Promise<RunHistoryResult> {
  const limit = input.limit ?? 10;
  const cronJob = await reader.getCronJob(input.namespace, input.name);
  const [allJobs, pods] = await Promise.all([
    reader.listJobs(input.namespace),
    reader.listPods(input.namespace, "job-name"),
  ]);
  const podsByJob = jobPodsByJobName(pods);

  const runs = allJobs
    .filter((job) => isOwnedBy(job, cronJob))
    .map((job) => {
      const name = job.metadata?.name ?? "";
      const outcome = jobOutcome(job);
      const exit = podExitInfo(podsByJob.get(name) ?? []);
      return { name, outcome, exit };
    })
    .sort((a, b) => (a.outcome.startTime?.getTime() ?? 0) - (b.outcome.startTime?.getTime() ?? 0));

  const successfulLimit = cronJob.spec?.successfulJobsHistoryLimit ?? DEFAULT_SUCCESSFUL_LIMIT;
  const failedLimit = cronJob.spec?.failedJobsHistoryLimit ?? DEFAULT_FAILED_LIMIT;

  const successDurations: number[] = [];
  for (const run of runs) {
    if (run.outcome.status === "Succeeded" && run.outcome.durationSeconds !== undefined) {
      successDurations.push(run.outcome.durationSeconds);
    }
  }
  const trend = durationTrend(successDurations);

  const warnings: string[] = [];
  if (successfulLimit === 0 || failedLimit === 0) {
    warnings.push(
      `History limit of 0 (successful=${successfulLimit}, failed=${failedLimit}): finished Jobs of that kind are deleted immediately, so their evidence is gone`,
    );
  }
  if (successfulLimit < MIN_TREND_SAMPLES) {
    warnings.push(
      `successfulJobsHistoryLimit=${successfulLimit} retains too few runs for duration trends (need at least ${MIN_TREND_SAMPLES})`,
    );
  }
  if (failedLimit < 2) {
    warnings.push(
      `failedJobsHistoryLimit=${failedLimit} keeps at most ${failedLimit} failed run(s); repeated failures cannot be counted reliably`,
    );
  }
  if (runs.length === 0) {
    warnings.push("No retained Jobs found for this CronJob");
  } else if (!trend && successDurations.length < MIN_TREND_SAMPLES) {
    warnings.push(
      `Only ${successDurations.length} successful run(s) retained; trend needs at least ${MIN_TREND_SAMPLES}`,
    );
  }

  const records: RunRecord[] = runs
    .slice()
    .reverse()
    .slice(0, limit)
    .map((run) => ({
      job: run.name,
      status: run.outcome.status,
      startTime: run.outcome.startTime?.toISOString(),
      durationSeconds: run.outcome.durationSeconds,
      exitCode: run.exit.exitCode,
      reason: run.outcome.reason ?? run.exit.reason,
    }));

  const oldest = runs[0]?.outcome.startTime;
  let covers = "no retained runs";
  if (oldest) {
    covers = `${runs.length} run${runs.length === 1 ? "" : "s"} from ${oldest.toISOString()} to now`;
  }
  let trendBasis = `no trend (needs ${MIN_TREND_SAMPLES} successful runs, has ${successDurations.length})`;
  if (trend) {
    trend.summary += ` (last 3 successful runs vs the ${trend.sampleSize - 3} before them)`;
    trendBasis = `trend compares the last 3 successful runs with the ${trend.sampleSize - 3} before them`;
  }
  return {
    namespace: input.namespace,
    name: input.name,
    asOf: new Date().toISOString(),
    basis: `Only the Jobs Kubernetes still keeps for this CronJob (up to ${successfulLimit} successful and ${failedLimit} failed): ${covers}; ${trendBasis}`,
    historyLimits: { successful: successfulLimit, failed: failedLimit },
    retainedJobs: runs.length,
    runs: records,
    trend,
    warnings,
  };
}
