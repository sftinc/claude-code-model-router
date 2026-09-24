import { describe, expect, test } from 'claude-code/testing'

import { drain, promptOf, spawnOf, stepOf, worldOf } from './fixtures/world.ts'

describe('model-router', () => {
  test('a Haiku request never carries effort, on every step of the turn', async ($, on) => {
    const world = worldOf(on)
    await drain($.turn.step(stepOf('t1', 0, 'claude-haiku-4-5-20251001', 'high')))
    await drain($.turn.step(stepOf('t1', 1, 'claude-haiku-4-5-20251001', 'high')))
    expect(world.steps.map((s) => [s.hasEffort, s.effort])).toEqual([
      [true, undefined],
      [true, undefined],
    ])
  })

  test('a Sonnet request with no decision keeps its effort', async ($, on) => {
    const world = worldOf(on)
    await drain($.turn.step(stepOf('t1', 0, 'claude-sonnet-5', 'medium')))
    expect(world.steps[0]?.effort).toBe('medium')
  })

  test('with no API configured, the built-in classifier never touches the main loop', async ($, on) => {
    const world = worldOf(on, { label: 'deep' })
    await $.prompt.submit(promptOf('rename getUser to fetchUser'))
    expect(world.classified).toBe(0)
    expect(world.lines.some((line) => line.includes('routes: subagent model'))).toBe(true)
  })

  test('unreadable history does not matter when the main loop cannot change', async ($, on) => {
    const world = worldOf(on, { label: 'deep', history: 'fail' })
    await $.prompt.submit(promptOf('ok, go ahead'))
    await drain($.turn.step(stepOf('t1', 0, 'claude-sonnet-5', 'high')))
    expect(world.classified).toBe(0)
    expect(world.lines.some((line) => line.includes('session history unavailable'))).toBe(false)
    expect(world.steps[0]?.effort).toBe('high')
  })

  test('an empty prompt is not classified', async ($, on) => {
    const world = worldOf(on, { label: 'deep' })
    await $.prompt.submit(promptOf('   '))
    expect(world.classified).toBe(0)
  })

  test('a subagent with no model of its own moves up on the built-in answer', async ($, on) => {
    const world = worldOf(on, { label: 'deep' })
    await $.agent.spawn(spawnOf())
    expect(world.spawned).toEqual(['opus'])
  })

  test("a subagent model the Agent tool named is kept", async ($, on) => {
    const world = worldOf(on, { label: 'deep' })
    await $.agent.spawn(spawnOf({ model: 'haiku' }))
    expect(world.spawned).toEqual(['haiku'])
    expect(world.lines.some((line) => line.includes('agent chose haiku'))).toBe(true)
  })

  test('a fork passes through unclassified', async ($, on) => {
    const world = worldOf(on, { label: 'deep' })
    await $.agent.spawn(spawnOf({ fork: true }))
    expect(world.spawned).toEqual([undefined])
    expect(world.classified).toBe(0)
  })

  test('a blank subagent prompt is not classified', async ($, on) => {
    const world = worldOf(on, { label: 'deep' })
    await $.agent.spawn(spawnOf({ prompt: '   ' }))
    expect(world.classified).toBe(0)
  })
})
