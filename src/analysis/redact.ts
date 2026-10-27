const KEYED_SECRET =
  /(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|authorization|credential)(["']?\s*[:=]\s*["']?)([^\s"',;]+)/gi;
const BEARER = /(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;

/** Best-effort masking of obvious secrets in log text. Not a guarantee. */
export function redactSecrets(text: string): string {
  // Bearer first: otherwise "Authorization: Bearer <token>" masks only the word "Bearer".
  return text.replace(BEARER, "$1[REDACTED]").replace(KEYED_SECRET, "$1$2[REDACTED]");
}
