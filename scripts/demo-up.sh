#!/usr/bin/env bash
# Create (or reuse) the kind demo cluster and deploy the demo workloads + RBAC.
# Safety: this script NEVER reads $KUBECONFIG. It only touches DEMO_KUBECONFIG
# (default: ./.kube/kind.kubeconfig), so no other cluster context is used.
set -euo pipefail
cd "$(dirname "$0")/.."

CLUSTER=cronjob-mcp
DEMO_KUBECONFIG="${DEMO_KUBECONFIG:-$PWD/.kube/kind.kubeconfig}"
mkdir -p "$(dirname "$DEMO_KUBECONFIG")"

if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  echo "kind cluster '$CLUSTER' exists; exporting its kubeconfig"
  kind export kubeconfig --name "$CLUSTER" --kubeconfig "$DEMO_KUBECONFIG"
else
  kind create cluster --config demo/kind-config.yaml --kubeconfig "$DEMO_KUBECONFIG"
fi

export KUBECONFIG="$DEMO_KUBECONFIG"
context="$(kubectl config current-context)"
case "$context" in
  kind-*) ;;
  *) echo "refusing to continue: context '$context' is not a kind cluster" >&2; exit 1 ;;
esac

kubectl apply -f demo/cronjobs.yaml
kubectl apply -f deploy/rbac.yaml
echo "ready. kubeconfig: $DEMO_KUBECONFIG"
