# Probe results

What we changed in Jev's questions, one entry per round, newest at the bottom. A round runs from one shipped set of questions to the next: where it started, what shipped, and one line for each variant tried and dropped. The dropped variants' full text stays in git history. No prompts or transcripts go in here, only the questions and the numbers.

**How to read the numbers.** "Right" means Jev's answer matched the blind label for that call. Effort uses Jev's likeliest level. Routing rows replay each answer through a rule with every turn starting on Opus at high effort: `o/r/u` counts turns that ended over, right, or under the label, "Haiku miss" counts non-fast work sent to Haiku, and effort leaves out Haiku turns.

## Round 1: judge the work, not how it sounds

**Run.** `2026-09-27`: 200 calls from one developer's Claude Code sessions, September 24 to 27, 2026 (191 main-agent turns, 9 subagents), all from the same Worker version. Claude subagents labeled them blind from [`label-prompt.md`](label-prompt.md): 90 fast, 104 balanced, 6 deep.

**Noise.** Replaying the live questions reproduced 195 of 200 tiers and 192 of 200 effort levels. A change has to move more than about 5 tier picks to count.

### Starting point

The questions in `worker/src/classifiers/jev-questions.ts` as of `f003aa2`.

**Tier.** *Which rung best matches the judgment `prompt` demands and the cost of getting it wrong? Read it alongside `recent` if that is given, and, for a subagent, alongside its `description` and `agentType`.*

- fast: *Hardly any judgment is called for. The right result is plain once the request is read, and a slip would show up at once and take moments to put right.*
- balanced: *Ordinary engineering judgment is called for inside settled bounds. The way forward is known, and a slip would most likely be caught by review or tests before it did harm.*
- deep: *Sustained judgment is called for because the right path is not obvious, and a slip could be expensive, slow to come to light, or hard to trace back to its cause.*

**Effort.** *Which of these situations best describes the work `prompt` asks for, reading it alongside `recent` if that is given?*

0. *The answer or edit is obvious from context.*
1. *A routine change with a clear approach.*
2. *Several interacting parts, or an unclear cause.*
3. *A design decision, subtle bug, or high-stakes change where mistakes are costly.*

**What went wrong.**

- Stakes wording ("the cost of getting it wrong", "high-stakes change") pushes routine work up. A plain commit, merge, push and deploy request came back balanced with high or xhigh effort every time. Stakes already have their own question, `risky`.
- Short questions that need code read to answer come back fast.
- Short approvals ("yes, go ahead", "3") are judged by their words, not the work they start. None of the 6 deep calls was called deep.
- Taking the likeliest effort level turns close splits into xhigh: 40 picks against 2 in the labels.
- Jev's tier confidence is low (median 0.44), so the plugin's 0.6 bar for moving down blocks most moves. That, more than Jev's picks, keeps turns on the big model.

### Chosen: v2a

**Status: chosen, not live.** The Worker still asks the starting-point questions. v2a ships together with the new routing rule below, since it does worse under today's rule; this entry changes to *Shipped* with the commit that does it.

The tier ladder and `risky` stay as they were. Both the tier and effort instructions gain this context:

> The model that answers `prompt` carries out the whole turn itself, reading code, running commands and editing files as needed. If `prompt` is a short reply (an approval, a pick like "2", "yes", "go ahead"), judge the work it sets in motion, read from `recent`. A question can take as much work as a change: judge what finding the answer takes, not how short the question is. Judge how hard the work is to do right, not how serious or risky its subject sounds.
>
> When `prompt` is a notice that background work finished (a <task-notification> or an agent's report), the work is already done: judge only what is left to do with the result.

The tier instructions drop "and the cost of getting it wrong". The effort instructions become *How much working out does the work behind `prompt` take?*, and the effort criteria drop the stakes clause:

0. *The answer or action is already clear; carrying it out needs no working out.*
1. *A routine change or lookup with a clear approach.*
2. *Several interacting parts to hold together, or a cause that is not yet clear.*
3. *A hard design decision or a subtle bug, where careful reasoning is what gets it right.*

| Questions | Tier right | Fast / balanced / deep right | Non-fast called fast | Effort right | Picked xhigh |
|---|---|---|---|---|---|
| starting point | 114 | 44 / 70 / 0 | 28 | 88 | 40 |
| v2a | 126 | 52 / 74 / 0 | 29 | 108 | 11 |

| Questions | Rule | Tier o/r/u | Haiku miss | Effort o/r/u |
|---|---|---|---|---|
| starting point | today (0.6 to move down, likeliest effort) | 154/41/5 | 4 | 128/52/2 |
| starting point | Haiku at P(fast) ≥ 0.7, Opus at P(deep) ≥ 0.4, effort from score | 76/110/14 | 8 | 56/99/18 |
| v2a | today | 163/31/6 | 6 | 115/65/2 |
| v2a | follow Jev, effort from score | 40/126/34 | 29 | 30/67/22 |
| v2a | Haiku at P(fast) ≥ 0.7, Opus at P(deep) ≥ 0.4, effort from score | 76/110/14 | 9 | 45/102/29 |

v2a is less confident than the starting point, so under today's routing rule it does worse. It only pays off shipped together with a new rule.

**Still open.** No deep call is caught, short approvals still read as fast, and about 29 balanced calls are still called fast.

### Tried and dropped

- **v1:** rewrote the tier ladder as kinds of work, with examples. Effort improved, but tier fell to 103 right: the examples pulled balanced work into both fast and deep, and background notices jumped to deep. The notice rule in v2a came from this.
- **v2b:** v1 plus the notice rule. Tier fell further, to 101 right, with 48 non-fast calls sent to fast. v1's ladder was the problem, not the notices.
