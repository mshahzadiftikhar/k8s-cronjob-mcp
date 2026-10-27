import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSetup } from "../src/setup.js";
import { describeError, NamespaceNotAllowedError, NotFoundError } from "../src/errors.js";

const dir = mkdtempSync(join(tmpdir(), "k8s-cronjob-mcp-errors-"));

function kubeconfig(name: string, opts: { exec?: string; execEnvProfile?: string; contexts?: string[]; server?: string } = {}): string {
  const path = join(dir, name);
  const contexts = opts.contexts ?? ["dev"];
  let user = "    token: abc";
  if (opts.exec) {
    user = `    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: ${opts.exec}
      args: ["--region", "eu-central-1", "eks", "get-token", "--cluster-name", "nonprod-eu"]${
        opts.execEnvProfile ? `\n      env:\n      - name: AWS_PROFILE\n        value: ${opts.execEnvProfile}` : ""
      }`;
  }
  writeFileSync(
    path,
    `apiVersion: v1
kind: Config
clusters:
- name: dev-cluster
  cluster:
    server: ${opts.server ?? "https://dev.example.com:6443"}
users:
- name: me
  user:
${user}
contexts:
${contexts.map((c) => `- name: ${c}\n  context:\n    cluster: dev-cluster\n    user: me\n    namespace: dev-team`).join("\n")}
current-context: ${contexts[0]}
`,
  );
  return path;
}

describe("describeError", () => {
  const info = loadSetup({ KUBECONFIG: kubeconfig("err.yaml"), K8S_CONTEXT: "dev" }).info;
  const ctx = { info, clientName: "claude-ai" };

  it("passes through not-found errors", () => {
    expect(describeError(new NotFoundError('CronJob "x" not found'))).toBe('CronJob "x" not found');
  });

  it("tells you to set ALLOWED_NAMESPACES on a cluster-scope 403, in a few lines", () => {
    const err = Object.assign(new Error("forbidden"), {
      code: 403,
      body: JSON.stringify({ message: 'cronjobs.batch is forbidden: User "me" cannot list resource "cronjobs" in API group "batch" at the cluster scope' }),
    });
    const text = describeError(err, ctx);
    expect(text.split("\n")[0]).toBe("✗ No permission to read across all namespaces (403)");
    expect(text).toMatch(/Error: cronjobs\.batch is forbidden/);
    expect(text).toMatch(/Using: context dev \(pinned\) · https:\/\/dev\.example\.com:6443 · /);
    expect(text).toMatch(/Set: {3}ALLOWED_NAMESPACES=dev-team/);
    expect(text).toMatch(/Claude Desktop: .*claude_desktop_config\.json → "env" of this server/);
    expect(text.split("\n").length).toBeLessThanOrEqual(8);
  });

  it("explains a namespaced 403 with the needed RBAC", () => {
    const err = Object.assign(new Error("forbidden"), { code: 403, body: { message: 'pods "x" is forbidden: cannot get resource "pods/log"' } });
    expect(describeError(err, ctx)).toMatch(/Permission denied \(403\)[\s\S]*pods\/log[\s\S]*rbac\.yaml/);
  });

  it("explains 401 for a static token", () => {
    expect(describeError(Object.assign(new Error("x"), { code: 401 }), ctx)).toMatch(/401[\s\S]*kubectl create token lasts 1 hour/);
  });

  it("explains a missing login helper", () => {
    const err = Object.assign(new Error("spawn aws ENOENT"), { code: "ENOENT", syscall: "spawn aws", path: "aws" });
    const text = describeError(err, ctx);
    expect(text).toMatch(/"aws" \(the kubeconfig's login command\) is not on this server's PATH/);
    expect(text).toMatch(/which aws/);
    expect(text).toMatch(/Set: {3}PATH=/);
  });

  it("explains an unreachable cloud cluster with VPN advice and other contexts", () => {
    const eks = loadSetup({ KUBECONFIG: kubeconfig("eks-net.yaml", { contexts: ["nonprod", "demo"], server: "https://F0F5.gr7.eu-west-2.eks.amazonaws.com" }) }).info;
    const err = new TypeError("fetch failed", { cause: Object.assign(new Error("connect timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" }) });
    const text = describeError(err, { info: eks, clientName: "claude-ai" });
    expect(text.split("\n")[0]).toBe("✗ Can't reach the cluster: connection timed out");
    expect(text).toMatch(/Connect to your VPN/);
    expect(text).not.toMatch(/kind|minikube/);
    expect(text).toMatch(/Test: kubectl --context nonprod get ns/);
    expect(text).toMatch(/Wrong cluster\? Set K8S_CONTEXT to demo/);
  });

  it("explains an unreachable local cluster", () => {
    const local = loadSetup({ KUBECONFIG: kubeconfig("local.yaml", { server: "https://127.0.0.1:6443" }), K8S_CONTEXT: "dev" }).info;
    const err = new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
    expect(describeError(err, { info: local })).toMatch(/connection refused[\s\S]*is Docker running/);
  });

  it("explains a namespace outside the allowlist and how to add it", () => {
    const text = describeError(new NamespaceNotAllowedError('Namespace "b" is not in the allowed list (a)', "b", ["a"]), ctx);
    expect(text).toMatch(/Namespace "b" is not in ALLOWED_NAMESPACES \(a\)/);
    expect(text).toMatch(/Set: {3}ALLOWED_NAMESPACES=a,b/);
  });

  it("falls back to the raw message plus a pointer to check_setup", () => {
    expect(describeError(new Error("something odd"), ctx)).toMatch(/Kubernetes request failed\n {2}Error: something odd[\s\S]*check_setup/);
  });
});

describe("login failures", () => {
  it("names the exact SSO command with the kubeconfig's profile", () => {
    const path = kubeconfig("sso.yaml", { exec: "aws", execEnvProfile: "nonprod-sso", contexts: ["gbggo4-demo", "gbggo4-nonprod"] });
    const info = loadSetup({ KUBECONFIG: path, PATH: "/usr/bin" }).info;
    const err = new Error("aws: [ERROR]: Error when retrieving token from sso: Token has expired and refresh failed");
    const lines = describeError(err, { info, clientName: "claude-ai" }).split("\n");
    expect(lines[0]).toBe("✗ AWS SSO session expired");
    expect(lines[1]).toMatch(/^ {2}Error: aws: \[ERROR\]: Error when retrieving token from sso/);
    expect(lines[2]).toMatch(/^ {2}Using: context gbggo4-demo \(not pinned\)/);
    expect(lines[3]).toBe("  Fix:   Run: aws sso login --profile nonprod-sso");
    expect(lines[4]).toBe("         Then ask again (no restart needed)");
    expect(lines).toHaveLength(5);
  });

  it("suggests AWS_PROFILE when aws finds no credentials and no profile is configured", () => {
    const info = loadSetup({ KUBECONFIG: kubeconfig("noprofile.yaml", { exec: "aws" }), PATH: "/usr/bin" }).info;
    const text = describeError(new Error("Unable to locate credentials. You can configure credentials by running aws configure."), { info });
    expect(text).toMatch(/AWS credentials not found/);
    expect(text).toMatch(/Set: {3}AWS_PROFILE=/);
  });

  it("uses the server's AWS_PROFILE when the kubeconfig sets none", () => {
    const info = loadSetup({ KUBECONFIG: kubeconfig("envprofile.yaml", { exec: "aws" }), PATH: "/usr/bin", AWS_PROFILE: "team-sso" }).info;
    expect(describeError(new Error("Error when retrieving token from sso: Token has expired"), { info })).toMatch(/aws sso login --profile team-sso/);
  });

  it("gives gcloud and az commands for GKE and AKS helpers", () => {
    const gke = loadSetup({ KUBECONFIG: kubeconfig("gke.yaml", { exec: "gke-gcloud-auth-plugin" }), PATH: "/usr/bin" }).info;
    expect(describeError(new Error("token expired"), { info: gke })).toMatch(/gcloud auth login/);
    const aks = loadSetup({ KUBECONFIG: kubeconfig("aks.yaml", { exec: "kubelogin" }), PATH: "/usr/bin" }).info;
    expect(describeError(new Error("failed to get token: auth expired"), { info: aks })).toMatch(/az login/);
  });
});
