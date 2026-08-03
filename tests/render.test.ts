import { describe, expect, test } from 'bun:test'
import { bar, formatDuration, renderTable } from '../src/render'
import { recommend } from '../src/classify'
import { BAR_CELLS } from '../src/constants'
import type { AccountUsage } from '../src/types'

const NOW = new Date('2026-08-03T08:00:00Z')
const OPTS = { color: false, width: 80, now: NOW }
const ANSI_PATTERN = /\[/

function row(partial: Partial<AccountUsage> & { id: string }): AccountUsage {
  return {
    label: partial.id,
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

describe('formatDuration', () => {
  test('renders hours and minutes', () => {
    expect(formatDuration(3 * 3_600_000 + 41 * 60_000)).toBe('3h41m')
  })

  test('renders minutes alone under an hour', () => {
    expect(formatDuration(47 * 60_000)).toBe('47m')
  })

  test('renders a dash for non-positive durations', () => {
    expect(formatDuration(0)).toBe('—')
    expect(formatDuration(-5)).toBe('—')
  })
})

describe('bar', () => {
  test('is fully empty at zero', () => {
    expect(bar(0)).toBe('░'.repeat(BAR_CELLS))
  })

  test('is fully filled at one hundred', () => {
    expect(bar(100)).toBe('▓'.repeat(BAR_CELLS))
  })

  test('renders an empty bar for a null percentage', () => {
    expect(bar(null)).toBe('░'.repeat(BAR_CELLS))
  })

  test('always has the configured width', () => {
    for (const pct of [1, 12, 50, 88, 99]) {
      expect(bar(pct)).toHaveLength(BAR_CELLS)
    }
  })

  test('clamps out-of-range values', () => {
    expect(bar(150)).toHaveLength(BAR_CELLS)
    expect(bar(-20)).toBe('░'.repeat(BAR_CELLS))
  })
})

describe('renderTable', () => {
  const rows = [
    row({ id: 'main', fiveHourPct: 12, fiveHourResetsAt: new Date('2026-08-03T11:41:00Z'), weeklyPct: 34 }),
    row({ id: 'secondary', fiveHourPct: null, weeklyPct: 18 }),
  ]

  test('includes a line per account plus a header', () => {
    const output = renderTable(rows, recommend(rows), OPTS)
    expect(output).toContain('main')
    expect(output).toContain('secondary')
    expect(output).toContain('ACCOUNT')
  })

  test('shows the countdown to reset, not the absolute time', () => {
    expect(renderTable(rows, recommend(rows), OPTS)).toContain('3h41m')
  })

  test('shows a dash where there is no active window', () => {
    expect(renderTable(rows, recommend(rows), OPTS)).toContain('—')
  })

  test('emits no ANSI escapes when color is disabled', () => {
    expect(renderTable(rows, recommend(rows), OPTS)).not.toMatch(ANSI_PATTERN)
  })

  test('emits ANSI escapes when color is enabled', () => {
    const output = renderTable(rows, recommend(rows), { ...OPTS, color: true })
    expect(output).toMatch(ANSI_PATTERN)
  })

  test('renders the recommendation line', () => {
    const output = renderTable(rows, recommend(rows), OPTS)
    expect(output).toContain('→ use: secondary')
  })

  test('flags rows served by the probe path', () => {
    const probed = [row({ id: 'main', fiveHourPct: 10, source: 'probe' })]
    expect(renderTable(probed, recommend(probed), OPTS)).toContain('probe')
  })

  test('renders an error row without crashing', () => {
    const broken = [row({ id: 'main', error: { cause: 'auth', message: 'token rejected' } })]
    const output = renderTable(broken, recommend(broken), OPTS)
    expect(output).toContain('token rejected')
  })

  test('renders a first-run message for an empty list', () => {
    expect(renderTable([], recommend([]), OPTS)).toMatch(/cuw add/)
  })

  test('reports the earliest reset when every account is spent', () => {
    const spent = [
      row({ id: 'a', fiveHourPct: 100, fiveHourResetsAt: new Date('2026-08-03T09:00:00Z') }),
      row({ id: 'b', fiveHourPct: 100, fiveHourResetsAt: new Date('2026-08-03T10:00:00Z') }),
    ]
    const output = renderTable(spent, recommend(spent), OPTS)
    expect(output).toContain('1h00m')
  })
})
