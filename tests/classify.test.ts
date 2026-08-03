import { describe, expect, test } from 'bun:test'
import { classify, recommend } from '../src/classify'
import type { AccountUsage } from '../src/types'

function row(partial: Partial<AccountUsage> & { id: string }): AccountUsage {
  return {
    label: partial.id.toUpperCase(),
    fiveHourPct: null,
    fiveHourResetsAt: null,
    weeklyPct: 0,
    weeklyResetsAt: null,
    opusWeeklyPct: null,
    source: 'api',
    error: null,
    ...partial,
  }
}

describe('classify', () => {
  test('no active window is cold', () => {
    expect(classify(row({ id: 'a', fiveHourPct: null }))).toBe('cold')
  })

  test('below the hot threshold is warm', () => {
    expect(classify(row({ id: 'a', fiveHourPct: 69 }))).toBe('warm')
  })

  test('at the hot threshold is hot', () => {
    expect(classify(row({ id: 'a', fiveHourPct: 70 }))).toBe('hot')
  })

  test('at the limit is spent', () => {
    expect(classify(row({ id: 'a', fiveHourPct: 100 }))).toBe('spent')
  })

  test('an errored row is unknown', () => {
    expect(classify(row({ id: 'a', fiveHourPct: 10, error: { cause: 'auth', message: 'x' } })))
      .toBe('unknown')
  })

  test('zero percent with an active window is warm, not cold', () => {
    expect(classify(row({ id: 'a', fiveHourPct: 0, fiveHourResetsAt: new Date() }))).toBe('warm')
  })
})

describe('recommend', () => {
  test('picks the account with the most five-hour headroom', () => {
    const result = recommend([
      row({ id: 'a', fiveHourPct: 80, fiveHourResetsAt: new Date() }),
      row({ id: 'b', fiveHourPct: 20, fiveHourResetsAt: new Date() }),
    ])
    expect(result.useId).toBe('b')
  })

  test('treats a cold account as maximum headroom', () => {
    const result = recommend([
      row({ id: 'a', fiveHourPct: 20, fiveHourResetsAt: new Date() }),
      row({ id: 'b', fiveHourPct: null }),
    ])
    expect(result.useId).toBe('b')
  })

  test('breaks a five-hour tie on weekly headroom', () => {
    const result = recommend([
      row({ id: 'a', fiveHourPct: 20, fiveHourResetsAt: new Date(), weeklyPct: 80 }),
      row({ id: 'b', fiveHourPct: 20, fiveHourResetsAt: new Date(), weeklyPct: 10 }),
    ])
    expect(result.useId).toBe('b')
  })

  test('excludes spent accounts', () => {
    const result = recommend([
      row({ id: 'a', fiveHourPct: 100, fiveHourResetsAt: new Date() }),
      row({ id: 'b', fiveHourPct: 90, fiveHourResetsAt: new Date() }),
    ])
    expect(result.useId).toBe('b')
  })

  test('excludes errored accounts', () => {
    const result = recommend([
      row({ id: 'a', fiveHourPct: null, error: { cause: 'auth', message: 'x' } }),
      row({ id: 'b', fiveHourPct: 90, fiveHourResetsAt: new Date() }),
    ])
    expect(result.useId).toBe('b')
  })

  test('lists cold accounts so the caller can nudge priming', () => {
    const result = recommend([
      row({ id: 'a', fiveHourPct: 20, fiveHourResetsAt: new Date() }),
      row({ id: 'b', fiveHourPct: null }),
      row({ id: 'c', fiveHourPct: null }),
    ])
    expect(result.coldIds).toEqual(['b', 'c'])
  })

  test('reports no usable account and the earliest reset when all are spent', () => {
    const early = new Date('2026-08-03T10:00:00Z')
    const late = new Date('2026-08-03T14:00:00Z')
    const result = recommend([
      row({ id: 'a', fiveHourPct: 100, fiveHourResetsAt: late }),
      row({ id: 'b', fiveHourPct: 100, fiveHourResetsAt: early }),
    ])
    expect(result.useId).toBeNull()
    expect(result.earliestResetAt).toEqual(early)
    expect(result.reason).toMatch(/all accounts/i)
  })

  test('handles an empty account list', () => {
    const result = recommend([])
    expect(result.useId).toBeNull()
    expect(result.coldIds).toEqual([])
    expect(result.earliestResetAt).toBeNull()
  })
})
