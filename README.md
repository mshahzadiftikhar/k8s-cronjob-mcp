# k8s-cronjob-mcp

A **read-only** MCP server that lets an AI agent triage Kubernetes CronJobs: did it run, is it getting slower, has it quietly stopped succeeding, and why did that run fail?

General-purpose Kubernetes MCP servers expose CronJobs as just another resource type, so an agent has to fetch the CronJob, its Jobs, pods, Events and logs separately and then work out cron schedules, timezones and history limits itself. This server does that reasoning in tested code and returns a verdict with the evidence behind it, in one tool call, with zero write access to the cluster.

### Where it fits

- **Use it for:** on-demand triage. *"Which CronJobs in `batch` haven't succeeded this week, and why?"* *"Is the nightly report job running late?"* *"Why did last night's run fail?"*
- **It is not alerting.** It only looks when an agent asks. Keep your existing alerts (for example Prometheus with kube-state-metrics' `kube_cronjob_status_last_successful_time`, or a dead-man's-switch service) to learn *that* something broke; use this server to find out *what* and *why*.

## Tools

| Tool | What it answers |
| --- | --- |
| `check_setup()` | Is the server set up correctly? Checks kubeconfig, context, auth helper, timezone, cluster reachability and read access to each resource, in the exact environment your MCP client runs it in. Every problem comes with the variable to set and where. |
| `list_cronjobs(namespace?, include_suspended=true)` | What CronJobs are there and how are they doing? One compact row each, worst first: schedule, effective timezone, health (`failing`, `stalled`, `never-succeeded`, `degraded`, `overrunning`, `at-risk`, `healthy`, `suspended`), next run, last success and last result. |
| `get_cronjob_status(namespace, name)` | Is it on schedule? Verdict: `on-schedule`, `late`, `missed`, `currently running` (or `suspended`), plus the next run time and an overrun check (are runs taking longer than the schedule interval?). |
| `get_run_history(namespace, name, limit=10)` | Retained Jobs, newest first: start, duration, status (`Succeeded`/`Failed`/`DeadlineExceeded`), pod exit code, plus a duration trend ("30% slower…"). Warns when history limits are too short to be useful. |
| `find_silent_failures(namespace?, days=7, limit=50, include_suspended=false)` | **The flagship.** CronJobs with no successful run in N days even if nothing is erroring right now, CronJobs that have stopped firing, CronJobs whose runs outlast their schedule, and `at-risk` ones close to it, ranked by urgency, with the pattern (`failing`, `stalled`, `never-succeeded`). Suspended CronJobs are listed separately, one short line each. |
| `list_recent_failures(namespace?, hours=24, limit=50)` | What failed recently? Every failed Job in the window (including ones not created by a CronJob), newest first, each with its synthesized cause and whether a later run of the same CronJob has succeeded since. |
| `get_failure_details(namespace, job_name, tail_lines=40)` | Why a Job failed. A synthesized cause (e.g. `Container "main" OOMKilled at 340Mi, exit code 137`) first, then pod state, Events and a log tail. |
| `list_active_runs(namespace?, limit=50)` | What is running right now? Unfinished Jobs (including ones not created by a CronJob), longest-running first, with owning CronJob, elapsed time, pod counts, retries, deadline, and a `longRunning` flag when a run takes more than 2× its typical duration. |

### How the verdicts work

- **Timezone.** Schedules are evaluated in `spec.timeZone` when set, otherwise in UTC, which is what the kube-controller-manager almost always uses. The timezone of the machine running this server is never used. If your controller runs in another timezone, set `CRON_DEFAULT_TIMEZONE`.
- **Schedule check.** The expected last fire time is computed from `spec.schedule`. The actual last run comes from the `batch.kubernetes.io/cronjob-scheduled-timestamp` annotation on Jobs where available (Kubernetes 1.32+), falling back to `status.lastScheduleTime`. A run due less than 60s ago is still `on-schedule`; after that it is `late` until `startingDeadlineSeconds`, then `missed`. If `startingDeadlineSeconds` is unset, Kubernetes itself has no deadline; the server uses a 300s cutoff as a heuristic and says so in the verdict.
- **Stopped firing.** If no run has started for 3 or more scheduled fire times (and none is active), the CronJob is reported as `stalled`, even if it succeeded recently. This catches a frequent job that stopped an hour ago without waiting for the `days` window.
- **Overrun.** Compares the median duration of recent runs (and any active run) with the shortest gap between scheduled fire times. A CronJob whose runs use more than 80% of that gap is reported as `at-risk` (one slow run away from overrunning). A CronJob whose runs outlast that gap is reported as `degraded`/`overrunning`, with the effect of its `concurrencyPolicy`: with `Forbid`, scheduled runs are skipped or start late; with `Allow`, runs overlap; with `Replace`, runs are cancelled before they finish. Late starts (more than 60s after the scheduled time) are counted as supporting evidence.
- **Silent failures.** "Last success" is the later of `status.lastSuccessfulTime` (which survives Job deletion) and retained Jobs. The window is `max(days, 2 × the schedule's cadence)`, so a weekly job is not flagged by a 7-day window. A brand-new CronJob that has not failed is not flagged. Suspended CronJobs are never reported as failures; `find_silent_failures` lists them separately (name and last success) unless `include_suspended=true`.
- **Failure cause.** Checked in order: OOMKilled, DeadlineExceeded, image pull errors, container config errors, eviction, non-zero exit code (with hints such as 127 = command not found), unschedulable, then the most relevant warning Event. When a Job's pods are already gone, the cause falls back to what the Job object still records (failure reason and message, number of failed pods) and says why the evidence is missing, for example `ttlSecondsAfterFinished`.
- **Every answer says what it is based on.** Each result has `asOf` (when it was computed) and `basis`, one sentence such as "Failed Jobs that finished in the last 3 days, from only the Jobs Kubernetes still keeps" or "median of last 2 successful runs". When `ALLOWED_NAMESPACES` is set, `scope` shows those namespaces instead of "all namespaces".

## Read-only by construction

This is deliberate and enforced in two independent places:

1. **Code.** The only Kubernetes calls are `get`/`list`/log reads. The `ClusterReader` interface in [src/k8s/client.ts](src/k8s/client.ts) has no create/patch/delete/exec method for a tool to call.
2. **RBAC.** [deploy/rbac.yaml](deploy/rbac.yaml) grants `get`/`list`/`watch` on exactly `cronjobs`, `jobs`, `pods`, `pods/log` and `events`. Nothing else: no secrets, no `pods/exec`, no write verbs. `npm run check:rbac` asserts this against a real cluster (52 checks: reads allowed, every write denied).

Also worth knowing:

- Set `ALLOWED_NAMESPACES=a,b` to confine the server to specific namespaces; anything else is refused before any API call. This is enforced by the server, not by Kubernetes: the bundled RBAC is a ClusterRole, so the ServiceAccount itself can still read pods and logs cluster-wide. If you need Kubernetes to enforce the boundary, bind the same rules with a namespaced Role and RoleBinding in each namespace instead.
- Log tails are passed through a best-effort secret masker (passwords, tokens, API keys, bearer tokens). It is pattern-based and **will not catch everything**; treat logs as potentially sensitive.
- Job and pod data comes from live cluster state. There is no database. What you can see is bounded by `successfulJobsHistoryLimit`/`failedJobsHistoryLimit`, and Events expire after about an hour by default.

## Install and use

Requires Node 20+. No install step is needed; `npx` fetches it on demand.

Add it to Claude Code (stdio):

```bash
claude mcp add k8s-cronjobs -e K8S_CONTEXT=my-context -- npx -y k8s-cronjob-mcp
```

Or to any MCP client config:

```json
{
  "mcpServers": {
    "k8s-cronjobs": {
      "command": "npx",
      "args": ["-y", "k8s-cronjob-mcp"],
      "env": {
        "K8S_CONTEXT": "my-context",
        "ALLOWED_NAMESPACES": "batch,reports"
      }
    }
  }
}
```

| Variable | Meaning |
| --- | --- |
| `KUBECONFIG` | Standard kubeconfig lookup, or in-cluster config when running in a pod. |
| `K8S_CONTEXT` | Context to use instead of the kubeconfig's current one. **Set this explicitly** so the server cannot silently target the wrong cluster. |
| `ALLOWED_NAMESPACES` | Optional comma-separated allowlist. |
| `CRON_DEFAULT_TIMEZONE` | Timezone for CronJobs that do not set `spec.timeZone`. Defaults to `UTC`; only set it if your kube-controller-manager runs in another timezone. |

To run from source instead: `npm install && npm run build`, then use `node /absolute/path/to/dist/index.js` as the command.

To give the server its own least-privilege identity, apply [deploy/rbac.yaml](deploy/rbac.yaml) and build a kubeconfig from the `k8s-cronjob-mcp` ServiceAccount (see [scripts/sa-kubeconfig.sh](scripts/sa-kubeconfig.sh) for an example).

### Get more out of it: raise history limits

By default Kubernetes keeps only the last **3** successful and **1** failed Job per CronJob. That is too little evidence for useful answers: duration trends need at least 4 successful runs, and consecutive failures cannot be counted past 1. For the CronJobs you care about, raise the limits:

```yaml
spec:
  successfulJobsHistoryLimit: 10
  failedJobsHistoryLimit: 5
```

`get_run_history` warns when a CronJob's limits are too low.

## Troubleshooting

Errors are short: what went wrong, the underlying error, what the server is using, and the fix. When a setting fixes it, the error names the variable, the value and the file to put it in. For example:

```text
✗ No permission to read across all namespaces (403)
  Error: cronjobs.batch is forbidden: User "you@example.com" cannot list resource "cronjobs" ... at the cluster scope
  Using: context dev (pinned) · EKS dev-cluster (eu-west-2) · ~/.kube/config
  Fix:   Limit the server to namespaces you can read
         Check one: kubectl auth can-i list cronjobs -n <namespace>
  Set:   ALLOWED_NAMESPACES=team-a
         Claude Desktop: ~/Library/Application Support/Claude/claude_desktop_config.json → "env" of this server (then Cmd+Q and reopen)
```

To check everything step by step:

- **From your agent:** ask it to run `check_setup`. This is the most accurate check, because it runs with the same environment as your MCP client (which, for desktop apps, is not your shell's environment).
- **From a terminal:** `npx -y k8s-cronjob-mcp --check` (exit code 0 when everything passes).

If the configuration is broken at startup (for example a wrong `K8S_CONTEXT`), the server still starts and every tool returns the fix instead of failing silently. The startup summary and any problems are also written to the client's server log (Claude Desktop: `~/Library/Logs/Claude/mcp-server-k8s-cronjobs.log`).

| Symptom | Cause | Fix |
| --- | --- | --- |
| `KUBECONFIG ... starts with "~"` | MCP clients do not expand `~` | Use the absolute path |
| `K8S_CONTEXT=... is not in the kubeconfig` | Cluster name used instead of context name | Use the NAME column of `kubectl config get-contexts` |
| `... is not on this server's PATH` | Desktop apps do not load your shell profile, so `aws`, `gke-gcloud-auth-plugin`, `kubelogin` or `npx` are not found | Add a `PATH` entry to the server's `env` (from `which <tool>`), or use the full path to `npx` as `command` |
| `403 ... at the cluster scope` | You can read only some namespaces | Set `ALLOWED_NAMESPACES` |
| `401 Unauthorized` | Expired login or token | Log in again with your cloud CLI, or create a new ServiceAccount token |
| `Could not reach https://...` | Cluster down, VPN off, or wrong context | Check connectivity, or change `K8S_CONTEXT` |

## Try it on a local cluster

The demo uses [kind](https://kind.sigs.k8s.io/) and a repo-local kubeconfig (`.kube/`). The scripts never read your `$KUBECONFIG` and refuse to continue unless the context is a `kind-*` cluster, so no other cluster is touched.

```bash
npm run demo:up           # kind cluster + demo CronJobs + RBAC
npm run check:rbac        # prove the role is read-only
npm run test:integration  # runs every tool as the read-only ServiceAccount
npm run demo:down
```

The demo namespace contains: `healthy`, `flaky` (fails randomly), `always-failing` (the silent failure), `paused` (suspended), `slowing` (duration trend) and `oom` (OOMKilled). Give the CronJobs a few minutes (they fire every 2 minutes), then ask an agent: *"Which CronJobs in `demo` are failing silently, and why?"*

## Development

```bash
npm test          # unit tests (no cluster needed)
npm run typecheck
npm run dev       # run from source over stdio
```

The logic lives in `src/analysis/` as pure functions over Kubernetes objects, so it is tested with fixtures. `src/tools/` is thin glue.

## Publishing

See [PUBLISHING.md](PUBLISHING.md) for the npm release checklist.

## Known limitations

- Only retained Jobs are visible, so consecutive-failure counts are capped by `failedJobsHistoryLimit`. A CronJob with a history limit of 0 leaves no evidence; the tools say so rather than reporting it as healthy.
- Trends need at least 4 successful runs (see [raise history limits](#get-more-out-of-it-raise-history-limits)). The overrun check works from 1 finished run but is more reliable with more.
- `list_recent_failures` only sees failed Jobs Kubernetes still retains; failures removed by history limits or `ttlSecondsAfterFinished` are gone.

## Roadmap

- A namespaced Role/RoleBinding option in `deploy/`.
- Optional Prometheus source for run history beyond the retained Jobs.
- `compare_runs`, an HTTP transport and a Helm chart.
