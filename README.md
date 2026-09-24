# model-router

model-router is a Claude Code mod that decides, request by request, which model answers and how much reasoning effort it spends, in the main conversation and in subagents alike. A classifier reads the situation (the prompt, recent conversation, subagent details) and returns a tier, an effort level and a risk score. The mod turns that into a model and effort, and leaves the request unchanged whenever anything fails.

The classifier sits behind any server that speaks `POST /v1/classify`. This repo ships one: `model-router-api`, a Cloudflare Worker running TypeSafe's Jev on Workers AI (`worker/`). With no API configured, the mod uses Claude Code's built-in classifier for subagents only: it can move a subagent's model up, never down, and the main loop is left alone unless `routeMainModel` is on.

The idea comes from [jev-model-router](https://github.com/davila7/claude-code-templates/tree/main/cli-tool/components/mods/productivity/jev-model-router).

## Requirements

- Claude Code 2.1.281 or later, with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`
- For the Worker: a Cloudflare account, Node 24, and wrangler

## Install

The plugin lives in `plugin/`, and the repo is also a marketplace. From a terminal:

```bash
claude plugin marketplace add sftinc/claude-code-model-router
claude plugin install model-router@sftinc
```

Or inside Claude Code:

```
/plugin marketplace add sftinc/claude-code-model-router
/plugin install model-router@sftinc
```

If the repo is private, adding the marketplace needs git access to it (an SSH key or `gh auth login`).

Start Claude Code with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. To run it from a clone instead:

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir /path/to/claude-code-model-router/plugin
```

## Configure

Options live under `pluginConfigs` in `~/.claude/settings.json`. The key is `model-router@sftinc` when the plugin is installed from the marketplace, `model-router` when it's loaded with `--plugin-dir`, and `model-router@skills-dir` when it's loaded from `.claude/skills/`.

```json
{
  "pluginConfigs": {
    "model-router": {
      "options": {
        "apiUrl": "https://model-router-api.<subdomain>.workers.dev",
        "apiSecret": "<ROUTER_SECRET>"
      }
    }
  }
}
```

| Option | Default | Notes |
| --- | --- | --- |
| `provider` | `auto` | `auto`, `api`, `builtin` |
| `apiUrl` / `apiSecret` | empty | Both needed for the API |
| `fastModel` / `balancedModel` / `deepModel` | `haiku` / `sonnet` / `opus` | Alias or full id |
| `minUpgradeConfidence` / `minDowngradeConfidence` | 0.3 / 0.6 | Minimum confidence for a move to a costlier / cheaper setting |
| `riskyThreshold` | 0.7 | Above it: deep tier, at least high effort |
| `contextMessages` / `contextChars` | 30 / 60000 | Recent context sent with main-loop prompts |
| `routeSubagentModel` | true | |
| `respectAgentModels` | true | Keeps a model the Agent tool named. A model set in an agent's definition isn't visible to the router and isn't protected |
| `routeMainEffort` | true | |
| `routeMainModel` | false | Switching models invalidates the prompt cache |
| `timeoutMs` | 2000 | Wait budget for the classifier |
| `warmUp` | true | Sends one throwaway classification when an interactive session starts, so the first prompt doesn't hit a cold classifier |
| `logDecisions` | true | |

A request routed to a model without effort support (Haiku) never carries an effort, whatever the switches say.

## The Worker

```bash
cd worker
npm install
npx wrangler secret put ROUTER_SECRET   # generate with: openssl rand -base64 32
npm run deploy
ROUTER_API=https://model-router-api.<subdomain>.workers.dev ROUTER_SECRET=... scripts/live-check.sh
```

Before the first deploy, create an AI Gateway named `model-router` in the Cloudflare dashboard, with Workers AI set to Unified billing. `COLLECT_LOG` in `wrangler.jsonc` controls whether gateway logs store prompts and context.

## Development

Two type-declaration files are generated, not committed. Until they exist, your editor reports missing types.

- **Plugin:** in Claude Code, run `/plugin-types plugin`. It writes Claude Code's declarations to `plugin/.claude/types/`, which `plugin/tsconfig.json` reads. Run it again after updating Claude Code.
- **Worker:** run `npm run typecheck` in `worker/`. It runs `wrangler types`, which writes `worker/worker-configuration.d.ts`, then typechecks.

## Tests

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test plugin   # the plugin
cd worker && npm test                                              # the Worker
```

`plugin/scripts/e2e.sh` runs real headless sessions with the plugin loaded, in plan mode so nothing gets carried out. It checks the router's decisions in each session's debug log: a trivial subagent goes to haiku, a model named on the Agent tool is kept, and a risky prompt forces the deep tier. It needs the api configured, and each scenario is a real session that costs about $0.10–0.30. Pass scenario names to run only some of them.

## Privacy

With an API configured, each prompt and up to `contextChars` of recent conversation go to it. With `COLLECT_LOG=true`, the AI Gateway's logs keep them.
