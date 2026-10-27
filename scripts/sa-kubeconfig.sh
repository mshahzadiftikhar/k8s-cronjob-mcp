#!/usr/bin/env bash
# Build a kubeconfig that authenticates as the read-only ServiceAccount from
# deploy/rbac.yaml, so the integration test runs with exactly those permissions.
set -euo pipefail
cd "$(dirname "$0")/.."

DEMO_KUBECONFIG="${DEMO_KUBECONFIG:-$PWD/.kube/kind.kubeconfig}"
SA_KUBECONFIG="${SA_KUBECONFIG:-$PWD/.kube/sa.kubeconfig}"
export KUBECONFIG="$DEMO_KUBECONFIG"

context="$(kubectl config current-context)"
case "$context" in
  kind-*) ;;
  *) echo "refusing: context '$context' is not a kind cluster" >&2; exit 1 ;;
esac

server="$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')"
ca="$(kubectl config view --minify --raw -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')"
token="$(kubectl create token k8s-cronjob-mcp -n default --duration=1h)"

cat > "$SA_KUBECONFIG" <<KC
apiVersion: v1
kind: Config
clusters:
  - name: kind-sa
    cluster: { server: "$server", certificate-authority-data: "$ca" }
users:
  - name: k8s-cronjob-mcp
    user: { token: "$token" }
contexts:
  - name: kind-sa
    context: { cluster: kind-sa, user: k8s-cronjob-mcp }
current-context: kind-sa
KC
chmod 600 "$SA_KUBECONFIG"
echo "wrote $SA_KUBECONFIG"
