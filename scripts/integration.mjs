// End-to-end test against the kind demo cluster, as the read-only ServiceAccount.
// Run via `npm run test:integration` (after `npm run demo:up`).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Only a repo-local kubeconfig is ever used; the ambient $KUBECONFIG is ignored.
const kubeconfig = resolve(process.env.INTEGRATION_KUBECONFIG ?? ".kube/sa.kubeconfig");
if (!existsSync(kubeconfig)) {
  console.error(`missing ${kubeconfig}; run: npm run demo:up && scripts/sa-kubeconfig.sh`);
  process.exit(2);
}
const context = execFileSync("kubectl", ["config", "current-context"], {
  env: { ...process.env, KUBECONFIG: kubeconfig },
  encoding: "utf8",
}).trim();
if (!context.startsWith("kind-")) {
  console.error(`refusing to run: context "${context}" is not a kind cluster`);
  process.exit(2);
}

async function connect(extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: { PATH: process.env.PATH, KUBECONFIG: kubeconfig, ...extraEnv },
    stderr: "ignore",
  });
  const client = new Client({ name: "integration", version: "0" });
  await client.connect(transport);
  return client;
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content[0].text;
  if (result.isError) {
    return { error: text };
  }
  return JSON.parse(text);
}

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`ok    ${label}`);
  } else {
    failures++;
    let suffix = "";
    if (detail) {
      suffix = ` -> ${detail}`;
    }
    console.log(`FAIL  ${label}${suffix}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const client = await connect();

// Wait until the demo has produced the runs the assertions need (cron fires every 2 minutes).
async function waitForRuns() {
  const deadline = Date.now() + 6 * 60_000;
  while (Date.now() < deadline) {
    const healthy = await call(client, "get_run_history", { namespace: "demo", name: "healthy" });
    const failing = await call(client, "get_run_history", { namespace: "demo", name: "always-failing" });
    const oom = await call(client, "get_run_history", { namespace: "demo", name: "oom" });
    const ready =
      healthy.runs?.some((r) => r.status === "Succeeded") &&
      failing.runs?.some((r) => r.status === "Failed") &&
      oom.runs?.some((r) => r.status === "Failed");
    if (ready) {
      return;
    }
    console.log("waiting for demo CronJobs to produce runs...");
    await sleep(15_000);
  }
  throw new Error("demo CronJobs produced no runs within 6 minutes");
}
await waitForRuns();

const tools = await client.listTools();
check(
  "exposes the eight tools",
  [
    "check_setup",
    "get_cronjob_status",
    "get_run_history",
    "find_silent_failures",
    "get_failure_details",
    "list_active_runs",
    "list_cronjobs",
    "list_recent_failures",
  ].every((n) =>
    tools.tools.some((t) => t.name === n),
  ),
);

const healthy = await call(client, "get_cronjob_status", { namespace: "demo", name: "healthy" });
check("healthy is on-schedule or running", ["on-schedule", "currently running"].includes(healthy.verdict), healthy.verdict);

const paused = await call(client, "get_cronjob_status", { namespace: "demo", name: "paused" });
check("paused is suspended", paused.verdict === "suspended", paused.verdict);

const missing = await call(client, "get_cronjob_status", { namespace: "demo", name: "does-not-exist" });
check("missing CronJob gives a clear error", /not found/.test(missing.error ?? ""), missing.error);

const history = await call(client, "get_run_history", { namespace: "demo", name: "always-failing" });
const failedRun = history.runs.find((r) => r.status === "Failed");
check("always-failing run has exit code 2", failedRun?.exitCode === 2, JSON.stringify(failedRun));

const scan = await call(client, "find_silent_failures", { namespace: "demo", days: 0.01 });
if (scan.error) {
  console.log(`FAIL  find_silent_failures errored -> ${scan.error}`);
  process.exit(1);
}
const byName = Object.fromEntries(scan.findings.map((f) => [f.name, f]));
check("always-failing flagged as failing", byName["always-failing"]?.pattern === "failing");
check("oom flagged as failing", byName["oom"]?.pattern === "failing");
check("paused reported as suspended", byName["paused"]?.status === "suspended");
check("healthy is not flagged", byName["healthy"] === undefined);

const oomRun = (await call(client, "get_run_history", { namespace: "demo", name: "oom" })).runs.find(
  (r) => r.status === "Failed",
);
const oom = await call(client, "get_failure_details", { namespace: "demo", job_name: oomRun.job });
check("oom cause is OOMKilled with limit", oom.cause.category === "oom-killed" && /20Mi/.test(oom.cause.summary), oom.cause.summary);

const af = await call(client, "get_failure_details", { namespace: "demo", job_name: failedRun.job });
check("always-failing cause is exit code 2", af.cause.category === "exit-code" && /exit code 2/.test(af.cause.summary), af.cause.summary);
check("failure logs are returned", af.pods[0]?.logs?.text?.includes("db unreachable"), JSON.stringify(af.pods[0]?.logs));

const active = await call(client, "list_active_runs", { namespace: "demo" });
check("list_active_runs returns demo scope", active.scope === "demo" && Array.isArray(active.runs), active.error ?? JSON.stringify(active.counts));
check(
  "list_active_runs only returns unfinished demo Jobs",
  active.runs?.every((r) => r.namespace === "demo" && ["running", "pending", "suspended", "finishing"].includes(r.state)),
  JSON.stringify(active.runs),
);

const setupCheck = await client.callTool({ name: "check_setup", arguments: {} });
check("check_setup passes against the demo cluster", !setupCheck.isError, setupCheck.content[0].text);

const inventory = await call(client, "list_cronjobs", { namespace: "demo" });
const health = Object.fromEntries((inventory.cronJobs ?? []).map((c) => [c.name, c.health]));
check("list_cronjobs covers all six demo CronJobs", inventory.total === 6, inventory.error ?? JSON.stringify(health));
check("list_cronjobs: always-failing is failing", health["always-failing"] === "failing", health["always-failing"]);
check("list_cronjobs: paused is suspended", health["paused"] === "suspended", health["paused"]);
check("list_cronjobs: healthy is healthy", health["healthy"] === "healthy", health["healthy"]);
check("list_cronjobs: rows use UTC by default", inventory.cronJobs?.every((c) => c.timeZone === "UTC"));

const recent = await call(client, "list_recent_failures", { namespace: "demo", hours: 1 });
const recentByOwner = new Map((recent.failures ?? []).map((f) => [f.owner?.name, f]));
check("list_recent_failures includes always-failing", recentByOwner.has("always-failing"), recent.error ?? JSON.stringify([...recentByOwner.keys()]));
check(
  "list_recent_failures: oom cause is OOMKilled",
  recentByOwner.get("oom")?.cause?.category === "oom-killed",
  JSON.stringify(recentByOwner.get("oom")?.cause),
);
check("list_recent_failures: always-failing has not recovered", recentByOwner.get("always-failing")?.recovered === false);

const status = await call(client, "get_cronjob_status", { namespace: "demo", name: "healthy" });
check("get_cronjob_status reports next run and overrun", typeof status.nextRun === "string" && status.overrun?.overrunning === false, JSON.stringify(status.overrun));

await client.close();

// Namespace allowlist: querying outside it must be refused before any API call.
const restricted = await connect({ ALLOWED_NAMESPACES: "other" });
const denied = await call(restricted, "get_cronjob_status", { namespace: "demo", name: "healthy" });
check("allowlist blocks other namespaces", /not in the allowed list/.test(denied.error ?? ""), denied.error);
await restricted.close();

if (failures === 0) {
  console.log("\nall integration checks passed");
  process.exit(0);
}
console.log(`\n${failures} check(s) failed`);
process.exit(1);
