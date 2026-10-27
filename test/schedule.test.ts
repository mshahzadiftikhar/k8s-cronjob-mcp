import { describe, expect, it } from "vitest";
import { evaluateSchedule, previousFireTime } from "../src/analysis/schedule.js";
import { cronJob, job, NOW } from "./fixtures.js";

// NOW = 12:30:30Z, schedule */30 -> expected last fire 12:30:00Z

describe("previousFireTime", () => {
  it("handles standard expressions", () => {
    expect(previousFireTime("*/30 * * * *", undefined, NOW).toISOString()).toBe("2026-10-05T12:30:00.000Z");
  });
  it("handles macros", () => {
    expect(previousFireTime("@hourly", undefined, NOW).toISOString()).toBe("2026-10-05T12:00:00.000Z");
  });
  it("honours time zones", () => {
    // 12:30Z is 08:30 EDT, so today's 09:00 EDT has not fired yet.
    const before = previousFireTime("0 9 * * *", "America/New_York", NOW);
    expect(before.toISOString()).toBe("2026-10-04T13:00:00.000Z");
    const after = previousFireTime("0 9 * * *", "America/New_York", new Date("2026-10-05T14:00:00Z"));
    expect(after.toISOString()).toBe("2026-10-05T13:00:00.000Z");
  });
});

describe("evaluateSchedule", () => {
  it("on-schedule when last run matches expected (annotation)", () => {
    const jobs = [job("j1", { start: "2026-10-05T12:30:01Z", scheduled: "2026-10-05T12:30:00Z" })];
    const r = evaluateSchedule({ cronJob: cronJob(), jobs, now: NOW });
    expect(r.verdict).toBe("on-schedule");
    expect(r.source).toBe("annotation");
  });

  it("falls back to status.lastScheduleTime on older clusters", () => {
    const cj = cronJob({}, { status: { lastScheduleTime: new Date("2026-10-05T12:30:00Z") } });
    const r = evaluateSchedule({ cronJob: cj, jobs: [], now: NOW });
    expect(r.verdict).toBe("on-schedule");
    expect(r.source).toBe("status");
  });

  it("within controller grace is on-schedule", () => {
    const cj = cronJob({}, { status: { lastScheduleTime: new Date("2026-10-05T12:00:00Z") } });
    const r = evaluateSchedule({ cronJob: cj, jobs: [], now: NOW });
    expect(r.verdict).toBe("on-schedule");
    expect(r.lagSeconds).toBe(30);
  });

  it("late when past grace but within default cutoff", () => {
    const cj = cronJob({}, { status: { lastScheduleTime: new Date("2026-10-05T12:00:00Z") } });
    const now = new Date("2026-10-05T12:33:00Z");
    expect(evaluateSchedule({ cronJob: cj, jobs: [], now }).verdict).toBe("late");
  });

  it("missed when past default cutoff", () => {
    const cj = cronJob({}, { status: { lastScheduleTime: new Date("2026-10-05T11:00:00Z") } });
    const now = new Date("2026-10-05T12:40:00Z");
    expect(evaluateSchedule({ cronJob: cj, jobs: [], now }).verdict).toBe("missed");
  });

  it("uses startingDeadlineSeconds as the cutoff", () => {
    const cj = cronJob({ startingDeadlineSeconds: 100 }, { status: { lastScheduleTime: new Date("2026-10-05T12:00:00Z") } });
    const now = new Date("2026-10-05T12:33:00Z"); // lag 180s > 100s
    expect(evaluateSchedule({ cronJob: cj, jobs: [], now }).verdict).toBe("missed");
  });

  it("currently running when active jobs exist", () => {
    const cj = cronJob({}, { status: { active: [{ name: "j1" }] } });
    expect(evaluateSchedule({ cronJob: cj, jobs: [], now: NOW }).verdict).toBe("currently running");
  });

  it("suspended takes precedence", () => {
    const cj = cronJob({ suspend: true });
    expect(evaluateSchedule({ cronJob: cj, jobs: [], now: NOW }).verdict).toBe("suspended");
  });

  it("brand new CronJob with no run due is on-schedule", () => {
    const cj = cronJob({}, { metadata: { name: "nightly", uid: "cj-uid", creationTimestamp: new Date("2026-10-05T12:31:00Z") } });
    expect(evaluateSchedule({ cronJob: cj, jobs: [], now: new Date("2026-10-05T12:32:00Z") }).verdict).toBe("on-schedule");
  });

  it("never scheduled and old enough is missed", () => {
    const now = new Date("2026-10-05T12:40:00Z");
    expect(evaluateSchedule({ cronJob: cronJob(), jobs: [], now }).verdict).toBe("missed");
  });
});
