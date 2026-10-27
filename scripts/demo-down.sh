#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
kind delete cluster --name cronjob-mcp
rm -rf .kube
