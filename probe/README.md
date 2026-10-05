# probe

Tools for checking Jev's routing decisions against what each turn actually needed. Each run lives in `probe/logs/<run>/`, which git ignores because the logs hold prompts and transcript snippets.

Needs `jq`, `curl`, Node 24, and two values in `worker/.env`:

- `ROUTER_GATEWAY_TOKEN`: a Cloudflare API token with **AI Gateway Read**.
- `CLOUDFLARE_ACCOUNT_ID`: the account that owns the `model-router` gateway.

## 1. Pull

```bash
probe/pull.sh          # the newest 200 calls
probe/pull.sh 400      # or any other count
```

This makes `probe/logs/<date-time>/` with:

- `requests.jsonl`: one call per line, with the gateway's metadata (time, duration, tokens, cost, Worker version), `request` (the situation sent to Jev) and `response` (Jev's answer).
- `batches/batch-*.jsonl`: the same calls, 25 per file, with only `{id, state}`, so a labeler can't see what Jev said.

## 2. Label

Ask Claude Code:

> Label `probe/logs/<run>`: one subagent per batch, each following `probe/label-prompt.md`.

Each subagent writes `labels/<batch>.jsonl`, one `{id, tier, effort, reason}` per call: the cheapest tier and lowest effort that would do the turn well. Labels are a stronger model's judgment, not truth, so spot-check the disagreements that matter.

## 3. Score

```bash
node probe/score.ts probe/logs/<run>
```

This prints a separate report for main turns and for subagent turns (by the log's `metadata.source`). Jev sees the conversation for a main turn but only the prompt for a subagent, so the two miss in different ways. Each report has:

- **Tier and effort matrices:** label against Jev's answer. Off-diagonal cells are the disagreements.
- **Routing rules:** for each rule in `RULES`, what the turns would have been sent to, from two starting points (Opus/high, Sonnet/medium). `o/r/u` counts turns that ended over, right, or under the label. `haiku miss` counts non-fast work sent to Haiku, the costliest kind of miss. Effort leaves out Haiku turns, since Haiku takes no effort.

It also writes `compared.jsonl`, one row per call with Jev's answer and the label side by side. To try another rule, add a line to `RULES` in `score.ts`.

## 4. Replay with other questions

```bash
cp probe/questions/current.ts probe/questions/v2-a.ts   # a draft of the next version; then edit QUESTIONS in it
node probe/replay.ts probe/logs/<run> v2-a
node probe/score.ts probe/logs/<run> v2-a
```

`replay.ts` sends every call's situation back to Jev with that file's `QUESTIONS`, writing `replays/<name>.jsonl`. `score.ts` then scores those answers against the same labels, and writes `compared-<name>.jsonl`. Replays call Workers AI directly, not through the gateway, so they never show up in a later pull. Each full replay costs about $0.02.

`probe/questions/current.ts` re-exports the questions the Worker asks today, from `worker/src/classifiers/jev-questions.ts`. Replay it first: comparing it with the logged answers shows how much Jev's answers vary from run to run, so you know how big a change has to be before it counts.

Log each round in [`RESULTS.md`](RESULTS.md): the starting questions and numbers, what shipped and its numbers, and one line for each variant dropped. Commit the dropped variants' files once, then delete them after the round ships, so their text stays in git history. The repo is public, so describe misses in general terms and never quote prompts or transcripts from the logs.

Replay needs its own token, since running a model takes both Workers AI Read and Edit: create one from the **Workers AI API Token** template and add it to `worker/.env` as `ROUTER_AI_TOKEN`.

## 5. Ship a round

Once a variant is chosen:

1. **Questions.** Copy its wording into `worker/src/classifiers/jev-questions.ts`, and check the live questions now match what you tested:

   ```bash
   node -e "Promise.all([import('./worker/src/classifiers/jev-questions.ts'), import('./probe/questions/<name>.ts')]).then(([a, b]) => console.log(JSON.stringify(a.QUESTIONS) === JSON.stringify(b.QUESTIONS) ? 'identical' : 'DIFFERENT'))"
   ```

2. **Routing rule, if it changed.** The Worker turns Jev's answer into a tier and effort in `tierFrom` and `effortFrom` in `worker/src/classifiers/jev.ts`. Change those, then update the `live` line in `RULES` in `score.ts` to match. If the plugin should gate differently, its defaults are in `OPTION_DEFAULTS` in `plugin/hooks/model-router.ts`, `plugin/.claude-plugin/plugin.json` and the options table in the root `README.md`; change all three together.
3. **Tests.** Update the Worker tests in `worker/test/jev.spec.ts` for any rule change, then run:

   ```bash
   cd worker && npm test && npm run typecheck && cd ..
   worker/node_modules/.bin/tsc -p plugin/tsconfig.json
   claude plugin test plugin
   claude plugin validate plugin
   ```

4. **Results.** In `RESULTS.md`, turn the round's *Chosen* entry into *Shipped*, with the date and what changed where.
5. **Cleanup.** Delete the round's variant files from `probe/questions/`. They're in the commit that logged the round, so name that commit under *Tried and dropped*. Keep `current.ts`.
6. **Deploy.** Deploy the Worker first, then push: the plugin updates follow the commit on `main`, so pushing is what ships the plugin side.

   ```bash
   cd worker && npm run deploy
   set -a && . ./.env && set +a && scripts/live-check.sh && cd ..
   git push
   ```

7. **Next round.** After a few days of real use, pull a fresh run and score it. Those numbers are the next round's starting point.

## Reading the misses

```bash
R=probe/logs/<run>/compared.jsonl

# Turns Jev put above the label
jq -r 'select(.labelTier == "fast" and .jevTier != "fast") | "\(.prompt[0:80]) || \(.reason)"' $R

# Turns where Jev's likeliest effort was xhigh
jq -c 'select((.jevEffortP | to_entries | max_by(.value) | .key) == "3") | {prompt: .prompt[0:80], p: .jevEffortP, label: .labelEffort}' $R

# The full situation Jev saw for one call
jq 'select(.id == "<id>") | .request.state' probe/logs/<run>/requests.jsonl
```
