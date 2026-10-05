# Probe results

What we changed in Jev's questions, one entry per round, newest at the bottom. A round runs from one shipped set of questions to the next: where it started, what shipped, and one line for each variant tried and dropped. The dropped variants' full text stays in git history. No prompts or transcripts go in here, only the questions and the numbers.

**Names.** Shipped questions are numbered: v0 is the original set, v1 the first change shipped, and so on. Drafts inside a round are named after the version they aim at (v2-a, v2-b, …); the one that ships becomes the plain number, and the rest go under *Tried and dropped*.

**How to read the numbers.** "Right" means Jev's answer matched the blind label for that call. Effort uses Jev's likeliest level. Routing rows replay each answer through a rule with every turn starting on Opus at high effort: `o/r/u` counts turns that ended over, right, or under the label, "Haiku miss" counts non-fast work sent to Haiku, and effort leaves out Haiku turns.

## Round 1: v0 → v1, judge the work, not how it sounds

**Run.** `2026-09-27`: 200 calls from one developer's Claude Code sessions, September 24 to 27, 2026 (191 main-agent turns, 9 subagents), all from the same Worker version. Claude subagents labeled them blind from [`label-prompt.md`](label-prompt.md): 90 fast, 104 balanced, 6 deep.

**Noise.** Replaying the live questions reproduced 195 of 200 tiers and 192 of 200 effort levels. A change has to move more than about 5 tier picks to count.

### Starting point: v0

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

### Shipped: v1 (draft v1-b), with a new routing rule

**Status: live since 2026-09-27, Worker version `4487dd8e`.** The wording below is in `worker/src/classifiers/jev-questions.ts`. The Worker now picks the tier from Jev's probabilities (fast at P(fast) ≥ 0.7, deep at P(deep) ≥ 0.4, balanced otherwise) and effort from its weighted score (`floor(score + 0.25)`), in `tierFrom` and `effortFrom` in `worker/src/classifiers/jev.ts`. The plugin's `minUpgradeConfidence` and `minDowngradeConfidence` defaults went from 0.3 and 0.6 to 0, so it follows the Worker.

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
| v0 | 114 | 44 / 70 / 0 | 28 | 88 | 40 |
| v1 | 126 | 52 / 74 / 0 | 29 | 108 | 11 |

| Questions | Rule | Tier o/r/u | Haiku miss | Effort o/r/u |
|---|---|---|---|---|
| v0 | old rule (0.6 to move down, likeliest effort) | 154/41/5 | 4 | 128/52/2 |
| v0 | Haiku at P(fast) ≥ 0.7, Opus at P(deep) ≥ 0.4, effort from score | 76/110/14 | 8 | 56/99/18 |
| v1 | old rule | 163/31/6 | 6 | 115/65/2 |
| v1 | follow Jev, effort from score | 40/126/34 | 29 | 30/67/22 |
| v1 | Haiku at P(fast) ≥ 0.7, Opus at P(deep) ≥ 0.4, effort from score | 76/110/14 | 9 | 45/102/29 |

v1 is less confident than v0, so under the old routing rule it did worse. That is why it shipped together with the new rule: the last row is what runs now.

**Still open.** No deep call is caught, short approvals still read as fast, and about 29 balanced calls are still called fast.

### Tried and dropped

Their question files are in git at `a112cea`, under `probe/questions/`, with their names from then: `v1.ts` is v1-a, `v2a.ts` is v1-b (shipped) and `v2b.ts` is v1-c.


- **v1-a:** rewrote the tier ladder as kinds of work, with examples. Effort improved, but tier fell to 103 right: the examples pulled balanced work into both fast and deep, and background notices jumped to deep. The notice rule in v1-b came from this.
- **v1-c:** v1-a plus the notice rule. Tier fell further, to 101 right, with 48 non-fast calls sent to fast. v1-a's ladder was the problem, not the notices.

## Round 2: v1, a higher Opus bar for subagents

Questions unchanged; only the routing rule moved. From this round on, `score.ts` scores main and subagent turns apart: Jev sees the conversation for a main turn but only the brief for a subagent, so they miss in different ways.

**Run.** `2026-10-05-1436`: 403 calls from October 3 (22:16 UTC, once the plugin again classified subagents the agent named a model for) to October 5, 2026: 321 main-agent turns, 82 subagents, all on Worker version `4487dd8e`. Five calls had no stored body and were left out. Labeled blind as in round 1: main 108 fast, 196 balanced, 17 deep; subagents 5 fast, 73 balanced, 4 deep.

### Starting point: v1 with round 1's rule

| Turns | Tier o/r/u | Haiku miss | Effort o/r/u | Deep caught |
|---|---|---|---|---|
| main (321) | 73/230/18 | 11 | 62/131/75 | 10 of 17 |
| subagent (82) | 40/42/0 | 0 | 16/59/3 | 4 of 4 |

Main turns did better than in round 1 (72% of tiers right against 55%), and deep calls are now caught, but effort leans under. Subagents go to Opus far too often: long, detailed briefs read as deep work, and the P(deep) ≥ 0.4 bar sends 44 of 82 there when the labels put 4.

### Shipped: subagent Opus at P(deep) ≥ 0.6

**Status: live since 2026-10-05, Worker version `2bd86ac4`.** `tierFrom` in `worker/src/classifiers/jev.ts` takes the situation's source and needs P(deep) ≥ 0.6 for a subagent; main turns keep 0.4.

| Subagent Opus bar | Tier o/r/u | Deep caught |
|---|---|---|
| 0.4 (round 1) | 40/42/0 | 4 of 4 |
| 0.5 | 22/60/0 | 4 of 4 |
| **0.6** | **14/68/0** | **4 of 4** |
| 0.7 | 9/72/1 | 3 of 4 |

The lowest P(deep) on a deep-labeled subagent was 0.68, but there were only 4 of them, so check the bar again once a run has more. For main turns a higher bar didn't pay: at 0.5, two more tiers were right and three more were under.

**Still open.** Main-turn effort is under the label on 75 of 268 non-Haiku turns. The 14 subagents still over are briefs with P(deep) from 0.6 to 0.96, which the probabilities alone can't tell apart from real deep work.
