#!/bin/sh
# Pull the newest AI Gateway logs, each with the situation sent to Jev and
# Jev's answer, into a new run folder under probe/logs/.
#
#   probe/pull.sh [count]      (default 200)
#
# Needs ROUTER_GATEWAY_TOKEN (a Cloudflare API token with AI Gateway Read) and
# CLOUDFLARE_ACCOUNT_ID in worker/.env.
set -eu

COUNT=${1:-200}
GATEWAY=model-router
ROOT=$(cd "$(dirname "$0")/.." && pwd)
set -a
. "$ROOT/worker/.env"
set +a

API="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai-gateway/gateways/$GATEWAY/logs"
RUN="$ROOT/probe/logs/$(date +%Y-%m-%d-%H%M)"
mkdir -p "$RUN/bodies" "$RUN/batches"
export API RUN ROUTER_GATEWAY_TOKEN

# The list only carries metadata, 50 entries a page, newest first.
page=1
: > "$RUN/list.jsonl"
while [ "$(wc -l < "$RUN/list.jsonl")" -lt "$COUNT" ]; do
  before=$(wc -l < "$RUN/list.jsonl")
  curl -sSf "$API?per_page=50&page=$page&order_by=created_at&order_by_direction=desc" \
    -H "Authorization: Bearer $ROUTER_GATEWAY_TOKEN" | jq -c '.result[]' >> "$RUN/list.jsonl"
  [ "$(wc -l < "$RUN/list.jsonl")" -eq "$before" ] && break
  page=$((page + 1))
done

# Each entry's input and output sit behind their own endpoints.
head -n "$COUNT" "$RUN/list.jsonl" | jq -r .id | xargs -P 8 -n 1 sh -c '
  curl -sSf "$API/$1/request" -H "Authorization: Bearer $ROUTER_GATEWAY_TOKEN" > "$RUN/bodies/$1.req.json"
  curl -sSf "$API/$1/response" -H "Authorization: Bearer $ROUTER_GATEWAY_TOKEN" > "$RUN/bodies/$1.res.json"' _

head -n "$COUNT" "$RUN/list.jsonl" | while read -r entry; do
  id=$(printf '%s' "$entry" | jq -r .id)
  jq -nc --argjson m "$entry" --slurpfile req "$RUN/bodies/$id.req.json" --slurpfile res "$RUN/bodies/$id.res.json" \
    '$m | {id, created_at, duration, tokens_in, tokens_out, cost, metadata, request: $req[0], response: $res[0]}'
done > "$RUN/requests.jsonl"
rm -r "$RUN/bodies" "$RUN/list.jsonl"

# Labelers get the situation only, so Jev's answer can't sway them.
jq -c '{id, state: .request.state}' "$RUN/requests.jsonl" | split -l 25 -d -a 2 - "$RUN/batches/batch-"
for file in "$RUN"/batches/batch-*; do mv "$file" "$file.jsonl"; done

echo "$(wc -l < "$RUN/requests.jsonl" | tr -d ' ') calls in $RUN"
