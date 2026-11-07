import {
  ANTHROPIC_VERSION,
  HEADER_KEYS,
  OAUTH_BETA_HEADER,
  PROBE_MAX_TOKENS,
  PROBE_PROMPT,
} from './constants'
import type { UsageWindows } from './types'
import { AuthError } from './usage-api'

export class ProbeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProbeError'
  }
}

/**
 * Utilization is a 0-1 fraction of the budget already spent. It can exceed 1
 * on an over-served window (1.11 was observed on a rejected account); a bar
 * cannot show 111%, and every consumer treats 100 as spent, so it is clamped.
 */
function utilizationPct(headers: Headers, key: string): number | null {
  const raw = headers.get(key)
  if (raw === null) return null
  const fraction = Number(raw)
  if (!Number.isFinite(fraction)) return null
  return Math.min(100, Math.round(fraction * 100))
}

function resetDate(headers: Headers, key: string): Date | null {
  const raw = headers.get(key)
  if (raw === null) return null
  const epochSeconds = Number(raw)
  if (Number.isFinite(epochSeconds)) return new Date(epochSeconds * 1000)
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export function parseRateLimitHeaders(headers: Headers): UsageWindows {
  return {
    fiveHourPct: utilizationPct(headers, HEADER_KEYS.fiveHourUtilization),
    fiveHourResetsAt: resetDate(headers, HEADER_KEYS.fiveHourReset),
    weeklyPct: utilizationPct(headers, HEADER_KEYS.weeklyUtilization),
    weeklyResetsAt: resetDate(headers, HEADER_KEYS.weeklyReset),
    opusWeeklyPct: utilizationPct(headers, HEADER_KEYS.opusWeeklyUtilization),
  }
}

export type ProbeDeps = {
  fetcher: typeof fetch
  endpoint: string
  model: string
  timeoutMs: number
}

/**
 * The probe both measures and primes: it sends a real inference request, so a
 * dormant account gains an open five-hour window as a side effect. Callers must
 * surface that — `collectUsage` marks such rows `source: 'probe'`.
 *
 * It reads the rate-limit headers directly off the response. The previous
 * implementation spawned `claude --debug api` and scraped its log, which stopped
 * carrying these headers entirely; a direct call removes the subprocess, the
 * scratch directory, and the log format as a dependency all at once.
 */
export async function probeUsage(token: string, deps: ProbeDeps): Promise<UsageWindows> {
  const response = await deps.fetcher(deps.endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'anthropic-beta': OAUTH_BETA_HEADER,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: deps.model,
      max_tokens: PROBE_MAX_TOKENS,
      messages: [{ role: 'user', content: PROBE_PROMPT }],
    }),
    signal: AbortSignal.timeout(deps.timeoutMs),
  })

  if (response.status === 401 || response.status === 403) {
    // The body is discarded: it can echo credential material.
    throw new AuthError(`token rejected (HTTP ${response.status})`)
  }

  // A 429 is not a failure here — it is the reading. An account with nothing
  // left is exactly what the tool exists to report, and the rate limiter
  // annotates the rejection with the same headers it puts on a success.
  const windows = parseRateLimitHeaders(response.headers)
  const recognized =
    windows.fiveHourPct !== null ||
    windows.weeklyPct !== null ||
    windows.fiveHourResetsAt !== null
  if (!recognized) {
    // Returning all-nulls instead of throwing is what let a dead probe pass
    // itself off as a healthy account sitting at 0%.
    throw new ProbeError(
      `probe response carried no rate-limit headers (HTTP ${response.status})`,
    )
  }
  return windows
}
