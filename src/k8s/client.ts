import * as k8s from "@kubernetes/client-node";
import { apiErrorCode, NamespaceNotAllowedError, NotFoundError } from "../errors.js";

/**
 * The only cluster surface the tools can touch. Every method is a read
 * (get/list); there is deliberately no create/patch/delete/exec here.
 */
export interface ClusterReader {
  listCronJobs(namespace?: string): Promise<k8s.V1CronJob[]>;
  getCronJob(namespace: string, name: string): Promise<k8s.V1CronJob>;
  listJobs(namespace?: string): Promise<k8s.V1Job[]>;
  listPods(namespace: string, labelSelector?: string): Promise<k8s.V1Pod[]>;
  getJob(namespace: string, name: string): Promise<k8s.V1Job>;
  listEvents(namespace: string, fieldSelector?: string): Promise<k8s.CoreV1Event[]>;
  readPodLog(namespace: string, pod: string, options: PodLogOptions): Promise<string>;
  /** Human label for what "all namespaces" means here (e.g. the ALLOWED_NAMESPACES list). */
  scopeLabel?(): string;
}

export interface PodLogOptions {
  container?: string;
  previous?: boolean;
  tailLines?: number;
  limitBytes?: number;
}

const PAGE_SIZE = 500;

interface Page<T> {
  items: T[];
  metadata?: { _continue?: string };
}

async function listAll<T>(fetchPage: (token?: string) => Promise<Page<T>>): Promise<T[]> {
  const all: T[] = [];
  let token: string | undefined = undefined;
  do {
    const page: Page<T> = await fetchPage(token);
    all.push(...page.items);
    token = page.metadata?._continue;
  } while (token);
  return all;
}

export interface ClientOptions {
  /** An already-loaded kubeconfig (see loadSetup); when omitted the default lookup is used. */
  kubeConfig?: k8s.KubeConfig;
  context?: string;
  /** If set, only these namespaces may be queried. */
  allowedNamespaces?: string[];
}

export class KubeClusterReader implements ClusterReader {
  private readonly batch: k8s.BatchV1Api;
  private readonly core: k8s.CoreV1Api;
  private readonly allowed: string[] | undefined;

  constructor(options: ClientOptions = {}) {
    let kc = options.kubeConfig;
    if (!kc) {
      kc = new k8s.KubeConfig();
      kc.loadFromDefault();
      if (options.context) {
        kc.setCurrentContext(options.context);
      }
    }
    this.batch = kc.makeApiClient(k8s.BatchV1Api);
    this.core = kc.makeApiClient(k8s.CoreV1Api);
    this.allowed = options.allowedNamespaces;
  }

  scopeLabel(): string {
    if (this.allowed) {
      return `${this.allowed.join(", ")} (ALLOWED_NAMESPACES)`;
    }
    return "all namespaces";
  }

  private assertAllowed(namespace: string): void {
    if (this.allowed && !this.allowed.includes(namespace)) {
      throw new NamespaceNotAllowedError(
        `Namespace "${namespace}" is not in the allowed list (${this.allowed.join(", ")})`,
        namespace,
        this.allowed,
      );
    }
  }

  /** Namespaces to iterate when no namespace was given and an allowlist is active. */
  private scope(namespace?: string): string[] | undefined {
    if (namespace) {
      this.assertAllowed(namespace);
      return [namespace];
    }
    return this.allowed;
  }

  async listCronJobs(namespace?: string): Promise<k8s.V1CronJob[]> {
    const namespaces = this.scope(namespace);
    if (!namespaces) {
      return listAll((token) =>
        this.batch.listCronJobForAllNamespaces({ limit: PAGE_SIZE, _continue: token }),
      );
    }
    const perNamespace = await Promise.all(
      namespaces.map((ns) =>
        listAll((token) =>
          this.batch.listNamespacedCronJob({ namespace: ns, limit: PAGE_SIZE, _continue: token }),
        ),
      ),
    );
    return perNamespace.flat();
  }

  async getCronJob(namespace: string, name: string): Promise<k8s.V1CronJob> {
    this.assertAllowed(namespace);
    try {
      return await this.batch.readNamespacedCronJob({ namespace, name });
    } catch (err) {
      if (apiErrorCode(err) === 404) {
        throw new NotFoundError(`CronJob "${name}" not found in namespace "${namespace}"`);
      }
      throw err;
    }
  }

  async listJobs(namespace?: string): Promise<k8s.V1Job[]> {
    const namespaces = this.scope(namespace);
    if (!namespaces) {
      return listAll((token) =>
        this.batch.listJobForAllNamespaces({ limit: PAGE_SIZE, _continue: token }),
      );
    }
    const perNamespace = await Promise.all(
      namespaces.map((ns) =>
        listAll((token) =>
          this.batch.listNamespacedJob({ namespace: ns, limit: PAGE_SIZE, _continue: token }),
        ),
      ),
    );
    return perNamespace.flat();
  }

  async listPods(namespace: string, labelSelector?: string): Promise<k8s.V1Pod[]> {
    this.assertAllowed(namespace);
    return listAll((token) =>
      this.core.listNamespacedPod({
        namespace,
        labelSelector,
        limit: PAGE_SIZE,
        _continue: token,
      }),
    );
  }

  async getJob(namespace: string, name: string): Promise<k8s.V1Job> {
    this.assertAllowed(namespace);
    try {
      return await this.batch.readNamespacedJob({ namespace, name });
    } catch (err) {
      if (apiErrorCode(err) === 404) {
        throw new NotFoundError(`Job "${name}" not found in namespace "${namespace}"`);
      }
      throw err;
    }
  }

  async listEvents(namespace: string, fieldSelector?: string): Promise<k8s.CoreV1Event[]> {
    this.assertAllowed(namespace);
    return listAll((token) =>
      this.core.listNamespacedEvent({
        namespace,
        fieldSelector,
        limit: PAGE_SIZE,
        _continue: token,
      }),
    );
  }

  /** Reads (never follows) a pod's logs; works for terminated pods that still exist. */
  async readPodLog(namespace: string, pod: string, options: PodLogOptions): Promise<string> {
    this.assertAllowed(namespace);
    return this.core.readNamespacedPodLog({
      namespace,
      name: pod,
      container: options.container,
      previous: options.previous,
      tailLines: options.tailLines,
      limitBytes: options.limitBytes,
    });
  }
}
