import { describe, expect, test } from 'bun:test'
import {
  bar,
  formatDuration,
  renderCodexUsage,
  renderCursorUsage,
  renderGrokUsage,
  renderTable,
} from '../src/render'
import { recommend } from '../src/classify'
import { BAR_CELLS } from '../src/constants'
import type { AccountUsage, CodexUsage, CursorUsage, GrokUsage } from '../src/types'

const NOW = new Date('2026-08-03T08:00:00Z')
const OPTS = { color: false, width: 80, now: NOW }
const ANSI_PATTERN = /\[/

const CODEX: CodexUsage = {
  provider: 'codex',
  plan: 'plus',
  limits: [{
    id: 'codex',
    name: null,
    windows: [
      {
        role: 'primary',
        usedPct: 73,
        durationMinutes: 10080,
        resetsAt: new Date('2026-08-07T08:00:00Z'),
      },
      {
        role: 'secondary',
        usedPct: 20,
        durationMinutes: 300,
        resetsAt: new Date('2026-08-03T10:00:00Z'),
      },
    ],
  }],
  error: null,
}

function row(partial: Partial<AccountUsage> & { id: string }): AccountUsage {
  return {
    label: partial.id,
    fiveHourPct: null,
    fiveHourResetsAt: null,
    weeklyPct: 0,
    weeklyResetsAt: null,
    opusWeeklyPct: null,
    subscription: null,
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

  test('renders days and hours once past a day, for weekly resets', () => {
    expect(formatDuration(2 * 86_400_000 + 5 * 3_600_000)).toBe('2d5h')
  })

  test('renders whole days without an hour part', () => {
    expect(formatDuration(3 * 86_400_000)).toBe('3d')
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

  describe('column alignment', () => {
    const aligned = [
      row({
        id: 'main',
        fiveHourPct: 12,
        fiveHourResetsAt: new Date('2026-08-03T11:41:00Z'),
        weeklyPct: 34,
        weeklyResetsAt: new Date('2026-08-05T06:00:00Z'),
      }),
    ]

    /** The rendered table split into its header line and its single data line. */
    function lines(): { header: string; data: string } {
      const output = renderTable(aligned, recommend(aligned), OPTS).split('\n')
      return { header: output[0] as string, data: output[2] as string }
    }

    test('ends the weekly reset value in the second RESETS column', () => {
      const { header, data } = lines()
      const headerEnd = header.indexOf('RESETS', header.indexOf('RESETS') + 1) + 'RESETS'.length
      const valueEnd = data.indexOf('1d22h') + '1d22h'.length
      expect(valueEnd).toBe(headerEnd)
    })

    test('ends the renewal value in the RENEWS column', () => {
      const { header, data } = lines()
      const headerEnd = header.indexOf('RENEWS') + 'RENEWS'.length
      // Both resets are set on this fixture, so the only dash is the renewal,
      // which has no subscription to derive a date from.
      expect(data.lastIndexOf('—') + 1).toBe(headerEnd)
    })

    test('keeps the weekly bar clear of the next header', () => {
      const { header, data } = lines()
      const barEnd = data.lastIndexOf('░') + 1
      expect(barEnd).toBeLessThan(header.indexOf('RESETS', header.indexOf('RESETS') + 1))
    })
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

  test('shows a weekly bar and a weekly reset countdown', () => {
    const withWeekly = [row({
      id: 'main',
      fiveHourPct: 12,
      fiveHourResetsAt: new Date('2026-08-03T11:41:00Z'),
      weeklyPct: 60,
      weeklyResetsAt: new Date('2026-08-05T08:00:00Z'),
    })]
    const output = renderTable(withWeekly, recommend(withWeekly), OPTS)
    expect(output).toContain('60%')
    expect(output).toContain('2d')
    expect(output).toContain('WEEKLY')
  })

  test('names the weekly limit in the footer when it binds', () => {
    const bound = [row({
      id: 'main',
      fiveHourPct: 5,
      fiveHourResetsAt: new Date('2026-08-03T11:41:00Z'),
      weeklyPct: 90,
      weeklyResetsAt: new Date('2026-08-05T08:00:00Z'),
    })]
    expect(renderTable(bound, recommend(bound), OPTS)).toMatch(/weekly limit left/i)
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

describe('renderCodexUsage', () => {
  test('renders active plan and every returned window', () => {
    const output = renderCodexUsage(CODEX, OPTS)

    expect(output).toContain('CODEX')
    expect(output).toContain('active')
    expect(output).toContain('plus')
    expect(output).toContain('primary 7d')
    expect(output).toContain('secondary 5h00m')
    expect(output).toContain('73%')
    expect(output).toContain('4d')
    expect(output).not.toMatch(ANSI_PATTERN)
  })

  test('uses a server-provided bucket name', () => {
    const named: CodexUsage = {
      ...CODEX,
      limits: [{ ...CODEX.limits[0]!, name: 'Other models' }],
    }

    expect(renderCodexUsage(named, OPTS)).toContain('Other models')
  })

  test('renders a safe error without a table', () => {
    const failed: CodexUsage = {
      provider: 'codex',
      plan: null,
      limits: [],
      error: {
        cause: 'not-logged-in',
        message: 'Codex is not logged in — run `codex login`',
      },
    }

    const output = renderCodexUsage(failed, OPTS)
    expect(output).toContain('codex login')
    expect(output).toContain('✗ error')
    expect(output).not.toContain('LIMIT  WINDOW')
  })

  test('renders an explicit message when no windows are reported', () => {
    expect(renderCodexUsage({ ...CODEX, limits: [] }, OPTS))
      .toContain('No limit windows')
  })

  test('emits ANSI escapes only when color is enabled', () => {
    expect(renderCodexUsage(CODEX, OPTS)).not.toMatch(ANSI_PATTERN)
    expect(renderCodexUsage(CODEX, { ...OPTS, color: true })).toMatch(ANSI_PATTERN)
  })
})

const CURSOR: CursorUsage = {
  provider: 'cursor',
  plan: 'pro',
  periodEnd: new Date('2026-08-20T08:00:00Z'),
  limits: [
    { id: 'plan', name: 'plan', usedPct: 46, resetsAt: new Date('2026-08-20T08:00:00Z') },
    { id: 'auto', name: 'auto', usedPct: 0, resetsAt: new Date('2026-08-20T08:00:00Z') },
    { id: 'api', name: 'api', usedPct: 46, resetsAt: new Date('2026-08-20T08:00:00Z') },
  ],
  error: null,
}

describe('renderCursorUsage', () => {
  test('renders active plan and every returned limit', () => {
    const output = renderCursorUsage(CURSOR, OPTS)

    expect(output).toContain('CURSOR')
    expect(output).toContain('active')
    expect(output).toContain('pro')
    expect(output).toContain('plan')
    expect(output).toContain('auto')
    expect(output).toContain('api')
    expect(output).toContain('46%')
    expect(output).toContain('17d')
    expect(output).not.toMatch(ANSI_PATTERN)
  })

  test('renders a safe error without a table', () => {
    const failed: CursorUsage = {
      provider: 'cursor',
      plan: null,
      periodEnd: null,
      limits: [],
      error: {
        cause: 'not-logged-in',
        message: 'Cursor is not logged in on this machine',
      },
    }

    const output = renderCursorUsage(failed, OPTS)
    expect(output).toContain('not logged in')
    expect(output).not.toContain('LIMIT')
  })

  test('renders an explicit message when no limits are reported', () => {
    expect(renderCursorUsage({ ...CURSOR, limits: [] }, OPTS))
      .toContain('No limit windows')
  })

  test('emits ANSI escapes only when color is enabled', () => {
    expect(renderCursorUsage(CURSOR, OPTS)).not.toMatch(ANSI_PATTERN)
    expect(renderCursorUsage(CURSOR, { ...OPTS, color: true })).toMatch(ANSI_PATTERN)
  })
})

const GROK: GrokUsage = {
  provider: 'grok',
  plan: 'pro',
  periodEnd: new Date('2026-09-01T00:00:00Z'),
  limits: [
    { id: 'monthly', name: 'monthly', usedPct: 10, resetsAt: new Date('2026-09-01T00:00:00Z') },
    { id: 'on-demand', name: 'on-demand', usedPct: 20, resetsAt: new Date('2026-09-01T00:00:00Z') },
  ],
  error: null,
}

describe('renderGrokUsage', () => {
  test('renders active plan and every returned limit', () => {
    const output = renderGrokUsage(GROK, OPTS)

    expect(output).toContain('GROK')
    expect(output).toContain('active')
    expect(output).toContain('pro')
    expect(output).toContain('monthly')
    expect(output).toContain('on-demand')
    expect(output).toContain('10%')
    expect(output).toContain('20%')
    expect(output).not.toMatch(ANSI_PATTERN)
  })

  test('renders a safe error without a table', () => {
    const failed: GrokUsage = {
      provider: 'grok',
      plan: null,
      periodEnd: null,
      limits: [],
      error: {
        cause: 'not-logged-in',
        message: 'Grok is not logged in on this machine — run `grok login`',
      },
    }

    const output = renderGrokUsage(failed, OPTS)
    expect(output).toContain('not logged in')
    expect(output).not.toContain('LIMIT')
  })

  test('renders an explicit message when no limits are reported', () => {
    expect(renderGrokUsage({ ...GROK, limits: [] }, OPTS))
      .toContain('No limit windows')
  })

  test('emits ANSI escapes only when color is enabled', () => {
    expect(renderGrokUsage(GROK, OPTS)).not.toMatch(ANSI_PATTERN)
    expect(renderGrokUsage(GROK, { ...OPTS, color: true })).toMatch(ANSI_PATTERN)
  })
})
