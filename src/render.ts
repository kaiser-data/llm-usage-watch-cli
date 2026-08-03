import { BAR_CELLS } from './constants'
import { classify, type Recommendation, type State } from './classify'
import type { AccountUsage } from './types'

const MS_PER_MINUTE = 60_000
const MS_PER_HOUR = 3_600_000
const MS_PER_DAY = 86_400_000
const ESC = ''

const ANSI = {
  reset: `${ESC}[0m`,
  dim: `${ESC}[2m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  red: `${ESC}[31m`,
  cyan: `${ESC}[36m`,
} as const

const STATE_MARK: Record<State, string> = {
  cold: '○ cold',
  warm: '● warm',
  hot: '▲ hot',
  spent: '■ spent',
  unknown: '✗ error',
}

const STATE_COLOR: Record<State, string> = {
  cold: ANSI.cyan,
  warm: ANSI.green,
  hot: ANSI.yellow,
  spent: ANSI.red,
  unknown: ANSI.red,
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return '—'
  // Weekly resets are days away; minutes are noise at that range.
  if (ms >= MS_PER_DAY) {
    const days = Math.floor(ms / MS_PER_DAY)
    const hours = Math.floor((ms % MS_PER_DAY) / MS_PER_HOUR)
    return hours > 0 ? `${days}d${hours}h` : `${days}d`
  }
  const hours = Math.floor(ms / MS_PER_HOUR)
  const minutes = Math.floor((ms % MS_PER_HOUR) / MS_PER_MINUTE)
  return hours > 0 ? `${hours}h${String(minutes).padStart(2, '0')}m` : `${minutes}m`
}

export function bar(pct: number | null): string {
  const filled = pct === null ? 0 : Math.round((Math.min(100, Math.max(0, pct)) / 100) * BAR_CELLS)
  return '▓'.repeat(filled) + '░'.repeat(BAR_CELLS - filled)
}

export type RenderOptions = { color: boolean; width: number; now: Date }

function paint(text: string, color: string, enabled: boolean): string {
  return enabled ? `${color}${text}${ANSI.reset}` : text
}

function pctText(pct: number | null): string {
  return pct === null ? '0%' : `${pct}%`
}

function countdown(resetsAt: Date | null, now: Date): string {
  if (resetsAt === null) return '—'
  return formatDuration(resetsAt.getTime() - now.getTime())
}

function planText(row: AccountUsage): string {
  const plan = row.subscription?.plan
  return plan === undefined || plan === 'unknown' ? '—' : plan
}

/**
 * The API exposes no subscription end date, so this is the next monthly
 * anniversary of the start date — an estimate, marked with `~`. A trial end
 * date, when present, is real and takes precedence.
 */
function renewalText(row: AccountUsage, now: Date): string {
  const subscription = row.subscription
  if (!subscription) return '—'
  if (subscription.trialEndsAt !== null) {
    return `trial ${countdown(subscription.trialEndsAt, now)}`
  }
  if (subscription.renewsAt === null) return '—'
  return `~${countdown(subscription.renewsAt, now)}`
}

function renderRow(row: AccountUsage, opts: RenderOptions, labelWidth: number): string {
  const state = classify(row)
  const label = row.label.padEnd(labelWidth)

  if (row.error !== null) {
    const mark = paint(STATE_MARK.unknown, STATE_COLOR.unknown, opts.color)
    return `${label}  ${mark}  ${row.error.message}`
  }

  const cells = [
    label,
    planText(row).padEnd(4),
    pctText(row.fiveHourPct).padStart(4),
    bar(row.fiveHourPct),
    countdown(row.fiveHourResetsAt, opts.now).padStart(6),
    pctText(row.weeklyPct).padStart(5),
    bar(row.weeklyPct),
    countdown(row.weeklyResetsAt, opts.now).padStart(6),
    renewalText(row, opts.now).padStart(7),
    paint(STATE_MARK[state], STATE_COLOR[state], opts.color),
  ]
  const line = cells.join('  ')
  return row.source === 'probe' ? `${line}  ${paint('(probe)', ANSI.dim, opts.color)}` : line
}

/**
 * Pure: TTY-ness, terminal width, and the current time are supplied by the
 * caller rather than read from the environment, which keeps this testable.
 */
export function renderTable(
  rows: AccountUsage[],
  rec: Recommendation,
  opts: RenderOptions,
): string {
  if (rows.length === 0) {
    return 'No subscriptions configured yet.\nAdd one with: cuw add <id>\n'
  }

  const labelWidth = Math.max(7, ...rows.map(row => row.label.length))
  const header = paint(
    [
      'ACCOUNT'.padEnd(labelWidth),
      'PLAN',
      `5H WINDOW${' '.repeat(BAR_CELLS - 3)}`,
      'RESETS',
      `WEEKLY${' '.repeat(BAR_CELLS - 2)}`,
      'RESETS',
      ' RENEWS',
      'STATE',
    ].join('  '),
    ANSI.dim,
    opts.color,
  )
  const ruleWidth = labelWidth + 2 * BAR_CELLS + 57
  const rule = paint('─'.repeat(Math.min(opts.width, ruleWidth)), ANSI.dim, opts.color)
  const body = rows.map(row => renderRow(row, opts, labelWidth))

  const countdown = rec.earliestResetAt === null
    ? ''
    : ` (earliest reset in ${formatDuration(rec.earliestResetAt.getTime() - opts.now.getTime())})`
  const footer = rec.useId === null
    ? `\n✗ ${rec.reason}${countdown}`
    : `\n→ use: ${rec.useId}  (${rec.reason})`

  return [header, rule, ...body, footer, ''].join('\n')
}
