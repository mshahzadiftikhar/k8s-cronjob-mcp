import { afterEach, describe, expect, it } from "vitest";
import type { V1Job } from "@kubernetes/client-node";
import { countFiresBetween, nextFireTime, previousFireTime } from "../src/analysis/schedule.js";
import { assessOverrun } from "../src/analysis/overrun.js";
import { assessCronJob } from "../src/analysis/silent.js";
import { synthesizeCause } from "../src/analysis/failureCause.js";
import { listCronjobs } from "../src/tools/listCronjobs.js";
import { listRecentFailures } from "../src/tools/listRecentFailures.js";
import { getCronjobStatus } from "../src/tools/getCronjobStatus.js";
import { listActiveRuns as listActiveRunsFn } from "../src/tools/listActiveRuns.js";
import { cronJob, fakeReader, job, pod } from "./fixtures.js";

const DAY = 86400;

afterEach(() => {
  delete process.env.CRON_DEFAULT_TIMEZONE;
});

describe("timezone default", () => {
  it("evaluates schedules without spec.timeZone in UTC, not the host timezone", () => {
    const hostTz = process.env.TZ;
    process.env.TZ = "Asia/Kuala_Lumpur";
    try {
      const now = new Date("2026-10-19T19:00:00Z");
      expect(previousFireTime("0 2 * * *", undefined, now).toISOString()).toBe("2026-10-19T02:00:00.000Z");
      expect(nextFireTime("0 2 * * *", undefined, now).toISOString()).toBe("2026-10-20T02:00:00.000Z");
    } finally {
      if (hostTz === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = hostTz;
      }
    }
  });

  it("can be overridden for clusters whose controller is not on UTC", () => {
    process.env.CRON_DEFAULT_TIMEZONE = "Asia/Kuala_Lumpur";
    const now = new Date("2026-10-19T19:00:00Z");
    expect(previousFireTime("0 2 * * *", undefined, now).toISOString()).toBe("2026-10-19T18:00:00.000Z");
  });

  it("spec.timeZone still wins", () => {
    process.env.CRON_DEFAULT_TIMEZONE = "Asia/Kuala_Lumpur";
    const now = new Date("2026-10-19T19:00:00Z");
    expect(previousFireTime("0 2 * * *", "UTC", now).toISOString()).toBe("2026-10-19T02:00:00.000Z");
  });

  it("get_cronjob_status reports the effective timezone and next run", async () => {
    const reader = fakeReader({ cronJobs: [cronJob({ schedule: "0 2 * * *" })] });
    const r = await getCronjobStatus(reader, { namespace: "ops", name: "nightly" }, new Date("2026-10-19T19:00:00Z"));
    expect(r.effectiveTimeZone).toBe("UTC");
    expect(r.nextRun).toBe("2026-10-20T02:00:00.000Z");
  });
});

describe("countFiresBetween", () => {
  it("counts fire times in the half-open range", () => {
    const from = new Date("2026-10-19T10:00:00Z");
    const to = new Date("2026-10-19T11:00:00Z");
    expect(countFiresBetween("*/10 * * * *", undefined, from, to)).toBe(6);
    expect(countFiresBetween("*/10 * * * *", undefined, to, from)).toBe(0);
  });
  it("is capped", () => {
    expect(countFiresBetween("* * * * *", undefined, new Date("2026-01-01T00:00:00Z"), new Date("2026-02-01T00:00:00Z"), 50)).toBe(50);
  });
});

// The real case from a dev cluster: every 10 minutes, Forbid, runs taking 20-24 minutes.
const NOW = new Date("2026-10-19T15:23:30Z");

function overrunJobs(): V1Job[] {
  return [
    job("r1", { start: "2026-10-19T14:35:35Z", end: "2026-10-19T14:55:58Z", result: "Complete", scheduled: "2026-10-19T14:34:00Z" }),
    job("r2", { start: "2026-10-19T14:55:58Z", end: "2026-10-19T15:20:05Z", result: "Complete", scheduled: "2026-10-19T14:54:00Z" }),
    job("r3", { start: "2026-10-19T15:20:05Z", scheduled: "2026-10-19T15:14:00Z" }),
  ];
}

describe("assessOverrun", () => {
  const cj = cronJob({ schedule: "4,14,24,34,44,54 * * * *", concurrencyPolicy: "Forbid" });

  it("flags runs that take longer than the schedule interval", () => {
    const r = assessOverrun({ cronJob: cj, jobs: overrunJobs(), now: NOW });
    expect(r.overrunning).toBe(true);
    expect(r.intervalSeconds).toBe(600);
    expect(r.typicalDurationSeconds).toBe(1335);
    expect(r.lateStarts).toBe(3);
    expect(r.maxLateStartSeconds).toBe(365);
    expect(r.summary).toMatch(/typically take 22m \(median of last 2 successful runs\) but the schedule fires every 10m/);
    expect(r.summary).toMatch(/3 of the 3 retained runs started late/);
    expect(r.basis).toBe("median of last 2 successful runs");
    expect(r.summary).toMatch(/Forbid.*1 in 3 scheduled runs/);
  });

  it("describes overlap for Allow and cancellation for Replace", () => {
    const allow = assessOverrun({ cronJob: cronJob({ schedule: "*/10 * * * *" }), jobs: overrunJobs(), now: NOW });
    expect(allow.summary).toMatch(/overlap/);
    const replace = assessOverrun({ cronJob: cronJob({ schedule: "*/10 * * * *", concurrencyPolicy: "Replace" }), jobs: overrunJobs(), now: NOW });
    expect(replace.summary).toMatch(/cancels/);
  });

  it("flags a single active run that has outlasted the interval even without history", () => {
    const stuck = job("stuck", { start: "2026-10-19T14:00:00Z" });
    const r = assessOverrun({ cronJob: cj, jobs: [stuck], now: NOW });
    expect(r.overrunning).toBe(true);
    expect(r.summary).toMatch(/current run has been going for 84m/);
  });

  it("does not flag fast runs or suspended CronJobs", () => {
    const quick = [job("q", { start: "2026-10-19T15:14:00Z", end: "2026-10-19T15:15:00Z", result: "Complete" })];
    expect(assessOverrun({ cronJob: cj, jobs: quick, now: NOW }).overrunning).toBe(false);
    const paused = cronJob({ schedule: "*/10 * * * *", suspend: true });
    expect(assessOverrun({ cronJob: paused, jobs: overrunJobs(), now: NOW }).overrunning).toBe(false);
  });

  it("handles irregular schedules by using the shortest gap", () => {
    const twiceDaily = cronJob({ schedule: "0 9,10 * * *" });
    const slow = [job("s", { start: "2026-10-19T09:00:00Z", end: "2026-10-19T10:30:00Z", result: "Complete" })];
    const r = assessOverrun({ cronJob: twiceDaily, jobs: slow, now: NOW });
    expect(r.intervalSeconds).toBe(3600);
    expect(r.overrunning).toBe(true);
  });
});

describe("assessCronJob: stopped firing and overrun", () => {
  it("flags a frequent CronJob that stopped firing even though it succeeded within the window", () => {
    const cj = cronJob({ schedule: "*/5 * * * *" }, { status: { lastSuccessfulTime: new Date(NOW.getTime() - DAY * 1000) } });
    const a = assessCronJob({ cronJob: cj, jobs: [], now: NOW, windowSeconds: 7 * DAY });
    expect(a.status).toBe("silent-failure");
    expect(a.pattern).toBe("stalled");
    expect(a.missedRuns).toBe(288);
    expect(a.summary).toMatch(/No run has started for the last 288 scheduled times/);
  });

  it("does not flag a CronJob that ran recently", () => {
    const cj = cronJob({ schedule: "*/5 * * * *" }, { status: { lastSuccessfulTime: new Date(NOW.getTime() - 4 * 60_000) } });
    const a = assessCronJob({ cronJob: cj, jobs: [], now: NOW, windowSeconds: 7 * DAY });
    expect(a.status).toBe("healthy");
    expect(a.missedRuns).toBe(1); // one fire since, below the threshold of 3
  });

  it("does not count missed runs while a run is active (Forbid skips are an overrun, not a stall)", () => {
    const cj = cronJob({ schedule: "*/10 * * * *", concurrencyPolicy: "Forbid" }, { status: { active: [{ name: "r3" }] } });
    const a = assessCronJob({ cronJob: cj, jobs: overrunJobs(), now: NOW, windowSeconds: 7 * DAY });
    expect(a.missedRuns).toBeUndefined();
    expect(a.status).toBe("degraded");
    expect(a.overrunning).toBe(true);
  });
});

describe("listCronjobs", () => {
  it("returns one row per CronJob, worst first, with health and next run", async () => {
    const ok = cronJob({ schedule: "*/30 * * * *" }, { status: { lastSuccessfulTime: new Date(NOW.getTime() - 60_000) } });
    ok.metadata = { name: "ok", namespace: "ops", uid: "ok-uid", creationTimestamp: new Date("2026-09-01T00:00:00Z") };
    const over = cronJob({ schedule: "4,14,24,34,44,54 * * * *", concurrencyPolicy: "Forbid" }, { status: { active: [{ name: "r3" }] } });
    over.metadata = { name: "over", namespace: "ops", uid: "cj-uid", creationTimestamp: new Date("2026-09-01T00:00:00Z") };
    const paused = cronJob({ suspend: true });
    paused.metadata = { name: "paused", namespace: "ops", uid: "p-uid", creationTimestamp: new Date("2026-09-01T00:00:00Z") };

    const reader = fakeReader({ cronJobs: [ok, paused, over], jobs: overrunJobs() });
    const r = await listCronjobs(reader, { namespace: "ops" }, NOW);
    expect(r.cronJobs.map((c) => [c.name, c.health])).toEqual([
      ["over", "overrunning"],
      ["ok", "healthy"],
      ["paused", "suspended"],
    ]);
    expect(r.cronJobs[0]?.lastResult).toMatchObject({ job: "r2", status: "Succeeded" });
    expect(r.cronJobs[1]?.nextRun).toBe("2026-10-19T15:30:00.000Z");
    expect(r.cronJobs[2]?.nextRun).toBeUndefined();

    const noSuspended = await listCronjobs(reader, { namespace: "ops", include_suspended: false }, NOW);
    expect(noSuspended.cronJobs.map((c) => c.name)).toEqual(["over", "ok"]);
    expect(noSuspended.counts.suspended).toBe(1);
  });
});

describe("listRecentFailures", () => {
  const cj = cronJob({ schedule: "0 * * * *" });
  const jobs = [
    job("old-fail", { start: "2026-10-17T10:00:00Z", end: "2026-10-17T10:05:00Z", result: "Failed" }),
    job("oom-fail", { start: "2026-10-19T10:00:00Z", end: "2026-10-19T10:02:00Z", result: "Failed" }),
    job("later-ok", { start: "2026-10-19T11:00:00Z", end: "2026-10-19T11:01:00Z", result: "Complete" }),
    job("last-fail", { start: "2026-10-19T14:00:00Z", end: "2026-10-19T14:01:00Z", result: "DeadlineExceeded" }),
  ];
  const adhoc = job("adhoc-fail", { start: "2026-10-19T12:00:00Z", end: "2026-10-19T12:00:30Z", result: "Failed" });
  adhoc.metadata!.ownerReferences = [];
  const oomPod = pod("oom-fail", 137, "OOMKilled");
  const base = fakeReader({ cronJobs: [cj], jobs: [...jobs, adhoc] });
  const reader = { ...base, listPods: async (_ns: string, selector?: string) => (selector === "job-name=oom-fail" ? [oomPod] : []) };

  it("lists failures in the window, newest first, with cause and recovery", async () => {
    const r = await listRecentFailures(reader, { namespace: "ops", hours: 24 }, NOW);
    expect(r.failures.map((f) => f.job)).toEqual(["last-fail", "adhoc-fail", "oom-fail"]);
    const byJob = Object.fromEntries(r.failures.map((f) => [f.job, f]));
    expect(byJob["oom-fail"]).toMatchObject({ recovered: true, cause: { category: "oom-killed" }, owner: { kind: "CronJob", name: "nightly" } });
    expect(byJob["last-fail"]).toMatchObject({ recovered: false, status: "DeadlineExceeded", cause: { category: "deadline-exceeded" } });
    expect(byJob["adhoc-fail"]?.recovered).toBeUndefined();
    expect(r.counts).toMatchObject({ total: 3, unrecovered: 2 });
  });

  it("respects the window and limit", async () => {
    const r = await listRecentFailures(reader, { namespace: "ops", hours: 2, limit: 5 }, NOW);
    expect(r.failures.map((f) => f.job)).toEqual(["last-fail"]);
    const limited = await listRecentFailures(reader, { namespace: "ops", hours: 24, limit: 1 }, NOW);
    expect(limited.failures).toHaveLength(1);
    expect(limited.truncated).toBe(true);
  });
});

describe("cause when pods are gone", () => {
  it("uses what the Job still records and explains why evidence is missing", () => {
    const j = job("gone", { start: "2026-10-13T06:18:49Z", end: "2026-10-13T07:25:06Z", result: "Failed" });
    j.status!.failed = 3;
    j.status!.conditions![0]!.message = "Job has reached the specified backoff limit";
    j.spec!.ttlSecondsAfterFinished = 3600;
    const cause = synthesizeCause({ job: j, pods: [], events: [] });
    expect(cause.summary).toMatch(/BackoffLimitExceeded: Job has reached the specified backoff limit\) after 3 failed pod\(s\)/);
    expect(cause.summary).toMatch(/ttlSecondsAfterFinished=3600/);
    expect(cause.summary).toMatch(/pods no longer exist/);
  });
});

describe("at-risk, suspended summary, scope and basis", () => {
  const nearly = () => [
    job("a1", { start: "2026-10-19T14:50:00Z", end: "2026-10-19T14:58:30Z", result: "Complete" }),
    job("a2", { start: "2026-10-19T15:00:00Z", end: "2026-10-19T15:08:30Z", result: "Complete" }),
  ];

  it("flags runs using more than 80% of the interval as at-risk, with the basis", () => {
    const cj = cronJob({ schedule: "*/10 * * * *", concurrencyPolicy: "Forbid" });
    const r = assessOverrun({ cronJob: cj, jobs: nearly(), now: NOW });
    expect(r).toMatchObject({ overrunning: false, atRisk: true, utilizationPercent: 85 });
    expect(r.summary).toBe(
      "Close to overrunning: runs take 9m, 85% of the 10m between scheduled runs (median of last 2 successful runs). If a run gets slower, the next run will start late or be skipped",
    );
  });

  it("is not at risk below 80%", () => {
    const quick = [job("q", { start: "2026-10-19T15:00:00Z", end: "2026-10-19T15:07:00Z", result: "Complete" })];
    expect(assessOverrun({ cronJob: cronJob({ schedule: "*/10 * * * *" }), jobs: quick, now: NOW }).atRisk).toBe(false);
  });

  it("reports at-risk in list_cronjobs and find_silent_failures", async () => {
    const cj = cronJob({ schedule: "*/10 * * * *" }, { status: { lastSuccessfulTime: new Date("2026-10-19T15:08:30Z") } });
    const reader = fakeReader({ cronJobs: [cj], jobs: nearly() });
    const list = await listCronjobs(reader, { namespace: "ops" }, NOW);
    expect(list.cronJobs[0]?.health).toBe("at-risk");
    expect(list.counts["at-risk"]).toBe(1);
    const { findSilentFailures } = await import("../src/tools/findSilentFailures.js");
    const scan = await findSilentFailures(reader, { namespace: "ops" }, NOW);
    expect(scan.counts.atRisk).toBe(1);
    expect(scan.findings[0]).toMatchObject({ status: "at-risk", atRisk: true });
  });

  it("labels the scope with ALLOWED_NAMESPACES when no namespace is given", async () => {
    const reader = { ...fakeReader({ jobs: [] }), scopeLabel: () => "team-a (ALLOWED_NAMESPACES)" };
    expect((await listActiveRunsFn(reader, {}, NOW)).scope).toBe("team-a (ALLOWED_NAMESPACES)");
    expect((await listActiveRunsFn(reader, { namespace: "team-a" }, NOW)).scope).toBe("team-a");
    expect((await listActiveRunsFn(fakeReader({ jobs: [] }), {}, NOW)).scope).toBe("all namespaces");
  });

  it("says what each answer is based on", async () => {
    const reader = fakeReader({ cronJobs: [cronJob({ schedule: "*/10 * * * *" })], jobs: nearly() });
    const failures = await listRecentFailures(reader, { hours: 72 }, NOW);
    expect(failures.basis).toMatch(/^Failed Jobs that finished in the last 3 days, from only the Jobs Kubernetes still keeps/);
    expect(failures.since).toBe("2026-10-16T15:23:30.000Z");
    expect(failures.asOf).toBe(NOW.toISOString());
    const list = await listCronjobs(reader, { days: 1 }, NOW);
    expect(list.basis).toMatch(/last 1 day/);
    const status = await getCronjobStatus(reader, { namespace: "ops", name: "nightly" }, NOW);
    expect(status.basis).toMatch(/schedule in UTC; actual run from .*; overrun check uses the median of last 2 successful runs/);
  });
});

