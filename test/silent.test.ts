import { describe, expect, it } from "vitest";
import { findSilentFailures } from "../src/tools/findSilentFailures.js";
import { cronJob, fakeReader, job } from "./fixtures.js";

const NOW = new Date("2026-10-05T12:30:30Z");
const DAY = 86400_000;

function iso(msAgo: number): string {
  return new Date(NOW.getTime() - msAgo).toISOString();
}

function named(name: string, uid: string, spec = {}, status = {}) {
  const cj = cronJob({ schedule: "0 * * * *", ...spec }, { status });
  cj.metadata = { name, namespace: "ops", uid, creationTimestamp: new Date(NOW.getTime() - 30 * DAY) };
  return cj;
}

function ownedJob(name: string, uid: string, startAgo: number, result: "Complete" | "Failed") {
  const j = job(name, { start: iso(startAgo), end: iso(startAgo - 5000), result });
  j.metadata!.ownerReferences = [{ apiVersion: "batch/v1", kind: "CronJob", name: "x", uid }];
  return j;
}

describe("findSilentFailures", () => {
  const cronJobs = [
    named("healthy", "u1", {}, { lastSuccessfulTime: new Date(iso(3600_000)) }),
    named("failing", "u2", {}, { lastSuccessfulTime: new Date(iso(10 * DAY)) }),
    named("stalled", "u3", {}, { lastSuccessfulTime: new Date(iso(9 * DAY)) }),
    named("never", "u4"),
    named("paused", "u5", { suspend: true }),
    named("degraded", "u6", {}, { lastSuccessfulTime: new Date(iso(5 * 3600_000)) }),
    named("weekly-ok", "u7", { schedule: "0 0 * * 0" }, { lastSuccessfulTime: new Date(iso(9 * DAY)) }),
  ];
  const jobs = [
    ownedJob("f1", "u2", 3 * 3600_000, "Failed"),
    ownedJob("f2", "u2", 2 * 3600_000, "Failed"),
    ownedJob("d1", "u6", 3 * 3600_000, "Failed"),
    ownedJob("d2", "u6", 2 * 3600_000, "Failed"),
    ownedJob("h1", "u1", 3600_000, "Complete"),
  ];
  const reader = fakeReader({ cronJobs, jobs });

  it("flags and ranks silent failures, ignoring healthy and slow-cadence jobs", async () => {
    const r = await findSilentFailures(reader, { days: 7 }, NOW);
    expect(r.scannedCronJobs).toBe(7);
    expect(r.counts).toEqual({ silentFailures: 3, degraded: 1, atRisk: 0, suspended: 1, healthy: 2 });
    expect(r.findings.map((f) => f.name)).toEqual(["failing", "never", "stalled", "degraded"]);
    expect(r.suspended).toEqual([{ namespace: "ops", name: "paused", lastSuccess: undefined }]);
  });

  it("classifies patterns", async () => {
    const r = await findSilentFailures(reader, { days: 7 }, NOW);
    const byName = Object.fromEntries(r.findings.map((f) => [f.name, f]));
    expect(byName["failing"]).toMatchObject({ pattern: "failing", severity: "high", consecutiveFailures: 2 });
    expect(byName["stalled"]).toMatchObject({ pattern: "stalled", severity: "medium" });
    expect(byName["never"]).toMatchObject({ pattern: "never-succeeded" });
    expect(byName["weekly-ok"]).toBeUndefined();
  });

  it("does not flag a brand-new CronJob that has not failed", async () => {
    const fresh = named("fresh", "u9");
    fresh.metadata!.creationTimestamp = new Date(NOW.getTime() - DAY);
    const r = await findSilentFailures(fakeReader({ cronJobs: [fresh], jobs: [] }), {}, NOW);
    expect(r.counts.silentFailures).toBe(0);
  });

  it("truncates to limit", async () => {
    const r = await findSilentFailures(reader, { days: 7, limit: 2 }, NOW);
    expect(r.findings).toHaveLength(2);
    expect(r.truncated).toBe(true);
  });
});
