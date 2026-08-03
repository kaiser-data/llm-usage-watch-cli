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
