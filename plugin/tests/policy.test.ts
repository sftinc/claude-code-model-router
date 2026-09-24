import { describe, expect, test } from 'claude-code/testing'

import {
  EFFORT_ORDER,
  TIER_ORDER,
  describeDecision,
  describeSetup,
  describeStatus,
  effortName,
  effortRank,
  pendingDecisions,
  rankOf,
  requestModelId,
  route,
  supportsEffort,
} from '../hooks/policy.ts'
import type { Decision, PolicyConfig } from '../hooks/policy.ts'

const CONFIG: PolicyConfig = {
  tiers: { fast: 'haiku', balanced: 'sonnet', deep: 'opus' },
  minUpgradeConfidence: 0.3,
  minDowngradeConfidence: 0.6,
  riskyThreshold: 0.7,
}

const SONNET = 'claude-sonnet-5'
const OPUS = 'claude-opus-5-5'
const HAIKU = 'claude-haiku-4-5-20251001'

/** A decision with no effort and no risk; override what a case needs. */
const decide = (patch: Partial<Decision> = {}): Decision => ({
  tier: 'balanced',
  confidence: 0.9,
  risky: null,
  effort: null,
  effortConfidence: null,
  classifier: 'jev',
  upOnly: false,
  ...patch,
})

describe('ladders', () => {
  test('tiers and efforts are listed cheapest first', () => {
    expect([...TIER_ORDER]).toEqual(['fast', 'balanced', 'deep'])
    expect([...EFFORT_ORDER]).toEqual(['low', 'medium', 'high', 'xhigh'])
  })

  test('effortName drops fractions and clamps to the ladder', () => {
    expect(effortName(0)).toBe('low')
    expect(effortName(2)).toBe('high')
    expect(effortName(2.9)).toBe('high')
    expect(effortName(3)).toBe('xhigh')
    expect(effortName(7)).toBe('xhigh')
    expect(effortName(-1)).toBe('low')
  })

  test('effortRank places named efforts, puts max above xhigh, and knows nothing else', () => {
    expect(effortRank('low')).toBe(0)
    expect(effortRank('xhigh')).toBe(3)
    expect(effortRank('max')).toBe(4)
    expect(effortRank('turbo')).toBeNull()
    expect(effortRank(2)).toBeNull()
    expect(effortRank(undefined)).toBeNull()
  })
})

describe('rankOf', () => {
  test('a configured tier value is found case-insensitively', () => {
    expect(rankOf('Claude-Haiku-4-5', CONFIG.tiers)).toBe(0)
    expect(rankOf(SONNET, CONFIG.tiers)).toBe(1)
    expect(rankOf('claude-opus-5-5[1m]', CONFIG.tiers)).toBe(2)
  })

  test('configured values are checked before families, cheapest tier first', () => {
    const tiers = { fast: 'my-small', balanced: 'opus', deep: 'my-big' }
    expect(rankOf('corp/my-small-2', tiers)).toBe(0)
    expect(rankOf(OPUS, tiers)).toBe(1)
    expect(rankOf('my-big', tiers)).toBe(2)
  })

  test('an empty configured value never matches, and families fill in', () => {
    const tiers = { fast: '', balanced: '', deep: '' }
    expect(rankOf(HAIKU, tiers)).toBe(0)
    expect(rankOf(SONNET, tiers)).toBe(1)
    expect(rankOf('claude-fable-5-1', tiers)).toBe(2)
    expect(rankOf('claude-mythos-1', tiers)).toBe(2)
    expect(rankOf('OPUS', tiers)).toBe(2)
  })

  test('an unrecognised model has no position', () => {
    expect(rankOf('gpt-something', CONFIG.tiers)).toBeNull()
  })
})

describe('model ids', () => {
  test('aliases expand after trimming and lowercasing', () => {
    expect(requestModelId('haiku')).toBe(HAIKU)
    expect(requestModelId(' Sonnet ')).toBe(SONNET)
    expect(requestModelId('OPUS')).toBe(OPUS)
    expect(requestModelId('fable')).toBe('claude-fable-5-1')
  })

  test('anything that is not an alias comes back unchanged', () => {
    expect(requestModelId('claude-sonnet-4-5')).toBe('claude-sonnet-4-5')
    expect(requestModelId(' custom ')).toBe(' custom ')
  })

  test('only Haiku models refuse effort', () => {
    expect(supportsEffort(HAIKU)).toBe(false)
    expect(supportsEffort('HAIKU')).toBe(false)
    expect(supportsEffort(SONNET)).toBe(true)
    expect(supportsEffort('something-else')).toBe(true)
  })
})

describe('route: model', () => {
  test('no decision changes nothing and says so', () => {
    const r = route(null, { model: SONNET, effort: 'high' }, CONFIG)
    expect([r.model, r.effort]).toEqual([null, null])
    expect(r.reason.includes('no decision')).toBe(true)
  })

  test('an upgrade passes at the upgrade bar and fails just below it', () => {
    expect(route(decide({ tier: 'deep', confidence: 0.3 }), { model: SONNET }, CONFIG).model).toBe('opus')
    expect(route(decide({ tier: 'deep', confidence: 0.29 }), { model: SONNET }, CONFIG).model).toBeNull()
  })

  test('a downgrade passes at the downgrade bar and fails just below it', () => {
    expect(route(decide({ tier: 'fast', confidence: 0.6 }), { model: SONNET }, CONFIG).model).toBe('haiku')
    expect(route(decide({ tier: 'fast', confidence: 0.59 }), { model: SONNET }, CONFIG).model).toBeNull()
  })

  test('with no confidence, upgrades pass and downgrades do not', () => {
    expect(route(decide({ tier: 'deep', confidence: null }), { model: SONNET }, CONFIG).model).toBe('opus')
    expect(route(decide({ tier: 'fast', confidence: null }), { model: SONNET }, CONFIG).model).toBeNull()
  })

  test('a move away from an unknown model counts as an upgrade', () => {
    expect(route(decide({ tier: 'fast', confidence: 0.3 }), { model: 'mystery' }, CONFIG).model).toBe('haiku')
    expect(route(decide({ tier: 'fast', confidence: null }), { model: 'mystery' }, CONFIG).model).toBe('haiku')
    expect(route(decide({ tier: 'fast', confidence: 0.2 }), { model: 'mystery' }, CONFIG).model).toBeNull()
  })

  test('a model already in the wanted tier is kept, even a different version', () => {
    const r = route(decide({ tier: 'balanced', confidence: 1 }), { model: 'claude-sonnet-4-5' }, CONFIG)
    expect(r.model).toBeNull()
  })

  test('an empty tier value or the exact current model changes nothing', () => {
    const tiers = { ...CONFIG.tiers, deep: '' }
    expect(route(decide({ tier: 'deep' }), { model: SONNET }, { ...CONFIG, tiers }).model).toBeNull()
    expect(route(decide({ tier: 'balanced' }), { model: 'sonnet' }, CONFIG).model).toBeNull()
  })

  test('with no switch, the reason mentions both models, the confidence and the raise-only flag', () => {
    const r = route(decide({ tier: 'fast', confidence: 0.4, upOnly: true }), { model: SONNET, effort: 'high' }, CONFIG)
    for (const bit of [SONNET, 'haiku', 'fast', '0.40', 'raise-only', 'effort high']) {
      expect(r.reason.includes(bit)).toBe(true)
    }
  })

  test('with no switch and no confidence, the reason says it was unreported', () => {
    const r = route(decide({ tier: 'fast', confidence: null }), { model: SONNET }, CONFIG)
    expect(r.reason.includes('confidence unreported')).toBe(true)
    expect(r.reason.includes('/')).toBe(false)
  })

  test('a change names its tier and confidence', () => {
    const r = route(decide({ tier: 'deep', confidence: 0.75 }), { model: SONNET }, CONFIG)
    expect(r.reason.includes('deep')).toBe(true)
    expect(r.reason.includes('0.75')).toBe(true)
  })
})

describe('route: pinned and up-only', () => {
  test('a pinned model is kept whatever the confidence, with its own wording', () => {
    const r = route(decide({ tier: 'deep', confidence: 1 }), { model: 'haiku', pinned: true }, CONFIG)
    expect(r.model).toBeNull()
    expect(r.reason.includes('agent chose haiku')).toBe(true)
  })

  test('up-only allows a confident upgrade', () => {
    expect(route(decide({ tier: 'deep', upOnly: true }), { model: SONNET }, CONFIG).model).toBe('opus')
  })

  test('up-only refuses a downgrade however confident', () => {
    expect(route(decide({ tier: 'fast', confidence: 1, upOnly: true }), { model: SONNET }, CONFIG).model).toBeNull()
  })

  test('up-only refuses to move away from an unknown model', () => {
    expect(route(decide({ tier: 'deep', confidence: 1, upOnly: true }), { model: 'mystery' }, CONFIG).model).toBeNull()
  })

  test('up-only raises effort but never lowers it or leaves an unknown one', () => {
    const up = decide({ effort: 3, effortConfidence: 1, upOnly: true })
    expect(route(up, { model: SONNET, effort: 'low' }, CONFIG).effort).toBe('xhigh')
    const down = decide({ effort: 0, effortConfidence: 1, upOnly: true })
    expect(route(down, { model: SONNET, effort: 'high' }, CONFIG).effort).toBeNull()
    expect(route(up, { model: SONNET, effort: 'turbo' }, CONFIG).effort).toBeNull()
  })
})

describe('route: risk', () => {
  const risky = (patch: Partial<Decision> = {}) => decide({ tier: 'fast', confidence: 0.1, risky: 0.9, ...patch })

  test('risk above the threshold forces the deep tier, ignoring confidence', () => {
    const r = route(risky(), { model: SONNET }, CONFIG)
    expect(r.model).toBe('opus')
    expect(r.reason.includes('risk')).toBe(true)
  })

  test('risk exactly at the threshold forces nothing', () => {
    expect(route(risky({ risky: 0.7 }), { model: SONNET }, CONFIG).model).toBeNull()
  })

  test('forced risk overrides a pin and up-only', () => {
    expect(route(risky({ upOnly: true }), { model: 'haiku', pinned: true }, CONFIG).model).toBe('opus')
  })

  test('forced risk keeps a model already in the deep tier', () => {
    expect(route(risky(), { model: 'claude-opus-5-5[1m]' }, CONFIG).model).toBeNull()
    expect(route(risky(), { model: 'claude-fable-5-1' }, CONFIG).model).toBeNull()
  })

  test('forced risk replaces an unknown model', () => {
    expect(route(risky(), { model: 'mystery' }, CONFIG).model).toBe('opus')
  })

  test('forced risk lifts effort to at least high, even with no effort in the decision', () => {
    expect(route(risky({ effort: 0, effortConfidence: 0 }), { model: OPUS, effort: 'low' }, CONFIG).effort).toBe('high')
    expect(route(risky(), { model: OPUS, effort: 'medium' }, CONFIG).effort).toBe('high')
    expect(route(risky({ effort: 3 }), { model: OPUS, effort: 'low' }, CONFIG).effort).toBe('xhigh')
  })

  test('when risk is forcing, an effort already at xhigh or max is left where it is', () => {
    for (const effort of ['xhigh', 'max']) {
      expect(route(risky({ effort: 2 }), { model: OPUS, effort }, CONFIG).effort).toBeNull()
    }
  })

  test('forced risk sets high on an unknown effort name', () => {
    expect(route(risky(), { model: OPUS, effort: 'turbo' }, CONFIG).effort).toBe('high')
  })
})

describe('route: effort', () => {
  test('an effort upgrade and downgrade each use their own bar', () => {
    const at = (level: number, conf: number, from: string) =>
      route(decide({ effort: level, effortConfidence: conf }), { model: SONNET, effort: from }, CONFIG).effort
    expect(at(3, 0.3, 'low')).toBe('xhigh')
    expect(at(3, 0.29, 'low')).toBeNull()
    expect(at(0, 0.6, 'high')).toBe('low')
    expect(at(0, 0.59, 'high')).toBeNull()
  })

  test('a null effort confidence lets effort rise but not fall', () => {
    expect(route(decide({ effort: 2 }), { model: SONNET, effort: 'low' }, CONFIG).effort).toBe('high')
    expect(route(decide({ effort: 0 }), { model: SONNET, effort: 'high' }, CONFIG).effort).toBeNull()
  })

  test('the same effort changes nothing', () => {
    expect(route(decide({ effort: 1, effortConfidence: 1 }), { model: SONNET, effort: 'medium' }, CONFIG).effort).toBeNull()
  })

  test('max counts as above xhigh, so moving to xhigh is a downgrade', () => {
    expect(route(decide({ effort: 3, effortConfidence: 0.5 }), { model: SONNET, effort: 'max' }, CONFIG).effort).toBeNull()
    expect(route(decide({ effort: 3, effortConfidence: 0.6 }), { model: SONNET, effort: 'max' }, CONFIG).effort).toBe('xhigh')
  })

  test('an unknown effort name counts as an upgrade', () => {
    expect(route(decide({ effort: 0, effortConfidence: 0.3 }), { model: SONNET, effort: 'turbo' }, CONFIG).effort).toBe('low')
  })

  test('a request without effort, or with a numeric one, is left alone', () => {
    const d = decide({ effort: 3, effortConfidence: 1 })
    expect(route(d, { model: SONNET }, CONFIG).effort).toBeNull()
    expect(route(d, { model: SONNET, effort: 1 }, CONFIG).effort).toBeNull()
  })

  test('a decision without effort leaves effort alone', () => {
    expect(route(decide(), { model: SONNET, effort: 'low' }, CONFIG).effort).toBeNull()
  })

  test('model and effort can change together', () => {
    const r = route(decide({ tier: 'deep', effort: 3, effortConfidence: 0.9 }), { model: SONNET, effort: 'low' }, CONFIG)
    expect([r.model, r.effort]).toEqual(['opus', 'xhigh'])
  })
})

describe('pendingDecisions: hand-off from prompts to turns', () => {
  const run = (puts: (Decision | null)[]) => {
    const handoff = pendingDecisions()
    for (const d of puts) handoff.put(d)
    return handoff
  }

  describe('a lone prompt', () => {
    test('its decision reaches the next turn, and only that turn', () => {
      const d = decide()
      const handoff = run([d])
      expect(handoff.take()).toEqual(d)
      expect(handoff.take()).toBeNull()
    })

    test('a null (unclassified) prompt reaches the turn as nothing', () => {
      expect(run([null]).take()).toBeNull()
    })

    test('a turn with no prompt before it gets nothing', () => {
      expect(run([]).take()).toBeNull()
    })
  })

  describe('several prompts before one turn', () => {
    test('two decisions cancel out', () => {
      expect(run([decide({ tier: 'fast' }), decide({ tier: 'deep' })]).take()).toBeNull()
    })

    test('a null followed by a decision is still two prompts', () => {
      expect(run([null, decide()]).take()).toBeNull()
    })

    test('three decisions give nothing too', () => {
      expect(run([decide(), decide(), decide()]).take()).toBeNull()
    })
  })

  test('after an ambiguous turn, the next single prompt is handed over as usual', () => {
    const handoff = run([decide(), decide()])
    handoff.take()
    const d = decide({ tier: 'deep' })
    handoff.put(d)
    expect(handoff.take()).toEqual(d)
  })
})

describe('log and status text', () => {
  const every = { subagentModel: true, mainEffort: true, mainModel: true }
  const none = { subagentModel: false, mainEffort: false, mainModel: false }
  const subagentOnly = { ...none, subagentModel: true }

  test('setup with the api shows its endpoint and joins the enabled switches', () => {
    expect(describeSetup('api', 'https://router.test/v1/classify', every)).toBe(
      'classifier = api https://router.test/v1/classify; routes: subagent model + main effort + main model',
    )
  })

  test('setup distinguishes a built-in classifier picked in options from one used for lack of an API', () => {
    expect(describeSetup(null, '', subagentOnly, true)).toBe(
      'classifier = engine built-in (picked in options); routes: subagent model',
    )
    expect(describeSetup(null, '', subagentOnly)).toBe(
      'classifier = engine built-in (no API configured); routes: subagent model',
    )
  })

  test('setup with every switch off says so', () => {
    expect(describeSetup(null, '', none).endsWith('routes: none (every switch is off)')).toBe(true)
  })

  test('a missing verdict reads as nothing came back, with the time when there is one', () => {
    expect(describeDecision(null, null)).toBe('nothing came back')
    expect(describeDecision(null, 12.4)).toBe('nothing came back after 12ms')
  })

  test('a full verdict shows tier, effort, risk, the raise-only flag, classifier and whole ms', () => {
    const d = decide({ confidence: 0.823, effort: 2, effortConfidence: 0.5, risky: 0.04, upOnly: true })
    expect(describeDecision(d, 41.6)).toBe('balanced@0.82, effort 2=high@0.50, risk 0.04, raise-only (jev, 42ms)')
  })

  test('a built-in verdict shows only its tier, with a marker for the missing confidence', () => {
    expect(describeDecision(decide({ classifier: null, confidence: null }), null)).toBe('balanced@?')
  })

  test('the status line names the change, with the verdict when there is one', () => {
    const d = decide({ tier: 'deep', confidence: 0.9 })
    expect(describeStatus(null, { effort: undefined })).toBe('router ⇒ no effort')
    expect(describeStatus(d, { model: OPUS, effort: 'high' })).toBe(`router deep@0.90 ⇒ ${OPUS} high`)
    expect(describeStatus(d, { effort: 'xhigh' })).toBe('router deep@0.90 ⇒ xhigh')
  })

  test('the status line reads an effort key holding undefined as no effort', () => {
    const d = decide({ tier: 'fast', confidence: 0.7 })
    expect(describeStatus(d, { model: HAIKU, effort: undefined })).toBe(`router fast@0.70 ⇒ ${HAIKU} no effort`)
    expect(describeStatus(d, { model: SONNET })).toBe(`router fast@0.70 ⇒ ${SONNET}`)
  })
})
