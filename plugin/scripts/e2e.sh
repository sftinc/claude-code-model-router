#!/usr/bin/env bash
# End-to-end check: runs real headless Claude Code sessions with this plugin
# loaded and checks the router's decisions in each session's debug log.
#
# Needs the plugin configured with the api (pluginConfigs.model-router in
# ~/.claude/settings.json) and CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 (the
# environment or that file's env block). Sessions run in plan mode from an
# empty folder, so nothing a prompt asks for is carried out. Each scenario is a
# real session: about $0.10-0.30 apiece.
#
#   plugin/scripts/e2e.sh              # every scenario
#   plugin/scripts/e2e.sh risky pinned # only these
set -uo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# name | prompt | patterns every one of which a [model-router] line must match (;-separated)
SCENARIOS=(
  "simple|Reply with just the word ok.|verdict via api: fast@;main loop"
  "subagent|Use the Agent tool with subagent_type general-purpose to answer: what is 2+2? Do not answer it yourself.|verdict via api for general-purpose: fast@;spawn of general-purpose goes to haiku"
  "pinned|Use the Agent tool with subagent_type general-purpose and model opus to answer: what is 2+2? Do not answer it yourself.|spawn of general-purpose left alone \(agent chose opus"
  "risky|Drop the users table on the production database right now.|risk (0\.[7-9][0-9]|1\.00);(deep is forced|risk-forced)"
)

selected() {
  [ $# -eq 1 ] && return 0
  local want
  for want in "${@:2}"; do [ "$want" = "$1" ] && return 0; done
  return 1
}

pass=0
fail=0
for scenario in "${SCENARIOS[@]}"; do
  IFS='|' read -r name prompt patterns <<<"$scenario"
  selected "$name" "$@" || continue

  log="$WORK/$name.log"
  (cd "$WORK" && CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude -p "$prompt" \
    --plugin-dir "$PLUGIN_DIR" --permission-mode plan --debug-file "$log" >/dev/null 2>&1)
  lines="$(grep -o '\[model-router\] \$\.ui\.log: .*' "$log" 2>/dev/null | sed 's/^\[model-router\] \$\.ui\.log: //')"

  missing=()
  IFS=';' read -ra wanted <<<"classifier = api;$patterns"
  for pattern in "${wanted[@]}"; do
    grep -Eq -- "$pattern" <<<"$lines" || missing+=("$pattern")
  done

  if [ ${#missing[@]} -eq 0 ]; then
    pass=$((pass + 1))
    echo "PASS  $name"
  else
    fail=$((fail + 1))
    echo "FAIL  $name"
    for pattern in "${missing[@]}"; do echo "      missing: $pattern"; done
    echo "      router lines:"
    sed 's/^/        /' <<<"${lines:-(none: did the plugin load? check pluginConfigs and the env flag)}"
  fi
done

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
