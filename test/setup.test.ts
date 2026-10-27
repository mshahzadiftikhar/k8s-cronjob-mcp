import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clusterLabel, configLocations, findOnPath, formatProblem, hasFatal, loadSetup, shortTarget, whereToSet } from "../src/setup.js";

const dir = mkdtempSync(join(tmpdir(), "k8s-cronjob-mcp-test-"));

function kubeconfig(name: string, opts: { contexts?: string[]; current?: string; exec?: string } = {}): string {
  const contexts = opts.contexts ?? ["dev"];
  let user = "    token: abc";
  if (opts.exec) {
    user = `    exec:\n      apiVersion: client.authentication.k8s.io/v1beta1\n      command: ${opts.exec}\n      args: ["token"]`;
  }
  const yaml = `apiVersion: v1
kind: Config
clusters:
${contexts.map((c) => `- name: ${c}-cluster\n  cluster:\n    server: https://${c}.example.com:6443`).join("\n")}
users:
- name: me
  user:
${user}
contexts:
${contexts.map((c) => `- name: ${c}\n  context:\n    cluster: ${c}-cluster\n    user: me\n    namespace: ${c}-team`).join("\n")}
current-context: ${opts.current ?? contexts[0]}
`;
  const path = join(dir, name);
  writeFileSync(path, yaml);
  return path;
}

describe("loadSetup", () => {
  it("accepts a valid kubeconfig and pinned context", () => {
    const path = kubeconfig("ok.yaml", { contexts: ["dev", "prod"] });
    const s = loadSetup({ KUBECONFIG: path, K8S_CONTEXT: "dev", PATH: "/usr/bin" });
    expect(s.problems).toEqual([]);
    expect(s.info).toMatchObject({
      context: "dev",
      contextSource: "K8S_CONTEXT",
      contextNamespace: "dev-team",
      cluster: { server: "https://dev.example.com:6443" },
      auth: "token",
      defaultTimeZone: "UTC",
    });
  });

  it("rejects ~ in KUBECONFIG and suggests the full path", () => {
    const s = loadSetup({ KUBECONFIG: "~/.kube/config" });
    expect(hasFatal(s.problems)).toBe(true);
    expect(s.problems[0]).toMatchObject({ check: "Kubeconfig", variable: "KUBECONFIG" });
    expect(s.problems[0]?.what).toMatch(/not expanded/);
    expect(s.problems[0]?.example).not.toContain("~");
  });

  it("reports a missing kubeconfig file", () => {
    const s = loadSetup({ KUBECONFIG: join(dir, "nope.yaml") });
    expect(s.problems[0]?.what).toMatch(/KUBECONFIG file not found/);
  });

  it("lists available contexts when K8S_CONTEXT is wrong, without picking one", () => {
    const path = kubeconfig("ctx.yaml", { contexts: ["dev", "demo", "prod"] });
    const s = loadSetup({ KUBECONFIG: path, K8S_CONTEXT: "dev-cluster" });
    expect(s.problems[0]).toMatchObject({ check: "Context", variable: "K8S_CONTEXT", example: "<one of the above>" });
    expect(s.problems[0]?.fix[0]).toBe("Use one of: dev, demo, prod");
  });

  it("warns when several contexts exist and K8S_CONTEXT is unset", () => {
    const path = kubeconfig("multi.yaml", { contexts: ["dev", "prod"], current: "prod" });
    const s = loadSetup({ KUBECONFIG: path });
    expect(hasFatal(s.problems)).toBe(false);
    expect(s.problems[0]).toMatchObject({ severity: "warning", variable: "K8S_CONTEXT", example: "prod" });
    expect(s.problems[0]?.what).toBe('Not pinned: follows your kubectl current-context ("prod")');
    expect(s.problems[0]?.fix[0]).toMatch(/others: dev/);
  });

  it("detects a login helper that is not on PATH", () => {
    const path = kubeconfig("exec.yaml", { exec: "aws-not-installed-here" });
    const s = loadSetup({ KUBECONFIG: path, PATH: "/usr/bin:/bin" });
    expect(s.problems[0]).toMatchObject({ check: "Login", variable: "PATH", detail: "PATH=/usr/bin:/bin" });
    expect(s.problems[0]?.what).toMatch(/"aws-not-installed-here".*not on this server's PATH/);
  });

  it("finds a login helper that is on PATH", () => {
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "fake-auth"), "#!/bin/sh\n");
    chmodSync(join(bin, "fake-auth"), 0o755);
    const path = kubeconfig("exec-ok.yaml", { exec: "fake-auth" });
    const s = loadSetup({ KUBECONFIG: path, PATH: `/usr/bin:${bin}` });
    expect(s.problems).toEqual([]);
    expect(s.info.execCommandPath).toBe(join(bin, "fake-auth"));
    expect(findOnPath("fake-auth", "/usr/bin")).toBeUndefined();
  });

  it("rejects an invalid CRON_DEFAULT_TIMEZONE", () => {
    const path = kubeconfig("tz.yaml");
    const s = loadSetup({ KUBECONFIG: path, CRON_DEFAULT_TIMEZONE: "Mars/Olympus" });
    expect(s.problems[0]).toMatchObject({ check: "Timezone", variable: "CRON_DEFAULT_TIMEZONE", example: "UTC" });
  });
});

describe("display helpers", () => {
  it("labels EKS clusters by name and region instead of the endpoint URL", () => {
    const info = loadSetup({ KUBECONFIG: kubeconfig("label.yaml") }).info;
    info.cluster = { name: "arn:aws:eks:eu-west-2:123:cluster/gbggo4-nonprod", server: "https://F0F5.gr7.eu-west-2.eks.amazonaws.com" };
    expect(clusterLabel(info)).toBe("EKS gbggo4-nonprod (eu-west-2)");
    expect(shortTarget(info)).toMatch(/^context dev \(not pinned\) · EKS gbggo4-nonprod \(eu-west-2\) · /);
  });
});

describe("where to set a variable", () => {
  it("shows only Claude Desktop for Claude Desktop", () => {
    const w = configLocations("claude-ai", "darwin", "K8S_CONTEXT", "dev");
    expect(w).toEqual(['Claude Desktop: ~/Library/Application Support/Claude/claude_desktop_config.json → "env" of this server (then Cmd+Q and reopen)']);
  });
  it("shows the claude mcp add command for Claude Code", () => {
    expect(whereToSet("K8S_CONTEXT", "dev", "claude-code")).toMatch(/claude mcp add k8s-cronjobs -e K8S_CONTEXT=dev/);
  });
  it("shows both, briefly, when the client is unknown", () => {
    const w = configLocations(undefined, "win32");
    expect(w).toHaveLength(2);
    expect(w[0]).toMatch(/%APPDATA%/);
    expect(w[1]).toMatch(/Claude Code/);
  });
  it("formats a short problem block", () => {
    const text = formatProblem(
      { severity: "error", check: "Context", what: "bad", detail: "raw   error\ntext", fix: ["do x", "then y"], variable: "K8S_CONTEXT", example: "dev" },
      "claude-ai",
    );
    const lines = text.split("\n");
    expect(lines[0]).toBe("✗ bad");
    expect(lines[1]).toBe("  Error: raw error text");
    expect(lines[2]).toBe("  Fix:   do x");
    expect(lines[3]).toBe("         then y");
    expect(lines[4]).toBe("  Set:   K8S_CONTEXT=dev");
    expect(lines[5]).toMatch(/^ {9}Claude Desktop: /);
    expect(lines).toHaveLength(6);
  });
});
