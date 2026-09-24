# model-router mod — functional spec

What the mod does, in behavioural terms: the interfaces other files rely on,
the routing policy, and what each hook does. Internal structure, comments and
log wording are left to the code. The mod lives in `plugin/`; paths below are
relative to it.

## Fixed interfaces

Other files depend on these:

- `hooks/client.ts` (read it): `selectProvider`, `endpoint`, `requestHeaders`,
  `buildRecent`, `readVerdict`, `builtinDecision`, and the `Situation`,
  `RecentMessage`, `SessionEntry` types. It imports `TIER_ORDER` and the
  `Decision`, `Provider`, `Tier` types from `policy.ts`.
- `tests/client.test.ts`, `tests/model-router.test.ts`,
  `tests/register.test.ts`, `tests/fixtures/world.ts`: the behavioural tests for
  the hooks. They must pass. They assert outcomes, not log wording.
- The manifest's option keys, types and defaults (`.claude-plugin/plugin.json`).

`hooks/policy.ts` exports the names below, because `client.ts` and the tests
import them.

| Export | Kind | Meaning |
| --- | --- | --- |
| `Provider` | type | The literal `'api'` |
| `Tier` | type | `'fast' \| 'balanced' \| 'deep'` |
| `TIER_ORDER` | const | The tiers, cheapest first |
| `Tiers` | type | `{ fast: string; balanced: string; deep: string }`, the model alias or id for each tier |
| `EFFORT_ORDER` | const | `low`, `medium`, `high`, `xhigh`, in that order, as a readonly tuple |
| `Effort` | type | One element of `EFFORT_ORDER` |
| `Decision` | type | `{ tier: Tier; confidence: number \| null; risky: number \| null; effort: number \| null; effortConfidence: number \| null; classifier: string \| null; upOnly: boolean }`. `effort` is an integer level 0..3; `risky` a probability; `classifier` names the model that answered (null for the built-in one); `upOnly` means the decision may only raise things |
| `PolicyConfig` | type | `{ tiers: Tiers; minUpgradeConfidence: number; minDowngradeConfidence: number; riskyThreshold: number }` |
| `Routing` | type | `{ model: string \| null; effort: Effort \| null; reason: string }`; null means "leave as is" |
| `effortName(level)` | fn | Level number → `Effort`: clamp to 0..3, dropping any fraction |
| `effortRank(effort)` | fn | `string \| number \| undefined` → position on the effort ladder, `4` for `'max'`, `null` for anything else (numbers, undefined, unknown names) |
| `rankOf(model, tiers)` | fn | Model id → tier position 0..2 or `null` (rules below) |
| `requestModelId(model)` | fn | Alias → full id from the model list (below); anything else returned unchanged |
| `supportsEffort(model)` | fn | The `effort` flag of the listed model whose alias the id contains (any case); `true` for a model not in the list |
| `route(decision, current, config)` | fn | `current` is `{ model: string; effort?: string \| number; pinned?: boolean }`; returns `Routing` (rules below) |
| `modelAlias(model)` | fn | The alias of the listed model whose alias the id contains; the model as given when none |
| `pendingDecisions<T = Decision>()` | fn | Returns `{ put(d: T \| null): void; take(): T \| null }` (rules below) |
| `describeSetup(provider, url, switches, builtinByChoice?)` | fn | `switches` is `{ subagentModel; mainEffort; mainModel }` booleans; returns one line |
| `describeDecision(decision, ms)` | fn | `ms` may be null; returns one line |
| `describeStatus(decision, change)` | fn | `change` is `{ model?: string; effort?: Effort }`; returns a short line |
| `changeBasis(decision, confidence, config)` | fn | What a change is credited to: `risk 82%` when the decision's risk forces the deep tier, else the confidence as a whole percent, null when unknown |
| `describeMove(name, from, to?, basis?)` | fn | `model (sonnet)` without `to`; `model (sonnet → haiku @ 90%)` with it, the `@` part only with a basis |

`hooks/model-router.ts` must export `register` (type `Register` from
`'claude-code'`).

## Platform constraints

- Claude Code function hooks, early access. `register(on, options)` wires
  `prompt.submit`, `turn.step` (an async generator: `yield* next(e)`) and
  `agent.spawn`. `options` holds the manifest's `userConfig` values.
- A static analyser checks the module. Every engine call is written
  `$.noun.event(...)` directly at the call site (no aliasing `$` members, no
  passing them around). Any function that receives `$` must be a top-level
  function in a plugin file or imported from one.
- The engine calls used: `$.ui.log(text, { to })`, `$.ui.status(text)`,
  `$.clock.now()`, `$.clock.sleep(ms)`, `$.http.fetch(url, init)` (resolves to
  `{ ok, status, text }`), `$.model.classify(text, labels)` (resolves to a
  label or undefined), `$.session.messages()`.
- Check with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin validate plugin` and
  `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test plugin`. Test files use
  `import { describe, expect, test } from 'claude-code/testing'` (no
  `toBeCloseTo`).

## Policy rules

**Tier position (`rankOf`).** Compare case-insensitively. First, if the model
id contains a tier's configured value (checked fast, balanced, deep; an empty
value never matches), that tier's position. Otherwise the tier of the first
listed model whose alias the id contains. Otherwise unknown (`null`).

**Model list (`plugin/hooks/models.ts`).** The one place models are described.
`MODELS` gives each model's alias, full id (absent when none exists yet), usual
tier and whether it takes effort; `DEFAULT_TIERS` gives each tier's default
alias. `requestModelId` trims and lowercases, then looks the alias up there.
`plugin.json` repeats `DEFAULT_TIERS` as its option defaults, and a test holds
the two together.

**Confidence gate.** A proposed move from a current position (possibly
unknown) to a wanted position, with a confidence (possibly null):
- same known position: no move;
- it is a downgrade only when the current position is known and the wanted one
  is lower; anything else, including an unknown current position, counts as an
  upgrade;
- null confidence: upgrades pass, downgrades don't;
- otherwise it passes when confidence ≥ the bar for its direction
  (`minDowngradeConfidence` for downgrades, `minUpgradeConfidence` for
  upgrades).

**`route`.**
1. No decision: no change, reason says there was no decision.
2. Risk: when `risky` is present and strictly above `riskyThreshold`, the
   wanted tier becomes `deep`, the wanted effort level becomes at least 2
   (absent counts as 0), and the decision is *forced*.
3. Model. The wanted model is `config.tiers[tier]`. Consider a change only when
   that is non-empty and differs from `current.model`. Then, in order:
   - forced: change only when the current position is unknown or below the
     wanted one (a same-tier model, e.g. a newer version or a `[1m]` variant, is
     kept);
   - `current.pinned`: keep;
   - `upOnly` and (current position unknown, or wanted below current): keep;
   - otherwise change when the gate passes with the tier confidence.
4. Effort. Only when the decision has an effort level **and** `current.effort`
   is a string (absent means the model takes none; a number is the caller's own
   scale). Current position from `effortRank`; wanted position from
   `effortName(level)`. When forced and the current position is known, the
   wanted position is raised to at least the current one. Change when the
   positions differ, and not (`upOnly`, not forced, and current unknown or
   wanted lower), and (forced or the gate passes with the effort confidence).
   The new effort is the ladder name at the wanted position.
5. Reason. With no change, it must say what was kept, what was wanted, the
   tier confidence (or that none was reported), and whether the decision was
   up-only; a pinned subagent model that blocked a wanted change gets its own
   wording. With a change, it names the tier and confidence, or says risk
   forced it.

**`pendingDecisions`.** Hands a prompt's decision to the turn that follows it.
`take` returns a decision only when exactly one `put` happened since the last
`take`; otherwise it returns nothing. So two prompts queued before a turn starts
give that turn nothing, a failed classification (`put(null)`) still counts as a
prompt, and every `take` starts afresh.

**Log text.** Each describe function returns one line; missing numbers are
marked as unknown rather than omitted.
- `describeSetup`: which backend answers (the api and its URL, or the built-in
  classifier, saying whether it was chosen or no API is configured) and which
  switches are on.
- `describeDecision`: what the classifier said (tier, effort, risk and their
  confidences, the classifier's name, whether the decision is up-only) and how
  long it took, or that nothing came back.
- `describeStatus`: the short status-bar form for a changed request: the tier
  and confidence when there is a verdict, and the change made (a removed effort
  shown as such). A request sent as is clears the status line.

## Hook behaviour (`register`)

**Options.** Strings: use the option when it is a non-empty string, else the
default. Numbers and booleans: use it when its type matches, else the default.
Keys and defaults: `provider` `auto`, `apiUrl` ``, `apiSecret` ``,
`fastModel`, `balancedModel` and `deepModel` from `DEFAULT_TIERS` (`haiku`, `sonnet`, `opus`),
`minUpgradeConfidence` 0.3, `minDowngradeConfidence` 0.6, `riskyThreshold` 0.7,
`contextMessages` 30, `contextChars` 60000, `routeSubagentModel` true,
`respectAgentModels` true, `routeMainEffort` true, `routeMainModel` false,
`timeoutMs` 2000, `warmUp` true, `logDecisions` true.

**Backend.** `selectProvider(provider, apiUrl, apiSecret)` gives `'api'` or
null (built-in). With the api, the URL is `endpoint(apiUrl)`.

**Main loop can change** when `routeMainModel` is on, or `routeMainEffort` is on
and the api is configured (the built-in classifier yields no effort). The setup
line reports main effort as on only in that second case.

**Log prefix.** Every log line starts `[model-router] `.

**Where lines go.** The transcript gets one short line per routed main-loop
turn or subagent, and the warm-up's result. Models show as their alias
(`modelAlias`); tiers and routing reasons are left out. The details (setup,
whole api replies, thrown errors with their stack, verdicts, routing reasons)
go to the debug log alone. `logDecisions` gates all of these, except that a
line carrying a failure, and the one-time warnings, are always written.

- Main loop: `main loop: model (sonnet), effort (high)`. A part that changes
  gets an arrow and its basis: `model (sonnet → opus @ 88%)`,
  `effort (medium → high @ risk 82%)`. An effort removed because the model
  takes none is `effort (dropped)`; a request with no effort has no effort
  part. When classification failed, its short reason ends the line:
  `…, api returned HTTP 401`.
- Subagent: `subagent Explore: model (sonnet → haiku @ 85%)` when routed, the
  "from" model being `e.model ?? e.parentModel`. Left alone, it shows the model
  the engine resolved (from `next`), since an agent's definition may name one
  the router can't see: `subagent Explore: model (haiku)`. A failure ends the
  line as for the main loop.
- Warm-up: `classifier warmed up in 412ms`, or `warm-up failed (…)`.

**One-time lines.**
- The setup line, at the first `prompt.submit` or `agent.spawn`, before any
  switch check.
- When `provider` is `api` but the api isn't configured: a warning that the
  built-in classifier is used, once, at the first hook that gets past its
  switch check.
- When session history can't be read: one warning, the first time.

**Classifying (shared, never throws).** Given a situation and an up-only flag,
gives a decision, or no decision with a short failure reason for the routed
line:
- api: POST the situation as JSON to the endpoint with `requestHeaders(secret)`,
  raced against `$.clock.sleep(timeoutMs)`. Every reply, status and whole body,
  goes to the debug log. A timeout, a non-ok status, or an unreadable verdict
  (`readVerdict` → null) gives no decision and says which. Otherwise the
  verdict's decision with the up-only flag applied.
- built-in: `$.model.classify(prompt, TIER_ORDER)`, raced against the same
  timeout; the label goes to the debug log; `builtinDecision(label)`, with the
  up-only flag applied.
- any thrown error: the error (with its stack) to the debug log; no decision,
  the error's message as the reason.
- A late answer must never be used.

**`session.start`.** After the engine's own start, when the session is
interactive, the api is configured and `warmUp` is on, send one throwaway
classification (`source: 'main'`, prompt `warm-up`) in the background, detached
from the dispatch through `$.clock.after`. Its reply goes to the debug log; an
ok answer writes the warm-up line with the elapsed ms, and a non-ok status or a
failure writes the failed form. A `-p` run skips it: its first prompt arrives
at once, so a warm-up would only race it.

**`prompt.submit`.**
1. One-time setup line.
2. When the main loop can't change: pass the event on untouched.
3. One-time api warning.
4. Blank prompt (whitespace only): record "no decision" in the pending slot and
   pass on.
5. When `contextMessages` > 0, read `$.session.messages()` and build `recent`
   with `buildRecent(messages, prompt, contextMessages, contextChars)`. If
   reading throws, classify anyway with up-only set, without `recent`, and warn
   once.
6. Situation: `source: 'main'`, the prompt, and `recent` when there is one.
7. Classify; when logging, write the decision line with the backend name
   (`api` or `builtin`) and the elapsed ms.
8. Put the decision, with its failure reason, in the pending slot only after
   classification has finished, then pass on.

**`turn.step`.**
1. A subagent's step (`e.agentId` set): pass on untouched.
2. A later step (`e.index > 0`) of the turn already handled: re-apply that
   turn's change (or nothing) and pass on, so model and effort stay fixed within
   a turn.
3. Otherwise take the pending decision and `route` it against
   `{ model: e.model, effort: e.effort }`. Build the change: the model when
   `routeMainModel` is on and routing gave one, resolved with `requestModelId`;
   the effort when `routeMainEffort` is on and routing gave one.
4. Effort goes with the model the request is sent to: when the request carries
   an effort and `supportsEffort(new model or e.model)` is false, the change's
   `effort` key is set to `undefined` explicitly, so spreading the change over
   the event removes the effort. This happens whatever the switches say, so the
   hook must not skip turns when the main loop can't change.
5. Remember the turn id and the change (null when empty).
6. When logging and the main loop can change, set the status line. When the
   main loop can change or there is a change, write the main-loop line (above).
   When the main loop can change, write the routing reason to the debug log,
   noting when a wanted model was dropped because main-model routing is off.
   Pass on the event with the change spread over it.

**`agent.spawn`.**
1. One-time setup line.
2. Pass on untouched when `routeSubagentModel` is off or `e.fork` is set (a fork
   keeps its parent's model).
3. One-time api warning. Blank prompt: pass on.
4. Situation: `source: 'subagent'`, `prompt`, `description`, and `agentType`
   from `e.subagentType`. Classify with up-only off; log the decision line
   tagged with the subagent type.
5. `pinned` is `respectAgentModels` and `e.model` defined. Route against
   `{ model: e.model ?? e.parentModel, pinned }`, and write the reason to the
   debug log. Pass on, with `model` set to the tier's value as configured when
   routing gave one (an alias stays an alias here). Then write the subagent
   line (above) and return what `next` gave.

## Worker wording (`worker/src/classifiers/jev.ts`)

- **Tier descriptions:** one per tier, characterising the work by its demands
  on judgment and the cost of getting it wrong, never by model name, reading as
  a ladder from least to most demanding.
- **Tier, effort and risky instructions:** each asks its question about the
  situation's fields by name (`prompt`, `recent`, `description`, `agentType`).
- **Risky** separates the act from the subject: the probability is high only
  when doing the task would itself cause harm that can't be undone, and low
  when the task merely involves code or text on a sensitive topic.

## Tests

`tests/policy.test.ts` covers every rule under **Policy rules**: each gate
direction, null confidence, unknown ranks, forced risk (including the same-tier
and unknown-model cases and the effort floor), pinned models, up-only for model
and effort, absent and numeric efforts, the `max` rank, the alias table,
`supportsEffort`, `pendingDecisions`' sequences, and the three describe
functions.
