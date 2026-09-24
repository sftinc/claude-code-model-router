import { describe, expect, test } from 'vitest'
import { argmaxHigh, confidenceOf } from '../src/confidence'

describe('argmaxHigh', () => {
  test('picks the most probable level', () => {
    expect(argmaxHigh({ '0': 0.2, '1': 0.7, '2': 0.1 })).toBe(1)
  })

  test('a tie goes to the higher level', () => {
    expect(argmaxHigh({ '0': 0.5, '2': 0.5 })).toBe(2)
  })
})

describe('confidenceOf', () => {
  test('matches TypeSafe: p_max 0.61 of 3 options is about 0.42', () => {
    expect(confidenceOf({ fast: 0.61, balanced: 0.2, deep: 0.19 }, 3)).toBeCloseTo(0.415, 3)
  })

  test('counts options missing from the map, since a zero-probability option may be left out', () => {
    expect(confidenceOf({ fast: 0.61, balanced: 0.39 }, 3)).toBeCloseTo(0.415, 3)
  })

  test('a uniform answer has zero confidence, a certain one full', () => {
    expect(confidenceOf({ a: 1 / 3, b: 1 / 3, c: 1 / 3 }, 3)).toBeCloseTo(0, 6)
    expect(confidenceOf({ a: 1 }, 3)).toBe(1)
  })

  test('no probabilities, or fewer than two options, gives null', () => {
    expect(confidenceOf({}, 3)).toBeNull()
    expect(confidenceOf({ a: 1 }, 1)).toBeNull()
  })
})
