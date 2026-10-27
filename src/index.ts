#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ClusterReader } from "./k8s/client.js";
import { KubeClusterReader } from "./k8s/client.js";
import { createServer } from "./server.js";
import { hasFatal, loadSetup, startupLog } from "./setup.js";
import { runChecks } from "./check.js";

const VERSION = "1.0.0";
const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v")) {
  console.log(VERSION);
  process.exit(0);
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(`k8s-cronjob-mcp ${VERSION}: read-only MCP server for Kubernetes CronJobs

Usage:
  k8s-cronjob-mcp            run the MCP server over stdio (what MCP clients do)
  k8s-cronjob-mcp --check    check the configuration and cluster access, then exit

Environment:
  KUBECONFIG              absolute path to the kubeconfig (default: ~/.kube/config)
  K8S_CONTEXT             kubeconfig context to use (recommended)
  ALLOWED_NAMESPACES      comma-separated namespaces the server may read
  CRON_DEFAULT_TIMEZONE   timezone for schedules without spec.timeZone (default: UTC)`);
  process.exit(0);
}

const setup = loadSetup();

if (args.includes("--check") || args[0] === "check") {
  const report = await runChecks(setup);
  console.log(report.text);
  console.log("\nNote: this used your terminal's environment. Claude Desktop's can differ; ask the agent to run check_setup to test that.");
  process.exit(report.ok ? 0 : 1);
}

// Startup summary goes to stderr, which MCP clients write to their server log.
console.error(startupLog(setup));

/** Stands in when the configuration is broken: tools explain the problem instead of the server crashing. */
const unavailable: ClusterReader = new Proxy({} as ClusterReader, {
  get: () => async () => {
    throw new Error("k8s-cronjob-mcp is not configured; run check_setup");
  },
});

let reader: ClusterReader = unavailable;
if (setup.kc && !hasFatal(setup.problems)) {
  reader = new KubeClusterReader({ kubeConfig: setup.kc, allowedNamespaces: setup.info.allowedNamespaces });
}

const server = createServer(reader, { setup });
await server.connect(new StdioServerTransport());
console.error("k8s-cronjob-mcp running on stdio");
