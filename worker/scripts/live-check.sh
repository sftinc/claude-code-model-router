#!/usr/bin/env bash
# Calls the deployed Worker with a main and a subagent situation, then a wrong secret.
# Usage: ROUTER_API=https://model-router-api.<subdomain>.workers.dev ROUTER_SECRET=... scripts/live-check.sh
set -euo pipefail
: "${ROUTER_API:?set ROUTER_API to the Worker base URL}"
: "${ROUTER_SECRET:?set ROUTER_SECRET to the Worker secret}"

call() {
  curl -sS -w '\nHTTP %{http_code} in %{time_total}s\n' "$ROUTER_API/v1/classify" \
    -H "Authorization: Bearer $ROUTER_SECRET" -H 'Content-Type: application/json' -d "$1"
}

echo '--- main'
call '{"source":"main","prompt":"rename getUser to fetchUser in src/api.ts","recent":[{"role":"user","text":"we are tidying the api module"}]}'
echo '--- subagent'
call '{"source":"subagent","prompt":"Find every caller of fetchUser and list the files","description":"Find callers","agentType":"Explore"}'
echo '--- wrong secret (expect 401)'
curl -sS -o /dev/null -w 'HTTP %{http_code}\n' "$ROUTER_API/v1/classify" -H 'Authorization: Bearer wrong' -d '{}'
