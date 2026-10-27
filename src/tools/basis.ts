import type { ClusterReader } from "../k8s/client.js";

/** The namespaces a result covers: the one asked for, the allowlist, or everything. */
export function scopeOf(reader: ClusterReader, namespace?: string): string {
  if (namespace) {
    return namespace;
  }
  return reader.scopeLabel?.() ?? "all namespaces";
}

/** Kubernetes keeps only a few finished Jobs per CronJob; every answer is limited by that. */
export const RETAINED_JOBS_NOTE = "only the Jobs Kubernetes still keeps (per-CronJob history limits)";

export function formatDays(days: number): string {
  if (days < 1) {
    const hours = Math.round(days * 24 * 10) / 10;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${days} day${days === 1 ? "" : "s"}`;
}

export function formatHours(hours: number): string {
  if (hours >= 48 && hours % 24 === 0) {
    return `${hours / 24} days`;
  }
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}
