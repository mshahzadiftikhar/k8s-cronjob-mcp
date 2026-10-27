import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ClusterReader } from "./k8s/client.js";
import { describeError } from "./errors.js";
import { formatProblem, hasFatal, type Setup } from "./setup.js";
import { runChecks } from "./check.js";
import { getCronjobStatus } from "./tools/getCronjobStatus.js";
import { getRunHistory } from "./tools/getRunHistory.js";
import { getFailureDetails } from "./tools/getFailureDetails.js";
import { findSilentFailures } from "./tools/findSilentFailures.js";
import { listActiveRuns } from "./tools/listActiveRuns.js";
import { listCronjobs } from "./tools/listCronjobs.js";
import { listRecentFailures } from "./tools/listRecentFailures.js";

type ToolResponse = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export interface ServerOptions {
  /** Configuration loaded at startup; used to explain errors and to refuse calls while it is broken. */
  setup?: Setup;
}

export function createServer(reader: ClusterReader, options: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: "k8s-cronjob-mcp", version: "1.0.0" });
  const setup = options.setup;
  const clientName = () => server.server.getClientVersion()?.name;

  async function respond(work: () => Promise<unknown>): Promise<ToolResponse> {
    if (setup && hasFatal(setup.problems)) {
      const fixes = setup.problems
        .filter((p) => p.severity === "error")
        .map((p) => formatProblem(p, clientName()))
        .join("\n\n");
      return {
        content: [{ type: "text", text: `k8s-cronjob-mcp is not set up correctly (no cluster call was made):\n\n${fixes}` }],
        isError: true,
      };
    }
    try {
      const result = await work();
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const message = describeError(err, { info: setup?.info, clientName: clientName() });
      return { content: [{ type: "text", text: message }], isError: true };
    }
  }

  server.registerTool(
    "check_setup",
    {
      description:
        "Check this server's configuration step by step (kubeconfig, context, auth helper, timezone, cluster reachability and read access to each resource) in the exact environment the MCP client runs it in. For every problem it says what is wrong, which environment variable to set and where. Run this first whenever another tool reports a configuration, permission or connection error. Read-only.",
      inputSchema: {},
    },
    async () => {
      if (!setup) {
        return { content: [{ type: "text", text: "No setup information available." }], isError: true };
      }
      const report = await runChecks(setup, clientName());
      return { content: [{ type: "text", text: report.text }], isError: !report.ok };
    },
  );

  server.registerTool(
    "get_cronjob_status",
    {
      description:
        "Check whether a CronJob is running on schedule. Compares its cron schedule against the actual last scheduled run and returns a verdict: on-schedule, late, missed, currently running (or suspended), plus the next run time and whether runs take longer than the schedule interval (overrun: skipped, late or overlapping runs).",
      inputSchema: {
        namespace: z.string().describe("Namespace of the CronJob"),
        name: z.string().describe("Name of the CronJob"),
      },
    },
    (args) => respond(() => getCronjobStatus(reader, args)),
  );

  server.registerTool(
    "get_run_history",
    {
      description:
        "List retained Jobs for a CronJob (newest first) with start time, duration, status and pod exit code, plus a duration trend. Warns when history limits are too short to be useful.",
      inputSchema: {
        namespace: z.string().describe("Namespace of the CronJob"),
        name: z.string().describe("Name of the CronJob"),
        limit: z.number().int().min(1).max(100).default(10).describe("Max runs to return"),
      },
    },
    (args) => respond(() => getRunHistory(reader, args)),
  );

  server.registerTool(
    "find_silent_failures",
    {
      description:
        "Scan CronJobs (one namespace or all) for ones with no successful run in the last N days, even if nothing is erroring right now. Returns the CronJobs needing attention, most urgent first, with the pattern (failing, stalled, never-succeeded), time since last success and last failure. Also catches CronJobs that stopped firing after a recent success, reports CronJobs whose runs outlast their schedule interval as degraded, and flags at-risk ones whose runs use more than 80% of it. Suspended CronJobs are listed briefly. Every result says what time window and runs it is based on.",
      inputSchema: {
        namespace: z.string().optional().describe("Namespace to scan; omit for all namespaces"),
        days: z.number().min(0.01).max(365).default(7).describe("Flag CronJobs with no success in this many days"),
        limit: z.number().int().min(1).max(500).default(50).describe("Max findings to return"),
        include_suspended: z.boolean().default(false).describe("Return suspended CronJobs as full findings instead of a short list"),
      },
    },
    (args) => respond(() => findSilentFailures(reader, args)),
  );

  server.registerTool(
    "get_failure_details",
    {
      description:
        "Explain why a Job failed. Finds its pods, reads container exit state, Kubernetes Events and a log tail (secrets masked), and returns a synthesized cause such as 'container OOMKilled at 340Mi, exit code 137' followed by the evidence.",
      inputSchema: {
        namespace: z.string().describe("Namespace of the Job"),
        job_name: z.string().describe("Name of the failed Job (e.g. from get_run_history)"),
        tail_lines: z.number().int().min(1).max(500).default(40).describe("Log lines to return"),
      },
    },
    (args) => respond(() => getFailureDetails(reader, args)),
  );

  server.registerTool(
    "list_active_runs",
    {
      description:
        "List Jobs that are running right now (one namespace or all), including Jobs not created by a CronJob. For each: owning CronJob, start time, how long it has been running, pod counts, deadline, and whether it is taking more than twice its typical duration. Longest-running and overdue Jobs first.",
      inputSchema: {
        namespace: z.string().optional().describe("Namespace to list; omit for all namespaces"),
        limit: z.number().int().min(1).max(500).default(50).describe("Max runs to return"),
      },
    },
    (args) => respond(() => listActiveRuns(reader, args)),
  );

  server.registerTool(
    "list_cronjobs",
    {
      description:
        "Overview of every CronJob (one namespace or all), one compact row each: schedule, effective timezone, health (failing, stalled, never-succeeded, degraded, overrunning, at-risk, healthy, suspended), next run, last scheduled run, last success and last result. Worst first. Use this to see what exists before drilling into one CronJob.",
      inputSchema: {
        namespace: z.string().optional().describe("Namespace to list; omit for all namespaces"),
        include_suspended: z.boolean().default(true).describe("Include suspended CronJobs in the rows (they are always counted)"),
        days: z.number().min(0.01).max(365).default(7).describe("Window for judging 'no recent success'"),
        limit: z.number().int().min(1).max(500).default(200).describe("Max rows to return"),
      },
    },
    (args) => respond(() => listCronjobs(reader, args)),
  );

  server.registerTool(
    "list_recent_failures",
    {
      description:
        "List Jobs that failed in the last N hours (one namespace or all), newest first, each with a synthesized cause (e.g. OOMKilled, exit code, image pull, deadline) and whether a later run of the same CronJob has succeeded since. Includes Jobs not created by a CronJob. Use get_failure_details for logs and events of one failure.",
      inputSchema: {
        namespace: z.string().optional().describe("Namespace to scan; omit for all namespaces"),
        hours: z.number().min(0.1).max(720).default(24).describe("Look back this many hours"),
        limit: z.number().int().min(1).max(200).default(50).describe("Max failures to inspect and return"),
      },
    },
    (args) => respond(() => listRecentFailures(reader, args)),
  );

  return server;
}
