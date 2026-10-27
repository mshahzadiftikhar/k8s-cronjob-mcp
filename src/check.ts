import * as k8s from "@kubernetes/client-node";
import { describeError } from "./errors.js";
import { clusterLabel, configLocations, hasFatal, tildify, type Setup, type SetupProblem } from "./setup.js";

export interface CheckResult {
  status: "ok" | "warn" | "fail" | "skipped";
  check: string;
  detail: string;
}

export interface CheckReport {
  ok: boolean;
  results: CheckResult[];
  text: string;
}

const MARKS = { ok: "✓", warn: "!", fail: "✗", skipped: "-" } as const;

/**
 * Step-by-step setup check: static configuration first, then live, read-only
 * calls (limit=1) for each resource the tools need. Never writes to the cluster.
 *
 * Output is built to be scanned: one line per check, then a short numbered
 * list of fixes, then one line on where settings live.
 */
export async function runChecks(setup: Setup, clientName?: string): Promise<CheckReport> {
  const { info, problems, kc } = setup;
  const results: CheckResult[] = [];
  const fixes: string[] = [];

  const add = (status: CheckResult["status"], check: string, detail: string) => {
    results.push({ status, check, detail });
  };
  /** Record a fix as a short numbered item; identical fixes are listed once. */
  const addFix = (label: string, lines: string[]) => {
    const body = lines.join("\n");
    if (!fixes.some((f) => f.endsWith(body))) {
      fixes.push(`${label}\n${body}`);
    }
  };
  const fixLines = (p: SetupProblem): string[] => {
    const lines = p.fix.map((s) => `   ${s}`);
    if (p.variable) {
      lines.push(`   Set: ${p.variable}=${p.example ?? "<value>"}`);
    }
    return lines;
  };
  /** Report a configuration problem, or the ok line when there is none. */
  const report = (check: string, okDetail: string | undefined): boolean => {
    const found = problems.filter((p) => p.check === check);
    const worst = found.find((p) => p.severity === "error") ?? found[0];
    if (worst) {
      add(worst.severity === "error" ? "fail" : "warn", check, worst.what);
      addFix(check, fixLines(worst));
      return worst.severity !== "error";
    }
    if (okDetail !== undefined) {
      add("ok", check, okDetail);
    }
    return true;
  };

  let kubeconfig = info.kubeconfigFiles.map(tildify).join(", ") || "(none)";
  if (info.kubeconfigSource === "KUBECONFIG") {
    kubeconfig += " (from KUBECONFIG)";
  } else if (info.kubeconfigSource === "in-cluster") {
    kubeconfig = "in-cluster service account";
  }
  report("Kubeconfig", kubeconfig);
  if (info.contexts.length > 0 || problems.some((p) => p.check === "Context")) {
    report("Context", info.context ? `${info.context} (pinned)` : undefined);
  }
  if (info.cluster) {
    add("ok", "Cluster", clusterLabel(info));
  }
  if (info.auth) {
    let login = info.auth;
    if (info.execCommand) {
      login = `${info.execCommand} (${info.execCommandPath ?? "not found"})`;
      if (info.exec?.awsProfile) {
        login += `, AWS profile ${info.exec.awsProfile}`;
      }
    }
    report("Login", login);
  }
  const scope = `${info.allowedNamespaces ? info.allowedNamespaces.join(", ") : "all namespaces"} · schedules in ${info.defaultTimeZone}`;
  if (!problems.some((p) => p.check === "Timezone")) {
    add("ok", "Scope", scope);
  } else {
    report("Timezone", undefined);
  }

  const ctx = { info, clientName };
  /** Run a live call; on failure, record a one-line status and the short fix. */
  const fail = (check: string, err: unknown) => {
    const text = describeError(err, ctx);
    const lines = text.split("\n");
    const what = (lines[0] ?? "").replace(/^[✗!] /, "");
    add("fail", check, what);
    // Keep the error and fix lines; the context/cluster are already listed above.
    const body = lines
      .slice(1)
      .filter((l) => !l.startsWith("  Using:") && !/^ {9}(Claude|Other)/.test(l))
      .map((l) => ` ${l.replace(/^ {2}(Fix: {2}| {6})/, "  ").replace(/^ {2}Set: {3}/, "  Set: ")}`);
    addFix(check, body);
  };

  if (hasFatal(problems) || !kc) {
    add("skipped", "Connection", "not checked until the problems above are fixed");
    return finish(results, fixes, clientName);
  }

  try {
    const version = await kc.makeApiClient(k8s.VersionApi).getCode();
    add("ok", "Connection", `Kubernetes ${version.gitVersion}`);
  } catch (err) {
    fail("Connection", err);
    add("skipped", "Access", "not checked until the cluster is reachable");
    return finish(results, fixes, clientName);
  }

  const batch = kc.makeApiClient(k8s.BatchV1Api);
  const core = kc.makeApiClient(k8s.CoreV1Api);
  const scopes: (string | undefined)[] = info.allowedNamespaces ?? [undefined];
  for (const ns of scopes) {
    const where = ns ?? "all namespaces";
    const probes: { label: string; run: () => Promise<unknown> }[] = ns
      ? [
          { label: "cronjobs", run: () => batch.listNamespacedCronJob({ namespace: ns, limit: 1 }) },
          { label: "jobs", run: () => batch.listNamespacedJob({ namespace: ns, limit: 1 }) },
          { label: "pods", run: () => core.listNamespacedPod({ namespace: ns, limit: 1 }) },
          { label: "events", run: () => core.listNamespacedEvent({ namespace: ns, limit: 1 }) },
        ]
      : [
          { label: "cronjobs", run: () => batch.listCronJobForAllNamespaces({ limit: 1 }) },
          { label: "jobs", run: () => batch.listJobForAllNamespaces({ limit: 1 }) },
          { label: "pods", run: () => core.listPodForAllNamespaces({ limit: 1 }) },
          { label: "events", run: () => core.listEventForAllNamespaces({ limit: 1 }) },
        ];

    const ok: string[] = [];
    const denied: string[] = [];
    let firstError: unknown = undefined;
    let firstPod: { namespace: string; name: string } | undefined = undefined;
    for (const probe of probes) {
      try {
        const res = (await probe.run()) as { items?: { metadata?: { name?: string; namespace?: string } }[] };
        ok.push(probe.label);
        const item = res.items?.[0];
        if (probe.label === "pods" && item?.metadata?.name) {
          firstPod = { namespace: item.metadata.namespace ?? ns ?? "", name: item.metadata.name };
        }
      } catch (err) {
        denied.push(probe.label);
        firstError ??= err;
      }
    }
    let logs = "logs not tested (no pod)";
    if (firstPod) {
      try {
        await core.readNamespacedPodLog({ namespace: firstPod.namespace, name: firstPod.name, tailLines: 1, limitBytes: 256 });
        ok.push("logs");
        logs = "";
      } catch (err) {
        if ((err as { code?: unknown }).code === 400) {
          ok.push("logs");
          logs = "";
        } else {
          denied.push("logs");
          firstError ??= err;
          logs = "";
        }
      }
    }

    const label = `Access (${where})`;
    if (denied.length === 0) {
      add("ok", label, `can read ${ok.join(", ")}${logs ? `; ${logs}` : ""}`);
    } else {
      fail(label, firstError);
      const last = results[results.length - 1];
      if (last) {
        last.detail = `can't read ${denied.join(", ")}: ${last.detail}`;
      }
    }
  }

  return finish(results, fixes, clientName);
}

function finish(results: CheckResult[], fixes: string[], clientName?: string): CheckReport {
  const width = Math.max(...results.map((r) => r.check.length)) + 2;
  const lines = ["k8s-cronjob-mcp setup check", ""];
  for (const r of results) {
    lines.push(`${MARKS[r.status]} ${r.check.padEnd(width)}${r.detail}`);
  }

  const failures = results.filter((r) => r.status === "fail").length;
  const warnings = results.filter((r) => r.status === "warn").length;
  if (fixes.length > 0) {
    lines.push("", "To fix:");
    fixes.forEach((f, i) => {
      const [label, ...body] = f.split("\n");
      lines.push(` ${i + 1}. ${label}`);
      lines.push(...body.map((b) => `  ${b.replace(/^ +/, " ")}`));
    });
    const locations = configLocations(clientName);
    lines.push("", "Settings are env variables of this MCP server:");
    lines.push(...locations.map((l) => `  ${l}`));
  }

  let summary = "All checks passed.";
  if (failures > 0) {
    summary = `${failures} problem(s)${warnings > 0 ? `, ${warnings} warning(s)` : ""}.`;
  } else if (warnings > 0) {
    summary = `Working, ${warnings} warning(s).`;
  }
  lines.push("", summary);
  return { ok: failures === 0, results, text: lines.join("\n") };
}
