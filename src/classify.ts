import { HOT_THRESHOLD_PCT, SPENT_THRESHOLD_PCT } from './constants'
import type { AccountUsage } from './types'

export type State = 'cold' | 'warm' | 'hot' | 'spent' | 'unknown'

export function classify(row: AccountUsage): State {
  if (row.error !== null) return 'unknown'
  if (row.fiveHourPct === null) return 'cold'
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
  return row.fiveHourPct === null ? 100 : 100 - row.fiveHourPct
}

function weeklyHeadroom(row: AccountUsage): number {
  return row.weeklyPct === null ? 100 : 100 - row.weeklyPct
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
    const byFiveHour = fiveHourHeadroom(candidate) - fiveHourHeadroom(winner)
    if (byFiveHour !== 0) return byFiveHour > 0 ? candidate : winner
    return weeklyHeadroom(candidate) > weeklyHeadroom(winner) ? candidate : winner
  })

  const state = classify(best)
  const reason = state === 'cold'
    ? `cold — run \`cuw prime ${best.id}\` to start its clock`
    : `${fiveHourHeadroom(best)}% of the five-hour window left`

  return { useId: best.id, reason, coldIds, earliestResetAt: earliestReset(rows) }
}
