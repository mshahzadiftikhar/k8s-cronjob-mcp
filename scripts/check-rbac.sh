#!/usr/bin/env bash
# Prove the shipped ClusterRole is read-only: reads allowed, every write denied.
set -euo pipefail
cd "$(dirname "$0")/.."

export KUBECONFIG="${DEMO_KUBECONFIG:-$PWD/.kube/kind.kubeconfig}"
context="$(kubectl config current-context)"
case "$context" in
  kind-*) ;;
  *) echo "refusing: context '$context' is not a kind cluster" >&2; exit 1 ;;
esac

SA="system:serviceaccount:default:k8s-cronjob-mcp"
fail=0

expect() { # expect <yes|no> <verb> <resource> [subresource]
  local want="$1" verb="$2" resource="$3" got
  got="$(kubectl auth can-i "$verb" "$resource" --as="$SA" -A 2>/dev/null || true)"
  if [ "$got" = "$want" ]; then
    echo "ok    $verb $resource -> $got"
  else
    echo "FAIL  $verb $resource -> $got (wanted $want)"
    fail=1
  fi
}

for r in cronjobs.batch jobs.batch pods pods/log events; do
  for v in get list watch; do expect yes "$v" "$r"; done
done
for r in cronjobs.batch jobs.batch pods pods/exec events secrets configmaps; do
  for v in create update patch delete deletecollection; do expect no "$v" "$r"; done
done
expect no get secrets
expect no list nodes

exit "$fail"
