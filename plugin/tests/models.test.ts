import { describe, expect, test } from 'claude-code/testing'

import { DEFAULT_TIERS, MODELS } from '../hooks/models.ts'
import { spawnOf, worldOf } from './fixtures/world.ts'

describe('models', () => {
  // plugin.json can't import code, so its tier defaults are a second copy. The
  // test harness loads the plugin with plugin.json's defaults; from a model the
  // router doesn't know, each tier sends its configured model.
  for (const [tier, alias] of Object.entries(DEFAULT_TIERS)) {
    test(`plugin.json's ${tier} default is ${alias}, as DEFAULT_TIERS says`, async ($, on) => {
      const world = worldOf(on, { label: tier })
      await $.agent.spawn(spawnOf({ parentModel: 'mystery' }))
      expect(world.spawned).toEqual([alias])
    })
  }

  test('every default names a model in the list, in its own tier', () => {
    for (const [tier, alias] of Object.entries(DEFAULT_TIERS)) {
      expect(MODELS.find((model) => model.alias === alias)?.tier).toBe(tier)
    }
  })
})
