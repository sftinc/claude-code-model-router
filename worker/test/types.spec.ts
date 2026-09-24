import { describe, expect, test } from 'vitest'
import { isSituation } from '../src/types'

describe('isSituation', () => {
  test('accepts a main situation with recent messages', () => {
    expect(isSituation({ source: 'main', prompt: 'go', recent: [{ role: 'user', text: 'hi' }] })).toBe(true)
  })

  test('accepts a subagent situation', () => {
    expect(isSituation({ source: 'subagent', prompt: 'find callers', description: 'd', agentType: 'Explore' })).toBe(true)
  })

  test('refuses an unknown source', () => {
    expect(isSituation({ source: 'other', prompt: 'go' })).toBe(false)
  })

  test('refuses an empty or blank prompt', () => {
    expect(isSituation({ source: 'main', prompt: '' })).toBe(false)
    expect(isSituation({ source: 'main', prompt: '   ' })).toBe(false)
  })

  test('refuses malformed recent entries', () => {
    expect(isSituation({ source: 'main', prompt: 'go', recent: 'hi' })).toBe(false)
    expect(isSituation({ source: 'main', prompt: 'go', recent: [{ role: 'system', text: 'x' }] })).toBe(false)
    expect(isSituation({ source: 'main', prompt: 'go', recent: [{ role: 'user' }] })).toBe(false)
  })

  test('refuses non-string subagent fields and non-objects', () => {
    expect(isSituation({ source: 'subagent', prompt: 'go', agentType: 3 })).toBe(false)
    expect(isSituation(null)).toBe(false)
    expect(isSituation([])).toBe(false)
  })
})
