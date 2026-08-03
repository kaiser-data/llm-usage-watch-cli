export type Account = {
  id: string
  label: string
  email: string
  order: number
}

/** Usage figures for one account, independent of which path produced them. */
export type UsageWindows = {
  /** null means no active five-hour window. */
  fiveHourPct: number | null
  fiveHourResetsAt: Date | null
  weeklyPct: number | null
  weeklyResetsAt: Date | null
  /** null when the plan exposes no separate Opus limit. */
  opusWeeklyPct: number | null
}

export type UsageErrorCause =
  | 'no-token'
  | 'auth'
  | 'network'
  | 'schema'
  | 'probe-failed'

export type UsageError = {
  cause: UsageErrorCause
  /** Safe for display. Never contains a token or a raw response body. */
  message: string
}

export type AccountUsage = UsageWindows & {
  id: string
  label: string
  source: 'api' | 'probe' | 'none'
  error: UsageError | null
}
