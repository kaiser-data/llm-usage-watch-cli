/** Keychain generic-password service holding one long-lived token per account. */
export const KEYCHAIN_SERVICE = 'cuw-token'

/** At or above this five-hour percentage an account is 'hot'. */
export const HOT_THRESHOLD_PCT = 70

/** An account at or above this percentage is 'spent'. */
export const SPENT_THRESHOLD_PCT = 100

/** Per-account timeout for a usage request. */
export const REQUEST_TIMEOUT_MS = 8_000

/** Timeout for one priming session. */
export const PRIME_TIMEOUT_MS = 60_000

/** Cheapest model; the five-hour window is per account, so any model opens it. */
export const PRIME_MODEL = 'haiku'

/** The entire priming prompt. */
export const PRIME_PROMPT = 'hi'

/** Width of the usage bar, in cells. */
export const BAR_CELLS = 9

/** Fallback terminal width when stdout reports none. */
export const DEFAULT_TERM_WIDTH = 80

/**
 * Confirmed by the 2026-08-03 spike: the CLI itself calls `GET /api/oauth/usage`
 * and this returned HTTP 200 with the expected limit fields.
 */
export const USAGE_ENDPOINTS = [
  'https://api.anthropic.com/api/oauth/usage',
] as const

/** Beta header the CLI sends on OAuth-authenticated requests. */
export const OAUTH_BETA_HEADER = 'oauth-2025-04-20'

/**
 * Rate-limit response headers read by the probe path. Values are confirmed
 * against a real debug log during the spike; the parser and its tests reference
 * these constants, so a correction here needs no test changes.
 */
export const HEADER_KEYS = {
  fiveHourStatus: 'anthropic-ratelimit-unified-5h-status',
  fiveHourReset: 'anthropic-ratelimit-unified-5h-reset',
  fiveHourRemaining: 'anthropic-ratelimit-unified-5h-remaining',
  weeklyStatus: 'anthropic-ratelimit-unified-7d-status',
  weeklyReset: 'anthropic-ratelimit-unified-7d-reset',
  weeklyRemaining: 'anthropic-ratelimit-unified-7d-remaining',
  opusWeeklyRemaining: 'anthropic-ratelimit-unified-7d-opus-remaining',
} as const

/** OAuth token endpoint used to refresh an expired access token. */
export const OAUTH_TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token'

/** Claude Code's public OAuth client id, as embedded in the CLI. */
export const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

/** Scope required to read /api/oauth/usage. Setup-tokens lack it. */
export const REQUIRED_SCOPE = 'user:profile'

/** Refresh this long before actual expiry, to avoid racing the clock. */
export const REFRESH_SKEW_MS = 5 * 60_000

/** Keychain service holding the Claude Code login credential blob. */
export const CLAUDE_CREDENTIAL_SERVICE = 'Claude Code-credentials'
