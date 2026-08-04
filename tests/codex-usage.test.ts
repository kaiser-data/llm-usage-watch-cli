import { describe, expect, test } from 'bun:test'
import { normalizeCodexRateLimits } from '../src/codex-usage'

const MULTI_BUCKET = {
  rateLimits: {
    limitId: 'codex',
    planType: 'plus',
    primary: { usedPercent: 73, windowDurationMins: 10080, resetsAt: 1786175144 },
    secondary: null,
  },
  rateLimitsByLimitId: {
    codex: {
      limitId: 'codex',
      limitName: null,
      planType: 'plus',
      primary: { usedPercent: 73, windowDurationMins: 10080, resetsAt: 1786175144 },
      secondary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1785800000 },
    },
    codex_other: {
      limitId: 'codex_other',
      limitName: 'Other models',
      planType: 'plus',
      primary: { usedPercent: 42, windowDurationMins: 60, resetsAt: null },
      secondary: null,
    },
  },
}

describe('normalizeCodexRateLimits', () => {
  test('preserves every returned bucket and window', () => {
    const usage = normalizeCodexRateLimits(MULTI_BUCKET)

    expect(usage.provider).toBe('codex')
    expect(usage.plan).toBe('plus')
    expect(usage.error).toBeNull()
    expect(usage.limits.map(limit => limit.id)).toEqual(['codex', 'codex_other'])
    expect(usage.limits[0]!.windows.map(window => window.role)).toEqual([
      'primary',
      'secondary',
    ])
    expect(usage.limits[0]!.windows[0]).toEqual({
      role: 'primary',
      usedPct: 73,
      durationMinutes: 10080,
      resetsAt: new Date(1786175144 * 1000),
    })
    expect(usage.limits[1]!.name).toBe('Other models')
  })

  test('falls back to the backward-compatible single bucket', () => {
    const usage = normalizeCodexRateLimits({
      rateLimits: {
        limitId: null,
        planType: 'pro',
        primary: { usedPercent: 5, windowDurationMins: null, resetsAt: null },
        secondary: null,
      },
    })

    expect(usage.plan).toBe('pro')
    expect(usage.limits[0]!.id).toBe('codex')
    expect(usage.limits[0]!.windows[0]!.durationMinutes).toBeNull()
    expect(usage.limits[0]!.windows[0]!.resetsAt).toBeNull()
  })

  test('rejects invalid percentages', () => {
    expect(() => normalizeCodexRateLimits({
      rateLimits: { primary: { usedPercent: 101 } },
    })).toThrow(/usedPercent/)
  })

  test('rejects a response with no buckets', () => {
    expect(() => normalizeCodexRateLimits({ rateLimitsByLimitId: {} }))
      .toThrow(/no rate-limit/)
  })
})
