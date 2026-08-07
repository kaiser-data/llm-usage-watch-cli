import { HOT_THRESHOLD_PCT, SPENT_THRESHOLD_PCT } from './constants'
import type { AccountUsage, UsageWindows } from './types'

export type State = 'cold' | 'warm' | 'hot' | 'spent' | 'unknown'

/**
 * Whether the five-hour clock is actually running. The reset time is the only
 * trustworthy signal: the API reports a dormant account as `utilization: 0`
 * with no `resets_at`, not as a null utilization. Reading the percentage alone
 * makes every cold account look like a fresh warm one.
 */
export function hasOpenWindow(windows: UsageWindows): boolean {
  return windows.fiveHourResetsAt !== null
}

export function classify(row: AccountUsage): State {
  if (row.error !== null) return 'unknown'
  // A spent weekly budget makes the account unusable no matter how fresh the
  // session window is — the weekly limit binds for days, not hours.
  if (row.weeklyPct !== null && row.weeklyPct >= SPENT_THRESHOLD_PCT) return 'spent'
  if (!hasOpenWindow(row) || row.fiveHourPct === null) return 'cold'
  if (row.fiveHourPct >= SPENT_THRESHOLD_PCT) return 'spent'
  if (row.fiveHourPct >= HOT_THRESHOLD_PCT) return 'hot'
  return 'warm'
}

export type Recommendation = {
  useId: string | null
  reason: string
  coldIds: string[]
  earliestResetAt: Date | null
}

/** A cold account has its whole window available. */
function fiveHourHeadroom(row: AccountUsage): number {
  if (!hasOpenWindow(row) || row.fiveHourPct === null) return 100
  return 100 - row.fiveHourPct
}

function weeklyHeadroom(row: AccountUsage): number {
  return row.weeklyPct === null ? 100 : 100 - row.weeklyPct
}

/**
 * How much of the account is actually usable right now. The weekly budget caps
 * the session budget: a fresh five-hour window is worthless if the week is
 * nearly spent, because the weekly limit takes days to reset rather than hours.
 */
export function usableHeadroom(row: AccountUsage): number {
  return Math.min(fiveHourHeadroom(row), weeklyHeadroom(row))
}

/** Names the limit that is actually constraining this account. */
function describe(row: AccountUsage): string {
  if (classify(row) === 'cold' && weeklyHeadroom(row) > fiveHourHeadroom(row)) {
    return `cold — run \`cuw prime ${row.id}\` to start its clock`
  }
  const weekly = weeklyHeadroom(row)
  const session = fiveHourHeadroom(row)
  return weekly <= session
    ? `only ${weekly}% of the weekly limit left — that is what binds`
    : `${session}% of the five-hour window left`
}

function earliestReset(rows: AccountUsage[]): Date | null {
  const resets = rows
    .map(row => row.fiveHourResetsAt)
    .filter((date): date is Date => date !== null)
  if (resets.length === 0) return null
  return resets.reduce((earliest, date) => (date < earliest ? date : earliest))
}

export function recommend(rows: AccountUsage[]): Recommendation {
  const coldIds = rows.filter(row => classify(row) === 'cold').map(row => row.id)
  const usable = rows.filter(row => {
    const state = classify(row)
    return state !== 'spent' && state !== 'unknown'
  })

  if (usable.length === 0) {
    return {
      useId: null,
      reason: rows.length === 0
        ? 'no accounts configured — run `cuw add <id>`'
        : 'all accounts are spent or unreachable',
      coldIds,
      earliestResetAt: earliestReset(rows),
    }
  }

  // reduce, not sort()[0]: it returns the element type, not `T | undefined`.
  const best = usable.reduce((winner, candidate) => {
    const byBinding = usableHeadroom(candidate) - usableHeadroom(winner)
    if (byBinding !== 0) return byBinding > 0 ? candidate : winner
    // Equal binding headroom: prefer the one with more weekly budget, since
    // that is the limit that takes days rather than hours to recover.
    return weeklyHeadroom(candidate) > weeklyHeadroom(winner) ? candidate : winner
  })

  return {
    useId: best.id,
    reason: describe(best),
    coldIds,
    earliestResetAt: earliestReset(rows),
  }
}
