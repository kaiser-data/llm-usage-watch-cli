/** Keychain generic-password service holding one long-lived token per account. */
export const KEYCHAIN_SERVICE = 'cuw-token'

/** At or above this five-hour percentage an account is 'hot'. */
export const HOT_THRESHOLD_PCT = 70

/** An account at or above this percentage is 'spent'. */
export const SPENT_THRESHOLD_PCT = 100

/** Per-account timeout for a usage request. */
export const REQUEST_TIMEOUT_MS = 8_000

/** Timeout for the complete short-lived Codex app-server usage read. */
export const CODEX_USAGE_TIMEOUT_MS = 8_000

/** Timeout for a Cursor dashboard usage read (including optional token refresh). */
export const CURSOR_USAGE_TIMEOUT_MS = 8_000

/** Timeout for a Grok billing usage read (including optional token refresh). */
export const GROK_USAGE_TIMEOUT_MS = 8_000

/** Cursor Dashboard Connect RPC origin. */
export const CURSOR_API_BASE = 'https://api2.cursor.sh'

/** Cursor OAuth client id embedded in the desktop app. */
export const CURSOR_OAUTH_CLIENT_ID = 'KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB'

/** Grok CLI chat-proxy origin used for billing and identity reads. */
export const GROK_API_BASE = 'https://cli-chat-proxy.grok.com/v1'

/** SpaceXAI OIDC token endpoint for refreshing a Grok CLI session. */
export const GROK_OAUTH_TOKEN_ENDPOINT = 'https://auth.x.ai/oauth2/token'

/** Client-mode header the Grok CLI sends on first-party proxy requests. */
export const GROK_CLIENT_MODE = 'cli'

/** Timeout for one priming session. */
export const PRIME_TIMEOUT_MS = 60_000

/** Cheapest model; the five-hour window is per account, so any model opens it. */
export const PRIME_MODEL = 'haiku'

/** The entire priming prompt. */
export const PRIME_PROMPT = 'hi'

/**
 * The usage endpoint lags a freshly opened window by a second or two, so a
 * single confirmation read right after the session can miss a window that did
 * open. Poll instead of reporting a false negative.
 */
export const PRIME_CONFIRM_ATTEMPTS = 6
export const PRIME_CONFIRM_DELAY_MS = 2_000

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
 * Rate-limit response headers, read straight off an inference response.
 *
 * Two things changed together on 2026-08-08, and they must be understood
 * together: `claude --debug api` stopped logging these headers at all (so the
 * old log-scraping probe silently produced nothing), and the names moved from
 * `-remaining` to `-utilization`. The sense inverted with the name —
 * `-utilization` is the fraction of budget *spent*, where `-remaining` was the
 * fraction *left*. Renaming these without also flipping the arithmetic would
 * report a fresh account as exhausted and an exhausted one as fresh.
 */
export const HEADER_KEYS = {
  fiveHourStatus: 'anthropic-ratelimit-unified-5h-status',
  fiveHourReset: 'anthropic-ratelimit-unified-5h-reset',
  fiveHourUtilization: 'anthropic-ratelimit-unified-5h-utilization',
  weeklyStatus: 'anthropic-ratelimit-unified-7d-status',
  weeklyReset: 'anthropic-ratelimit-unified-7d-reset',
  weeklyUtilization: 'anthropic-ratelimit-unified-7d-utilization',
  opusWeeklyUtilization: 'anthropic-ratelimit-unified-7d-opus-utilization',
} as const

/**
 * The probe sends a real inference request and reads its response headers.
 * There is no cheaper source: a malformed request is rejected by validation
 * before the rate limiter annotates the response, and `count_tokens` returns
 * no rate-limit headers, so both come back bare.
 */
export const PROBE_ENDPOINT = 'https://api.anthropic.com/v1/messages'

/** Required on a direct Messages API call. */
export const ANTHROPIC_VERSION = '2023-06-01'

/** Concrete id rather than the `haiku` CLI alias: the API resolves no aliases. */
export const PROBE_MODEL = 'claude-haiku-4-5-20251001'

/** The response headers are the payload; the completion itself is waste. */
export const PROBE_MAX_TOKENS = 1
export const PROBE_PROMPT = 'hi'

/** Inference is slower than a metadata read, so this is not REQUEST_TIMEOUT_MS. */
export const PROBE_TIMEOUT_MS = 20_000

/**
 * The usage endpoint throttles reads independently of account budget, and does
 * so transiently. Retrying costs nothing; falling through to the probe would
 * spend real quota to answer a question the API was about to answer for free.
 */
export const USAGE_RETRY_ATTEMPTS = 3
export const USAGE_RETRY_DELAY_MS = 400

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
export const PROFILE_ENDPOINT = 'https://api.anthropic.com/api/oauth/profile'
