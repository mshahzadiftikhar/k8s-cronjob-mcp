import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import * as k8s from "@kubernetes/client-node";

/**
 * Everything about how this server finds and talks to a cluster, worked out
 * once at startup so every error can say exactly which setting to change.
 */
export interface SetupInfo {
  kubeconfigFiles: string[];
  kubeconfigSource: "KUBECONFIG" | "default" | "in-cluster" | "none";
  contexts: string[];
  context?: string;
  contextSource: "K8S_CONTEXT" | "current-context" | "none";
  /** Namespace configured on the context, used to suggest ALLOWED_NAMESPACES. */
  contextNamespace?: string;
  cluster?: { name: string; server: string };
  user?: string;
  auth?: string;
  execCommand?: string;
  execCommandPath?: string;
  /** Details of the kubeconfig's exec login, used to give the exact login command. */
  exec?: ExecDetails;
  allowedNamespaces?: string[];
  defaultTimeZone: string;
  /** Raw values of the server's own settings, as the MCP client passed them. */
  env: Partial<Record<SettingName, string>>;
}

export const SETTINGS = ["K8S_CONTEXT", "KUBECONFIG", "ALLOWED_NAMESPACES", "CRON_DEFAULT_TIMEZONE", "AWS_PROFILE", "PATH"] as const;
export type SettingName = (typeof SETTINGS)[number];

export interface ExecDetails {
  command: string;
  args: string[];
  /** Profile the login command uses: from its env, its --profile flag, or the server's AWS_PROFILE. */
  awsProfile?: string;
  awsProfileSource?: "kubeconfig" | "server env";
  clusterName?: string;
  region?: string;
}

/**
 * One thing that is wrong, written to be scanned: a short sentence, the raw
 * error on its own line, then a few short fix steps.
 */
export interface SetupProblem {
  severity: "error" | "warning";
  /** Short label of the check, e.g. "Context". */
  check: string;
  /** One short sentence: what is wrong. */
  what: string;
  /** The underlying error message, if any (shown on one line). */
  detail?: string;
  /** Short steps, most important first. */
  fix: string[];
  /** Environment variable that fixes it, if one does. */
  variable?: string;
  /** Value to set it to. */
  example?: string;
}

export interface Setup {
  kc?: k8s.KubeConfig;
  info: SetupInfo;
  problems: SetupProblem[];
}

const SERVICEACCOUNT_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token";

export function parseList(raw: string | undefined): string[] | undefined {
  if (!raw) {
    return undefined;
  }
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (list.length === 0) {
    return undefined;
  }
  return list;
}

/** Shorten a path under the home directory to ~/... for display. */
export function tildify(path: string): string {
  const home = homedir();
  if (home && path.startsWith(`${home}/`)) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) {
      return false;
    }
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a command the way spawn() will, using the server's own PATH. */
export function findOnPath(command: string, pathValue: string | undefined, platform = process.platform): string | undefined {
  if (isAbsolute(command) || command.includes("/")) {
    if (isExecutable(command)) {
      return command;
    }
    return undefined;
  }
  let extensions = [""];
  if (platform === "win32") {
    extensions = ["", ".exe", ".cmd", ".bat"];
  }
  for (const dir of (pathValue ?? "").split(delimiter)) {
    if (!dir) {
      continue;
    }
    for (const ext of extensions) {
      const candidate = join(dir, command + ext);
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function flagValue(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === flag) {
      return args[i + 1];
    }
    if (a.startsWith(`${flag}=`)) {
      return a.slice(flag.length + 1);
    }
  }
  return undefined;
}

function execDetails(exec: { command: string; args?: string[]; env?: { name: string; value: string }[] }, env: NodeJS.ProcessEnv): ExecDetails {
  const args = (exec.args ?? []).map(String);
  const details: ExecDetails = {
    command: exec.command,
    args,
    clusterName: flagValue(args, "--cluster-name") ?? flagValue(args, "--cluster"),
    region: flagValue(args, "--region"),
  };
  const fromKubeconfig = exec.env?.find((e) => e.name === "AWS_PROFILE")?.value ?? flagValue(args, "--profile");
  if (fromKubeconfig) {
    details.awsProfile = fromKubeconfig;
    details.awsProfileSource = "kubeconfig";
  } else if (env.AWS_PROFILE) {
    details.awsProfile = env.AWS_PROFILE;
    details.awsProfileSource = "server env";
  }
  return details;
}

function describeAuth(user: k8s.User | null): { auth: string; execCommand?: string } {
  if (!user) {
    return { auth: "none" };
  }
  const exec = user.exec ?? user.authProvider?.config?.exec;
  if (exec?.command) {
    return { auth: `exec: ${exec.command}`, execCommand: exec.command };
  }
  if (user.authProvider) {
    return { auth: `auth-provider: ${user.authProvider.name}` };
  }
  if (user.token) {
    return { auth: "token" };
  }
  if (user.certData || user.certFile) {
    return { auth: "client certificate" };
  }
  if (user.username) {
    return { auth: "basic" };
  }
  return { auth: "none" };
}

/** "a, b or c" */
export function orList(items: string[]): string {
  if (items.length <= 1) {
    return items[0] ?? "";
  }
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

/** Load the kubeconfig and collect every configuration problem, without throwing. */
export function loadSetup(env: NodeJS.ProcessEnv = process.env): Setup {
  const home = homedir();
  const defaultPath = join(home, ".kube", "config");
  const problems: SetupProblem[] = [];
  const info: SetupInfo = {
    kubeconfigFiles: [],
    kubeconfigSource: "none",
    contexts: [],
    contextSource: "none",
    allowedNamespaces: parseList(env.ALLOWED_NAMESPACES),
    defaultTimeZone: env.CRON_DEFAULT_TIMEZONE?.trim() || "UTC",
    env: Object.fromEntries(SETTINGS.filter((k) => env[k] !== undefined && env[k] !== "").map((k) => [k, env[k] as string])),
  };

  if (!validTimeZone(info.defaultTimeZone)) {
    problems.push({
      severity: "error",
      check: "Timezone",
      what: `CRON_DEFAULT_TIMEZONE "${info.defaultTimeZone}" is not a valid timezone`,
      fix: ["Use an IANA name such as UTC or Europe/London, or remove it to use UTC"],
      variable: "CRON_DEFAULT_TIMEZONE",
      example: "UTC",
    });
  }

  const rawKubeconfig = env.KUBECONFIG?.trim();
  if (rawKubeconfig) {
    info.kubeconfigSource = "KUBECONFIG";
    info.kubeconfigFiles = rawKubeconfig.split(delimiter).filter((f) => f.length > 0);
    for (const file of info.kubeconfigFiles) {
      if (file.startsWith("~")) {
        problems.push({
          severity: "error",
          check: "Kubeconfig",
          what: `KUBECONFIG uses "~", which is not expanded here`,
          fix: ["Use the full path (MCP clients do not run a shell)"],
          variable: "KUBECONFIG",
          example: join(home, file.slice(1).replace(/^[/\\]/, "")),
        });
      } else if (!isAbsolute(file)) {
        problems.push({
          severity: "error",
          check: "Kubeconfig",
          what: `KUBECONFIG "${file}" is a relative path`,
          fix: ["Use the full path"],
          variable: "KUBECONFIG",
          example: defaultPath,
        });
      } else if (!existsSync(file)) {
        problems.push({
          severity: "error",
          check: "Kubeconfig",
          what: `KUBECONFIG file not found: ${tildify(file)}`,
          fix: ["Point it at an existing file, or remove it to use ~/.kube/config"],
          variable: "KUBECONFIG",
          example: defaultPath,
        });
      }
    }
  } else if (existsSync(defaultPath)) {
    info.kubeconfigSource = "default";
    info.kubeconfigFiles = [defaultPath];
  } else if (existsSync(SERVICEACCOUNT_TOKEN_PATH)) {
    info.kubeconfigSource = "in-cluster";
  } else {
    problems.push({
      severity: "error",
      check: "Kubeconfig",
      what: "No kubeconfig found (KUBECONFIG not set, ~/.kube/config missing)",
      fix: ["Set KUBECONFIG to your kubeconfig's full path"],
      variable: "KUBECONFIG",
      example: defaultPath,
    });
  }

  if (problems.some((p) => p.severity === "error" && p.check === "Kubeconfig")) {
    return { info, problems };
  }

  const kc = new k8s.KubeConfig();
  try {
    // Load exactly what was resolved above (from `env`, not the ambient process.env).
    if (info.kubeconfigSource === "in-cluster") {
      kc.loadFromCluster();
    } else {
      const [first, ...rest] = info.kubeconfigFiles;
      kc.loadFromFile(first ?? "");
      for (const file of rest) {
        const extra = new k8s.KubeConfig();
        extra.loadFromFile(file);
        kc.mergeConfig(extra);
      }
    }
  } catch (err) {
    let message = String(err);
    if (err instanceof Error) {
      message = err.message;
    }
    problems.push({
      severity: "error",
      check: "Kubeconfig",
      what: `Can't read the kubeconfig (${info.kubeconfigFiles.map(tildify).join(", ") || "in-cluster"})`,
      detail: message,
      fix: ["Check it with: kubectl config view"],
    });
    return { info, problems };
  }

  info.contexts = kc.getContexts().map((c) => c.name);
  const requested = env.K8S_CONTEXT?.trim();
  if (requested) {
    info.contextSource = "K8S_CONTEXT";
    if (!info.contexts.includes(requested)) {
      problems.push({
        severity: "error",
        check: "Context",
        what: `K8S_CONTEXT "${requested}" is not in the kubeconfig`,
        fix: [`Use one of: ${info.contexts.join(", ") || "(no contexts)"}`],
        variable: "K8S_CONTEXT",
        example: "<one of the above>",
      });
      return { kc, info, problems };
    }
    kc.setCurrentContext(requested);
  } else if (info.kubeconfigSource !== "in-cluster") {
    info.contextSource = "current-context";
    const current = kc.getCurrentContext();
    if (info.contexts.length > 1) {
      const others = info.contexts.filter((c) => c !== current);
      problems.push({
        severity: "warning",
        check: "Context",
        what: `Not pinned: follows your kubectl current-context ("${current}")`,
        fix: [`Pin the cluster you mean (others: ${others.join(", ")})`],
        variable: "K8S_CONTEXT",
        example: current || info.contexts[0],
      });
    }
  }

  const current = kc.getCurrentContext();
  info.context = current || undefined;
  info.contextNamespace = kc.getContextObject(current)?.namespace;
  const cluster = kc.getCurrentCluster();
  if (!cluster) {
    problems.push({
      severity: "error",
      check: "Context",
      what: current ? `Context "${current}" points to a cluster that isn't in the kubeconfig` : "No context selected",
      fix: [`Use one of: ${info.contexts.join(", ") || "(no contexts)"}`],
      variable: "K8S_CONTEXT",
      example: info.contexts[0] ?? "my-context",
    });
    return { kc, info, problems };
  }
  info.cluster = { name: cluster.name, server: cluster.server };

  const user = kc.getCurrentUser();
  info.user = user?.name;
  const auth = describeAuth(user);
  info.auth = auth.auth;
  info.execCommand = auth.execCommand;
  const rawExec = user?.exec ?? user?.authProvider?.config?.exec;
  if (rawExec?.command) {
    info.exec = execDetails(rawExec, env);
  }
  if (auth.execCommand) {
    info.execCommandPath = findOnPath(auth.execCommand, env.PATH);
    if (!info.execCommandPath) {
      problems.push(missingHelper(auth.execCommand, env.PATH));
    }
  }

  return { kc, info, problems };
}

/** The kubeconfig's login command is not on this server's PATH. */
export function missingHelper(command: string, pathValue: string | undefined): SetupProblem {
  return {
    severity: "error",
    check: "Login",
    what: `"${command}" (the kubeconfig's login command) is not on this server's PATH`,
    detail: `PATH=${pathValue ?? "(not set)"}`,
    fix: [`Find its folder with: which ${command}`, "Add that folder to PATH (desktop apps don't load your shell profile)"],
    variable: "PATH",
    example: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
  };
}

export function hasFatal(problems: SetupProblem[]): boolean {
  return problems.some((p) => p.severity === "error");
}

/** "EKS gbggo4-nonprod (eu-west-2)" instead of a long endpoint URL. */
export function clusterLabel(info: SetupInfo): string {
  const server = info.cluster?.server ?? "";
  const names = [info.cluster?.name ?? "", info.user ?? "", info.exec?.clusterName ?? ""];
  const arnName = names.map((n) => n.match(/:cluster\/([^/\s]+)$/)?.[1]).find((n) => n);
  const eks = server.match(/\.([a-z]{2}-[a-z]+-\d)\.eks\.amazonaws\.com/);
  if (eks) {
    return `EKS ${info.exec?.clusterName ?? arnName ?? "cluster"} (${eks[1]})`;
  }
  const gke = (info.cluster?.name ?? "").match(/^gke_[^_]+_([^_]+)_(.+)$/);
  if (gke) {
    return `GKE ${gke[2]} (${gke[1]})`;
  }
  if (/\.azmk8s\.io/.test(server)) {
    return `AKS ${info.cluster?.name ?? "cluster"}`;
  }
  return server || "unknown cluster";
}

/** One line: which context, cluster and kubeconfig the server is using. */
export function shortTarget(info: SetupInfo): string {
  const parts: string[] = [];
  if (info.context) {
    parts.push(`context ${info.context} (${info.contextSource === "K8S_CONTEXT" ? "pinned" : "not pinned"})`);
  }
  if (info.cluster) {
    parts.push(clusterLabel(info));
  }
  if (info.kubeconfigSource === "in-cluster") {
    parts.push("in-cluster");
  } else if (info.kubeconfigFiles.length > 0) {
    parts.push(info.kubeconfigFiles.map(tildify).join(", "));
  }
  return parts.join(" · ");
}

function desktopConfigPath(platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return "%APPDATA%\\Claude\\claude_desktop_config.json";
  }
  if (platform === "linux") {
    return "~/.config/Claude/claude_desktop_config.json";
  }
  return "~/Library/Application Support/Claude/claude_desktop_config.json";
}

type ClientKind = "desktop" | "code" | "unknown";

function clientKind(clientName?: string): ClientKind {
  const name = (clientName ?? "").toLowerCase();
  if (name.includes("claude-code")) {
    return "code";
  }
  if (name.includes("claude")) {
    return "desktop";
  }
  return "unknown";
}

/**
 * Where this server's environment variables are set, one short line per
 * client. Only the caller's client when it is known.
 */
export function configLocations(clientName?: string, platform: NodeJS.Platform = process.platform, variable?: string, value?: string): string[] {
  const restart = platform === "darwin" ? "then Cmd+Q and reopen" : "then restart the app";
  const desktop = `Claude Desktop: ${desktopConfigPath(platform)} → "env" of this server (${restart})`;
  let code = `Claude Code:    "env" of this server in ~/.claude.json or .mcp.json (then /mcp to reconnect)`;
  if (variable) {
    code = `Claude Code:    claude mcp add k8s-cronjobs -e ${variable}=${value ?? "<value>"} -- npx -y k8s-cronjob-mcp`;
  }
  const kind = clientKind(clientName);
  if (kind === "desktop") {
    return [desktop];
  }
  if (kind === "code") {
    return [code];
  }
  return [desktop, code];
}

/** Where to set one variable, as text (kept for callers that want a single string). */
export function whereToSet(variable: string, example: string | undefined, clientName?: string, platform: NodeJS.Platform = process.platform): string {
  return configLocations(clientName, platform, variable, example).join("\n         ");
}

/**
 * A problem as a short block:
 *   ✗ what
 *     Error: detail
 *     Using: context · cluster · kubeconfig
 *     Fix:   step
 *     Set:   VAR=value
 *            where
 */
export function formatProblem(problem: SetupProblem, clientName?: string, info?: SetupInfo, opts: { where?: boolean } = {}): string {
  const mark = problem.severity === "error" ? "✗" : "!";
  const lines = [`${mark} ${problem.what}`];
  if (problem.detail) {
    lines.push(`  Error: ${oneLine(problem.detail)}`);
  }
  if (info) {
    const target = shortTarget(info);
    if (target) {
      lines.push(`  Using: ${target}`);
    }
  }
  problem.fix.forEach((step, i) => {
    lines.push(`  ${i === 0 ? "Fix:  " : "      "} ${step}`);
  });
  if (problem.variable) {
    lines.push(`  Set:   ${problem.variable}=${problem.example ?? "<value>"}`);
    if (opts.where ?? true) {
      for (const loc of configLocations(clientName, process.platform, problem.variable, problem.example)) {
        lines.push(`         ${loc}`);
      }
    }
  }
  return lines.join("\n");
}

/** Collapse whitespace and cap length so a raw error fits on one line. */
export function oneLine(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) {
    return flat;
  }
  return `${flat.slice(0, max - 1)}…`;
}

export function startupLog(setup: Setup): string {
  const lines = ["k8s-cronjob-mcp starting"];
  const target = shortTarget(setup.info);
  if (target) {
    lines.push(`  using: ${target}`);
  }
  if (setup.info.auth) {
    lines.push(`  login: ${setup.info.auth}${setup.info.execCommandPath ? ` (${setup.info.execCommandPath})` : ""}`);
  }
  lines.push(`  scope: ${setup.info.allowedNamespaces ? setup.info.allowedNamespaces.join(", ") : "all namespaces"} · schedules in ${setup.info.defaultTimeZone}`);
  for (const p of setup.problems) {
    lines.push(formatProblem(p));
  }
  return lines.join("\n");
}
