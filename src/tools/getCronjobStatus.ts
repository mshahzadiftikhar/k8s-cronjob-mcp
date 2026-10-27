import type { ClusterReader } from "../k8s/client.js";
import { isOwnedBy, jobOutcome } from "../analysis/jobs.js";
import { effectiveTimeZone, evaluateSchedule, nextFireTime, type ScheduleEvaluation } from "../analysis/schedule.js";
import { assessOverrun, type OverrunAssessment } from "../analysis/overrun.js";

export interface CronjobStatusResult extends ScheduleEvaluation {
  asOf: string;
  /** What the verdict is based on, in one sentence. */
  basis: string;
  namespace: string;
  name: string;
  schedule: string;
  timeZone?: string;
  /** Timezone the schedule is evaluated in (spec.timeZone, else the controller default). */
  effectiveTimeZone: string;
  nextRun?: string;
  concurrencyPolicy: string;
  startingDeadlineSeconds?: number;
  suspended: boolean;
  latestJob?: {
    name: string;
    status: string;
    startTime?: string;
    durationSeconds?: number;
  };
  overrun: OverrunAssessment;
}

export async function getCronjobStatus(
  reader: ClusterReader,
  input: { namespace: string; name: string },
  now: Date = new Date(),
): Promise<CronjobStatusResult> {
  const cronJob = await reader.getCronJob(input.namespace, input.name);
  const allJobs = await reader.listJobs(input.namespace);
  const jobs = allJobs.filter((job) => isOwnedBy(job, cronJob));

  const evaluation = evaluateSchedule({ cronJob, jobs, now });

  const withOutcome = jobs
    .map((job) => ({ job, outcome: jobOutcome(job) }))
    .sort((a, b) => (b.outcome.startTime?.getTime() ?? 0) - (a.outcome.startTime?.getTime() ?? 0));
  const newest = withOutcome[0];

  let latestJob: CronjobStatusResult["latestJob"] = undefined;
  if (newest) {
    latestJob = {
      name: newest.job.metadata?.name ?? "",
      status: newest.outcome.status,
      startTime: newest.outcome.startTime?.toISOString(),
      durationSeconds: newest.outcome.durationSeconds,
    };
  }

  const spec = cronJob.spec;
  let nextRun: string | undefined = undefined;
  if (spec && !spec.suspend) {
    nextRun = nextFireTime(spec.schedule, spec.timeZone, now).toISOString();
  }
  const overrun = assessOverrun({ cronJob, jobs, now });
  const sourceText = {
    annotation: "the scheduled time recorded on its Jobs",
    status: "the CronJob's status.lastScheduleTime",
    none: "no recorded run",
  }[evaluation.source];
  return {
    ...evaluation,
    asOf: now.toISOString(),
    basis: `Expected run from the schedule in ${effectiveTimeZone(spec?.timeZone)}; actual run from ${sourceText}; overrun check uses the ${overrun.basis}`,
    namespace: input.namespace,
    name: input.name,
    schedule: spec?.schedule ?? "",
    timeZone: spec?.timeZone,
    effectiveTimeZone: effectiveTimeZone(spec?.timeZone),
    nextRun,
    concurrencyPolicy: spec?.concurrencyPolicy ?? "Allow",
    startingDeadlineSeconds: spec?.startingDeadlineSeconds,
    suspended: spec?.suspend ?? false,
    latestJob,
    overrun,
  };
}
