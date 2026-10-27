import { formatProblem, missingHelper, oneLine, orList, type SetupInfo, type SetupProblem } from "./setup.js";

export class ToolInputError extends Error {}

export class NotFoundError extends ToolInputError {}

export class NamespaceNotAllowedError extends ToolInputError {
  constructor(
    message: string,
    readonly namespace?: string,
    readonly allowed?: string[],
  ) {
    super(message);
  }
}

export function apiErrorCode(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === "number") {
      return code;
    }
  }
  return undefined;
}

/** Context that turns a raw failure into "what went wrong, which variable, where". */
export interface ErrorContext {
  info?: SetupInfo;
  clientName?: string;
}

/** The Kubernetes Status message from an ApiException body, e.g. 'cronjobs.batch is forbidden: User "x" cannot list...'. */
export function apiErrorMessage(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("body" in err)) {
    return undefined;
  }
  let body: unknown = (err as { body: unknown }).body;
  if (typeof body === "string") {
    const text: string = body;
    try {
      body = JSON.parse(text);
    } catch {
      return text.length > 0 ? text.slice(0, 300) : undefined;
    }
  }
  if (typeof body === "object" && body !== null && "message" in body) {
    const message = (body as { message: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }
  return undefined;
}

/** System error codes (ECONNREFUSED, ENOENT, ...) on the error or its cause chain. */
function systemCodes(err: unknown): { codes: string[]; syscall?: string; path?: string } {
  const codes: string[] = [];
  let syscall: string | undefined = undefined;
  let path: string | undefined = undefined;
  let current: unknown = err;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth++) {
    const e = current as { code?: unknown; syscall?: unknown; path?: unknown; cause?: unknown; message?: unknown };
    if (typeof e.code === "string") {
      codes.push(e.code);
    }
    if (typeof e.syscall === "string" && !syscall) {
      syscall = e.syscall;
    }
    if (typeof e.path === "string" && !path) {
      path = e.path;
    }
    if (typeof e.message === "string") {
      const match = e.message.match(/\b(E[A-Z]{3,}|UND_ERR_[A-Z_]+|CERT_[A-Z_]+|ERR_TLS_[A-Z_]+|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY)\b/);
      if (match?.[1]) {
        codes.push(match[1]);
      }
    }
    current = e.cause;
  }
  return { codes, syscall, path };
}

const NETWORK_CODES = ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET", "UND_ERR_CONNECT_TIMEOUT"];
const TLS_CODES = [
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
];

function messageOf(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function withFix(problem: SetupProblem, ctx: ErrorContext): string {
  return formatProblem(problem, ctx.clientName, ctx.info);
}

function otherContexts(info: SetupInfo | undefined): string[] {
  if (!info) {
    return [];
  }
  return info.contexts.filter((c) => c !== info.context);
}

function testCommand(info: SetupInfo | undefined): string {
  return `Test: kubectl --context ${info?.context ?? "<context>"} get ns`;
}

/** The exact login command for the kubeconfig's login helper. */
export function loginFix(info: SetupInfo, helperMessage: string): SetupProblem {
  const exec = info.exec;
  const command = exec?.command ?? info.execCommand ?? "the login helper";
  const message = oneLine(helperMessage) || "(no output)";
  let what = `Login failed: "${command}" could not get a token for this cluster`;
  let login = `Log in again with ${command}`;
  let variable: string | undefined = undefined;
  let example: string | undefined = undefined;

  if (command === "aws" || command.endsWith("/aws")) {
    let profileFlag = "";
    if (exec?.awsProfile) {
      profileFlag = ` --profile ${exec.awsProfile}`;
    }
    if (/sso/i.test(message)) {
      what = "AWS SSO session expired";
      login = `Run: aws sso login${profileFlag}`;
    } else if (/Unable to locate credentials|NoCredentialProviders|could not be found|config profile/i.test(message)) {
      what = "AWS credentials not found";
      login = `Run: aws sso login${profileFlag}  (or aws configure if you don't use SSO)`;
      if (!exec?.awsProfile) {
        variable = "AWS_PROFILE";
        example = "<your AWS profile>";
      }
    } else {
      what = "AWS login failed";
      login = `Run: aws sso login${profileFlag}  (or refresh your AWS credentials)`;
    }
  } else if (/gke-gcloud-auth-plugin|gcloud/.test(command)) {
    what = "Google Cloud login failed";
    login = "Run: gcloud auth login";
  } else if (/kubelogin/.test(command) || /(^|\/)az$/.test(command)) {
    what = "Azure login failed";
    login = "Run: az login";
  }

  return {
    severity: "error",
    check: "Login",
    what,
    detail: message,
    fix: [login, "Then ask again (no restart needed)"],
    variable,
    example,
  };
}

/** Plain-language name for a network error code. */
function networkProblem(code: string): string {
  if (code === "ECONNREFUSED") {
    return "connection refused";
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return "address not found (DNS)";
  }
  if (code === "ECONNRESET") {
    return "connection reset";
  }
  return "connection timed out";
}

/** What to try when the API server can't be reached, by kind of cluster. */
function networkFix(info: SetupInfo | undefined): string[] {
  const server = info?.cluster?.server ?? "";
  const steps: string[] = [];
  if (/localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0/.test(server)) {
    steps.push("Start the local cluster (kind/minikube/Docker Desktop: is Docker running?)");
  } else if (/eks\.amazonaws\.com|gke\.goog|googleapis\.com|azmk8s\.io/.test(server) || /^https:\/\/\d+\.\d+\.\d+\.\d+/.test(server)) {
    steps.push("Connect to your VPN; the cluster's API endpoint may be private or limited to certain IPs");
  } else {
    steps.push("Check the cluster is up and reachable from this machine (VPN?)");
  }
  steps.push(testCommand(info));
  const others = otherContexts(info);
  if (others.length > 0) {
    steps.push(`Wrong cluster? Set K8S_CONTEXT to ${orList(others)}`);
  }
  return steps;
}

/** Turn any thrown value into a short message: what's wrong, how to fix it, and where. */
export function describeError(err: unknown, ctx: ErrorContext = {}): string {
  const info = ctx.info;

  if (err instanceof NamespaceNotAllowedError) {
    const allowed = err.allowed ?? info?.allowedNamespaces ?? [];
    return withFix(
      {
        severity: "error",
        check: "Namespace",
        what: `Namespace "${err.namespace ?? "?"}" is not in ALLOWED_NAMESPACES (${allowed.join(", ")})`,
        fix: ["Ask about an allowed namespace, or add this one"],
        variable: "ALLOWED_NAMESPACES",
        example: [...allowed, err.namespace ?? "<namespace>"].join(","),
      },
      { clientName: ctx.clientName },
    );
  }
  if (err instanceof ToolInputError) {
    return err.message;
  }

  const code = apiErrorCode(err);
  const k8sMessage = apiErrorMessage(err);

  if (code === 401) {
    if (info?.exec) {
      return withFix(loginFix(info, k8sMessage ?? "401 Unauthorized"), ctx);
    }
    let fix = ["Refresh the credentials in your kubeconfig", testCommand(info)];
    if (info?.auth === "token") {
      fix = ["The token is invalid or expired (kubectl create token lasts 1 hour by default)", "Create a new token and update the kubeconfig"];
    }
    return withFix({ severity: "error", check: "Login", what: "Credentials rejected (401 Unauthorized)", detail: k8sMessage, fix }, ctx);
  }

  if (code === 403) {
    if (/at the cluster scope/.test(k8sMessage ?? "") && !info?.allowedNamespaces) {
      return withFix(
        {
          severity: "error",
          check: "Access",
          what: "No permission to read across all namespaces (403)",
          detail: k8sMessage,
          fix: ["Limit the server to namespaces you can read", "Check one: kubectl auth can-i list cronjobs -n <namespace>"],
          variable: "ALLOWED_NAMESPACES",
          example: info?.contextNamespace ?? "<namespace>",
        },
        ctx,
      );
    }
    return withFix(
      {
        severity: "error",
        check: "Access",
        what: "Permission denied (403)",
        detail: k8sMessage,
        fix: ["Needs get/list on cronjobs, jobs, pods, pods/log and events", "Ask an admin, or use the ServiceAccount in deploy/rbac.yaml"],
      },
      ctx,
    );
  }

  const sys = systemCodes(err);

  if (sys.codes.includes("ENOENT") && (sys.syscall?.startsWith("spawn") || info?.execCommand)) {
    return withFix(missingHelper(sys.path ?? info?.execCommand ?? "the login helper", process.env.PATH), ctx);
  }

  const network = sys.codes.find((c) => NETWORK_CODES.includes(c));
  if (network) {
    return withFix(
      {
        severity: "error",
        check: "Connection",
        what: `Can't reach the cluster: ${networkProblem(network)}`,
        detail: `${info?.cluster?.server ?? "API server"} (${network})`,
        fix: networkFix(info),
      },
      ctx,
    );
  }

  const tls = sys.codes.find((c) => TLS_CODES.includes(c));
  if (tls) {
    return withFix(
      {
        severity: "error",
        check: "Connection",
        what: `TLS check failed (${tls})`,
        fix: ["The kubeconfig's certificate doesn't match the server", "Regenerate it, e.g. aws eks update-kubeconfig or kind export kubeconfig"],
      },
      ctx,
    );
  }

  if (info?.execCommand && code === undefined && /token|expired|log ?in|credential|sso|auth|refresh|session|profile/i.test(messageOf(err))) {
    // Login helper failures surface as a plain Error carrying the helper's stderr.
    return withFix(loginFix(info, messageOf(err)), ctx);
  }

  let detail = messageOf(err);
  if (k8sMessage) {
    detail = `${code ?? ""} ${k8sMessage}`.trim();
  }
  return withFix(
    {
      severity: "error",
      check: "Request",
      what: "Kubernetes request failed",
      detail,
      fix: ["Run check_setup (or npx k8s-cronjob-mcp --check) to find the cause"],
    },
    ctx,
  );
}
