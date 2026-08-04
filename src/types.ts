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

export type CodexErrorCause =
  | 'not-installed'
  | 'not-logged-in'
  | 'timeout'
  | 'protocol'
  | 'process'

export type CodexUsageWindow = {
  role: 'primary' | 'secondary'
  usedPct: number
  durationMinutes: number | null
  resetsAt: Date | null
}

export type CodexUsageLimit = {
  id: string
  name: string | null
  windows: CodexUsageWindow[]
}

export type CodexUsage = {
  provider: 'codex'
  plan: string | null
  limits: CodexUsageLimit[]
  error: { cause: CodexErrorCause; message: string } | null
}

export type AccountUsage = UsageWindows & {
  id: string
  label: string
  subscription: Subscription | null
  source: 'api' | 'probe' | 'none'
  error: UsageError | null
}

/**
 * A full-scope Claude Code login credential. Setup-tokens are deliberately not
 * representable here: they carry `user:inference` only and cannot read usage.
 */
export type Credential = {
  accessToken: string
  refreshToken: string
  /** Epoch milliseconds. */
  expiresAt: number
  scopes: string[]
  /**
   * The `claudeAiOauth` branch verbatim, so a switch can restore fields cuw
   * does not model (`subscriptionType`, `rateLimitTier`, `refreshTokenExpiresAt`,
   * and anything Anthropic adds later). Empty for credentials stored before this
   * field existed — see `isLegacyCredential`.
   */
  raw: Record<string, unknown>
}

/** Plan and billing facts, from /api/oauth/profile. */
export type Subscription = {
  /** 'pro' | 'max' | the raw organization_type for anything else. */
  plan: string
  /** e.g. 'active'. */
  status: string | null
  /** When the subscription began. The API exposes no end date. */
  createdAt: Date | null
  /** Derived: the next monthly anniversary of createdAt. NOT authoritative — */
  /** the API reports no billing period, so an annual plan renews later. */
  renewsAt: Date | null
  /** Set only while on a Claude Code trial. */
  trialEndsAt: Date | null
}
