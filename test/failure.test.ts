import type { CoreV1Event, V1Pod } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/analysis/redact.js";
import { getFailureDetails } from "../src/tools/getFailureDetails.js";
import { fakeReader, job } from "./fixtures.js";

function failedJob(name: string, result: "Failed" | "DeadlineExceeded" = "Failed") {
  return job(name, { start: "2026-10-05T12:00:00Z", end: "2026-10-05T12:00:30Z", result });
}

function podFor(
  jobName: string,
  state: NonNullable<NonNullable<V1Pod["status"]>["containerStatuses"]>[number]["state"],
  memoryLimit?: string,
): V1Pod {
  return {
    metadata: {
      name: `${jobName}-pod`,
      labels: { "job-name": jobName },
      creationTimestamp: new Date("2026-10-05T12:00:00Z"),
    },
    spec: {
      containers: [{ name: "main", resources: { limits: memoryLimit ? { memory: memoryLimit } : {} } }],
    },
    status: {
      phase: "Failed",
      containerStatuses: [{ name: "main", image: "img:1", imageID: "", ready: false, restartCount: 0, state }],
    },
  };
}

function event(object: string, type: string, reason: string, message: string): CoreV1Event {
  return {
    metadata: { name: `${object}.${reason}` },
    involvedObject: { kind: "Pod", name: object },
    type,
    reason,
    message,
    lastTimestamp: new Date("2026-10-05T12:00:10Z"),
  };
}

describe("getFailureDetails cause synthesis", () => {
  it("OOMKilled includes the memory limit", async () => {
    const j = failedJob("j-oom");
    const p = podFor("j-oom", { terminated: { exitCode: 137, reason: "OOMKilled" } }, "340Mi");
    const r = await getFailureDetails(fakeReader({ jobs: [j], pods: [p], logs: { "j-oom-pod": "allocating" } }), {
      namespace: "ops",
      job_name: "j-oom",
    });
    expect(r.cause.category).toBe("oom-killed");
    expect(r.cause.summary).toBe('Container "main" OOMKilled at 340Mi, exit code 137');
    expect(r.pods[0]?.logs?.text).toBe("allocating");
  });

  it("DeadlineExceeded comes from the Job condition", async () => {
    const j = failedJob("j-dl", "DeadlineExceeded");
    j.spec!.activeDeadlineSeconds = 60;
    const p = podFor("j-dl", { terminated: { exitCode: 143, reason: "Error" } });
    const r = await getFailureDetails(fakeReader({ jobs: [j], pods: [p], logs: { "j-dl-pod": "" } }), {
      namespace: "ops",
      job_name: "j-dl",
    });
    expect(r.cause.category).toBe("deadline-exceeded");
    expect(r.cause.summary).toContain("activeDeadlineSeconds=60");
    expect(r.pods[0]?.logs?.unavailableReason).toBe("container wrote no output");
  });

  it("ImagePullBackOff", async () => {
    const j = failedJob("j-img");
    const p = podFor("j-img", { waiting: { reason: "ImagePullBackOff", message: "pull access denied" } });
    const r = await getFailureDetails(fakeReader({ jobs: [j], pods: [p], logs: { "j-img-pod": new Error("container is waiting to start") } }), {
      namespace: "ops",
      job_name: "j-img",
    });
    expect(r.cause.category).toBe("image-pull");
    expect(r.cause.summary).toContain("pull access denied");
    expect(r.pods[0]?.logs?.unavailableReason).toMatch(/waiting to start/);
  });

  it("maps well-known exit codes", async () => {
    const j = failedJob("j-127");
    const p = podFor("j-127", { terminated: { exitCode: 127, reason: "Error" } });
    const r = await getFailureDetails(fakeReader({ jobs: [j], pods: [p], logs: { "j-127-pod": "sh: foo: not found" } }), {
      namespace: "ops",
      job_name: "j-127",
    });
    expect(r.cause.category).toBe("exit-code");
    expect(r.cause.summary).toContain("exit code 127 (command not found)");
  });

  it("unschedulable when the pod never started", async () => {
    const j = failedJob("j-sched");
    const p = podFor("j-sched", { waiting: { reason: "ContainerCreating" } });
    const ev = event("j-sched-pod", "Warning", "FailedScheduling", "0/3 nodes available: insufficient cpu");
    const r = await getFailureDetails(fakeReader({ jobs: [j], pods: [p], events: [ev], logs: {} }), {
      namespace: "ops",
      job_name: "j-sched",
    });
    expect(r.cause.category).toBe("unschedulable");
    expect(r.events[0]?.reason).toBe("FailedScheduling");
  });

  it("reports missing pods without erroring", async () => {
    const j = failedJob("j-gone");
    const r = await getFailureDetails(fakeReader({ jobs: [j] }), { namespace: "ops", job_name: "j-gone" });
    expect(r.cause.category).toBe("unknown");
    expect(r.cause.summary).toMatch(/pods no longer exist/);
    expect(r.notes.join(" ")).toMatch(/No pods remain/);
  });

  it("says so when the Job did not fail", async () => {
    const ok = job("j-ok", { start: "2026-10-05T12:00:00Z", end: "2026-10-05T12:00:05Z", result: "Complete" });
    const r = await getFailureDetails(fakeReader({ jobs: [ok] }), { namespace: "ops", job_name: "j-ok" });
    expect(r.cause.category).toBe("not-failed");
  });

  it("masks secrets in log output", async () => {
    const j = failedJob("j-sec");
    const p = podFor("j-sec", { terminated: { exitCode: 1, reason: "Error" } });
    const r = await getFailureDetails(
      fakeReader({ jobs: [j], pods: [p], logs: { "j-sec-pod": "connecting password=hunter2 Authorization: Bearer abcdefghijkl1234" } }),
      { namespace: "ops", job_name: "j-sec" },
    );
    expect(r.pods[0]?.logs?.text).not.toContain("hunter2");
    expect(r.pods[0]?.logs?.text).not.toContain("abcdefghijkl1234");
  });
});

describe("redactSecrets", () => {
  it("masks keyed values and bearer tokens", () => {
    expect(redactSecrets('{"api_key": "sk-123456"}')).toContain("[REDACTED]");
    expect(redactSecrets("token=abc123")).toBe("token=[REDACTED]");
    expect(redactSecrets("hello world")).toBe("hello world");
  });
});
