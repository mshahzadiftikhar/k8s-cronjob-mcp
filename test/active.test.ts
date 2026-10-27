import { describe, expect, it } from "vitest";
import type { V1Job } from "@kubernetes/client-node";
import { summarizeActiveRuns } from "../src/analysis/active.js";
import { listActiveRuns } from "../src/tools/listActiveRuns.js";
import { fakeReader, job, NOW } from "./fixtures.js";

// NOW is 2026-10-05T12:30:30Z. Three 100s successes give "nightly" a typical duration of 100s.
const history = [
  job("ok-1", { start: "2026-10-05T09:00:00Z", end: "2026-10-05T09:01:40Z", result: "Complete" }),
  job("ok-2", { start: "2026-10-05T10:00:00Z", end: "2026-10-05T10:01:40Z", result: "Complete" }),
  job("ok-3", { start: "2026-10-05T11:00:00Z", end: "2026-10-05T11:01:40Z", result: "Complete" }),
];

function withStatus(j: V1Job, status: Partial<NonNullable<V1Job["status"]>>, spec: Partial<NonNullable<V1Job["spec"]>> = {}): V1Job {
  j.status = { ...j.status, ...status };
  j.spec = { ...j.spec!, ...spec };
  return j;
}

describe("summarizeActiveRuns", () => {
  it("returns only unfinished Jobs, with owner and elapsed time", () => {
    const running = withStatus(job("now", { start: "2026-10-05T12:30:00Z" }), { active: 1, ready: 1 });
    const runs = summarizeActiveRuns([...history, running], NOW);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      job: "now",
      state: "running",
      owner: { kind: "CronJob", name: "nightly" },
      runningSeconds: 30,
      activePods: 1,
      readyPods: 1,
      typicalDurationSeconds: 100,
      longRunning: false,
    });
  });

  it("flags runs taking more than twice the typical duration and sorts them first", () => {
    const slow = withStatus(job("slow", { start: "2026-10-05T12:25:00Z" }), { active: 1 });
    const fresh = withStatus(job("fresh", { start: "2026-10-05T12:30:00Z" }), { active: 1 });
    const runs = summarizeActiveRuns([...history, fresh, slow], NOW);
    expect(runs.map((r) => r.job)).toEqual(["slow", "fresh"]);
    expect(runs[0]?.longRunning).toBe(true);
    expect(runs[0]?.notes.join()).toMatch(/more than 2x its typical 100s/);
  });

  it("does not guess a typical duration from too few samples", () => {
    const slow = withStatus(job("slow", { start: "2026-10-05T12:00:00Z" }), { active: 1 });
    const runs = summarizeActiveRuns([history[0]!, slow], NOW);
    expect(runs[0]?.typicalDurationSeconds).toBeUndefined();
    expect(runs[0]?.longRunning).toBe(false);
  });

  it("includes standalone Jobs with no owner", () => {
    const adhoc = withStatus(job("adhoc", { start: "2026-10-05T12:29:30Z" }), { active: 1 });
    adhoc.metadata!.ownerReferences = [];
    const runs = summarizeActiveRuns([adhoc], NOW);
    expect(runs[0]).toMatchObject({ job: "adhoc", owner: undefined, runningSeconds: 60 });
  });

  it("classifies suspended, pending and finishing Jobs", () => {
    const suspended = withStatus(job("susp", { start: "2026-10-05T12:00:00Z" }), {}, { suspend: true });
    const pending = job("pend", { start: "2026-10-05T12:30:00Z" });
    pending.status!.startTime = undefined;
    const finishing = withStatus(job("fin", { start: "2026-10-05T12:29:00Z" }), {
      conditions: [{ type: "FailureTarget", status: "True" }],
    });
    const states = Object.fromEntries(summarizeActiveRuns([suspended, pending, finishing], NOW).map((r) => [r.job, r.state]));
    expect(states).toEqual({ susp: "suspended", pend: "pending", fin: "finishing" });
  });

  it("reports retries and deadline", () => {
    const retrying = withStatus(
      job("retry", { start: "2026-10-05T12:28:30Z" }),
      { active: 1, failed: 2 },
      { backoffLimit: 4, activeDeadlineSeconds: 100 },
    );
    const run = summarizeActiveRuns([retrying], NOW)[0];
    expect(run).toMatchObject({ failedPods: 2, activeDeadlineSeconds: 100, secondsUntilDeadline: -20 });
    expect(run?.notes.join("\n")).toMatch(/2 pod\(s\) already failed; retrying \(backoffLimit=4\)/);
    expect(run?.notes.join("\n")).toMatch(/Past its activeDeadlineSeconds/);
  });
});

describe("listActiveRuns", () => {
  it("counts by state and respects limit", async () => {
    const a = withStatus(job("a", { start: "2026-10-05T12:29:00Z" }), { active: 1 });
    const b = withStatus(job("b", { start: "2026-10-05T12:30:00Z" }), { active: 1 });
    const c = withStatus(job("c", { start: "2026-10-05T12:00:00Z" }), {}, { suspend: true });
    const r = await listActiveRuns(fakeReader({ jobs: [...history, a, b, c] }), { namespace: "ops", limit: 2 }, NOW);
    expect(r.scope).toBe("ops");
    expect(r.scannedJobs).toBe(6);
    expect(r.counts).toEqual({ running: 2, pending: 0, suspended: 1, finishing: 0, longRunning: 0 });
    expect(r.runs).toHaveLength(2);
    expect(r.truncated).toBe(true);
  });

  it("reports an empty result when nothing is running", async () => {
    const r = await listActiveRuns(fakeReader({ jobs: history }), {}, NOW);
    expect(r.scope).toBe("all namespaces");
    expect(r.runs).toEqual([]);
    expect(r.truncated).toBe(false);
  });
});
