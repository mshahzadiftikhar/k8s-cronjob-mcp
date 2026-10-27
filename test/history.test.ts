import { describe, expect, it } from "vitest";
import { durationTrend } from "../src/analysis/trend.js";
import { getRunHistory } from "../src/tools/getRunHistory.js";
import { getCronjobStatus } from "../src/tools/getCronjobStatus.js";
import { cronJob, fakeReader, job, NOW, pod } from "./fixtures.js";

describe("durationTrend", () => {
  it("needs at least 4 samples", () => {
    expect(durationTrend([10, 10, 10])).toBeUndefined();
  });
  it("detects slowdown", () => {
    const t = durationTrend([100, 100, 140, 140, 140]);
    expect(t?.direction).toBe("slower");
    expect(t?.percentChange).toBe(40);
  });
  it("detects stable", () => {
    expect(durationTrend([100, 105, 98, 102, 100])?.direction).toBe("stable");
  });
});

describe("getRunHistory", () => {
  const jobs = [
    job("run-1", { start: "2026-10-05T10:00:00Z", end: "2026-10-05T10:01:40Z", result: "Complete" }),
    job("run-2", { start: "2026-10-05T11:00:00Z", end: "2026-10-05T11:00:30Z", result: "Failed" }),
    job("run-3", { start: "2026-10-05T12:00:00Z", end: "2026-10-05T12:30:00Z", result: "DeadlineExceeded" }),
  ];
  const reader = fakeReader({
    cronJobs: [cronJob({ successfulJobsHistoryLimit: 3, failedJobsHistoryLimit: 1 })],
    jobs,
    pods: [pod("run-2", 137, "OOMKilled")],
  });

  it("lists newest first with status, duration and exit code", async () => {
    const r = await getRunHistory(reader, { namespace: "ops", name: "nightly" });
    expect(r.runs.map((x) => x.job)).toEqual(["run-3", "run-2", "run-1"]);
    expect(r.runs[0]?.status).toBe("DeadlineExceeded");
    expect(r.runs[1]).toMatchObject({ status: "Failed", durationSeconds: 30, exitCode: 137, reason: "BackoffLimitExceeded" });
    expect(r.runs[2]).toMatchObject({ status: "Succeeded", durationSeconds: 100 });
  });

  it("warns when history is too short", async () => {
    const r = await getRunHistory(reader, { namespace: "ops", name: "nightly" });
    expect(r.warnings.join("\n")).toMatch(/too few runs/);
    expect(r.warnings.join("\n")).toMatch(/failedJobsHistoryLimit=1/);
  });

  it("respects limit and ignores jobs owned by other CronJobs", async () => {
    const stranger = job("other", { start: "2026-10-05T09:00:00Z", result: "Complete", end: "2026-10-05T09:01:00Z" });
    stranger.metadata!.ownerReferences = [{ apiVersion: "batch/v1", kind: "CronJob", name: "x", uid: "other-uid" }];
    const r = await getRunHistory(
      fakeReader({ cronJobs: [cronJob()], jobs: [...jobs, stranger] }),
      { namespace: "ops", name: "nightly", limit: 2 },
    );
    expect(r.retainedJobs).toBe(3);
    expect(r.runs).toHaveLength(2);
  });
});

describe("getCronjobStatus", () => {
  it("combines spec, verdict and latest job", async () => {
    const reader = fakeReader({
      cronJobs: [cronJob({ concurrencyPolicy: "Forbid" })],
      jobs: [job("run-1", { start: "2026-10-05T12:30:01Z", end: "2026-10-05T12:30:20Z", result: "Complete", scheduled: "2026-10-05T12:30:00Z" })],
    });
    const r = await getCronjobStatus(reader, { namespace: "ops", name: "nightly" }, NOW);
    expect(r.verdict).toBe("on-schedule");
    expect(r.concurrencyPolicy).toBe("Forbid");
    expect(r.latestJob).toMatchObject({ name: "run-1", status: "Succeeded", durationSeconds: 19 });
  });
});
