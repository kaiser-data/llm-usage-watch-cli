import { BAR_CELLS } from './constants'
import { classify, type Recommendation, type State } from './classify'
import type { AccountUsage, CodexUsage, CursorUsage, GrokUsage } from './types'

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

/**
 * An absent figure is not a zero. Printing null as "0%" made an unreadable
 * account look like a completely fresh one — the most attractive row in the
 * table — which is the opposite of what the reader needs to know.
 */
function pctText(pct: number | null): string {
  return pct === null ? '—' : `${pct}%`
}

function countdown(resetsAt: Date | null, now: Date): string {
  if (resetsAt === null) return '—'
  return formatDuration(resetsAt.getTime() - now.getTime())
}

function codexDuration(minutes: number | null): string {
  return minutes === null ? '—' : formatDuration(minutes * MS_PER_MINUTE)
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
    pctText(row.weeklyPct).padStart(4),
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
      `WEEKLY${' '.repeat(BAR_CELLS)}`,
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

/** Renders Codex separately because its limit buckets have arbitrary durations. */
export function renderCodexUsage(usage: CodexUsage, opts: RenderOptions): string {
  const heading = `CODEX  active  PLAN ${usage.plan ?? '—'}`
  if (usage.error !== null) {
    const mark = paint('✗ error', ANSI.red, opts.color)
    return `${heading}\n${mark}  ${usage.error.message}\n`
  }

  const rows = usage.limits.flatMap(limit =>
    limit.windows.map(window => ({ limit, window })))
  if (rows.length === 0) return `${heading}\nNo limit windows reported.\n`

  const labelWidth = Math.max(
    5,
    ...rows.map(row => (row.limit.name ?? row.limit.id).length),
  )
  const header = paint(
    [
      'LIMIT'.padEnd(labelWidth),
      'WINDOW'.padEnd(13),
      `USED${' '.repeat(BAR_CELLS + 2)}`,
      'RESETS',
    ].join('  '),
    ANSI.dim,
    opts.color,
  )
  const rule = paint(
    '─'.repeat(Math.min(opts.width, labelWidth + BAR_CELLS + 39)),
    ANSI.dim,
    opts.color,
  )
  const body = rows.map(({ limit, window }) => [
    (limit.name ?? limit.id).padEnd(labelWidth),
    `${window.role} ${codexDuration(window.durationMinutes)}`.padEnd(13),
    `${String(window.usedPct).padStart(3)}%  ${bar(window.usedPct)}`,
    countdown(window.resetsAt, opts.now).padStart(6),
  ].join('  '))

  return [heading, header, rule, ...body, ''].join('\n')
}

/** Renders Cursor separately — USD pool + Auto/API lanes, not Claude windows. */
export function renderCursorUsage(usage: CursorUsage, opts: RenderOptions): string {
  return renderSimpleMeterSection('CURSOR', usage, opts)
}

/** Renders Grok separately — monthly credit pool (+ optional on-demand). */
export function renderGrokUsage(usage: GrokUsage, opts: RenderOptions): string {
  return renderSimpleMeterSection('GROK', usage, opts)
}

type SimpleMeterUsage = {
  plan: string | null
  limits: Array<{
    id: string
    name: string | null
    usedPct: number
    resetsAt: Date | null
  }>
  error: { message: string } | null
}

function renderSimpleMeterSection(
  title: string,
  usage: SimpleMeterUsage,
  opts: RenderOptions,
): string {
  const heading = `${title}  active  PLAN ${usage.plan ?? '—'}`
  if (usage.error !== null) {
    const mark = paint('✗ error', ANSI.red, opts.color)
    return `${heading}\n${mark}  ${usage.error.message}\n`
  }

  if (usage.limits.length === 0) {
    return `${heading}\nNo limit windows reported.\n`
  }

  const labelWidth = Math.max(
    5,
    ...usage.limits.map(limit => (limit.name ?? limit.id).length),
  )
  const header = paint(
    [
      'LIMIT'.padEnd(labelWidth),
      `USED${' '.repeat(BAR_CELLS + 2)}`,
      'RESETS',
    ].join('  '),
    ANSI.dim,
    opts.color,
  )
  const rule = paint(
    '─'.repeat(Math.min(opts.width, labelWidth + BAR_CELLS + 24)),
    ANSI.dim,
    opts.color,
  )
  const body = usage.limits.map(limit => [
    (limit.name ?? limit.id).padEnd(labelWidth),
    `${String(limit.usedPct).padStart(3)}%  ${bar(limit.usedPct)}`,
    countdown(limit.resetsAt, opts.now).padStart(6),
  ].join('  '))

  return [heading, header, rule, ...body, ''].join('\n')
}
