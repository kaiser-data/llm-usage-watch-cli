import { OAUTH_BETA_HEADER } from './constants'
import type { UsageWindows } from './types'

export class SchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SchemaError'
  }
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

/**
 * Field paths per window, confirmed against the live response in the
 * 2026-08-03 spike. Per-model keys are nullable on plans without that limit.
 */
const FIELD_PATHS = {
  fiveHourPct: ['five_hour.utilization'],
  fiveHourResetsAt: ['five_hour.resets_at'],
  weeklyPct: ['seven_day.utilization'],
  weeklyResetsAt: ['seven_day.resets_at'],
  opusWeeklyPct: ['seven_day_opus.utilization'],
} as const

function pick(source: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => {
    if (typeof value !== 'object' || value === null) return undefined
    return (value as Record<string, unknown>)[key]
  }, source)
}

function firstNumber(source: Record<string, unknown>, paths: readonly string[]): number | null {
  for (const path of paths) {
    const value = pick(source, path)
    if (typeof value === 'number' && Number.isFinite(value)) {
      // Observed as 0-100; a 0-1 payload is also accepted defensively.
      return value <= 1 ? Math.round(value * 100) : Math.round(value)
    }
  }
  return null
}

function firstDate(source: Record<string, unknown>, paths: readonly string[]): Date | null {
  for (const path of paths) {
    const value = pick(source, path)
    if (typeof value === 'string') {
      const parsed = new Date(value)
      if (!Number.isNaN(parsed.getTime())) return parsed
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      // Epoch seconds.
      return new Date(value * 1000)
    }
  }
  return null
}

export function normalizeApiResponse(raw: unknown): UsageWindows {
  if (typeof raw !== 'object' || raw === null) {
    throw new SchemaError('usage response was not a JSON object')
  }
  const source = raw as Record<string, unknown>
  const windows: UsageWindows = {
    fiveHourPct: firstNumber(source, FIELD_PATHS.fiveHourPct),
    fiveHourResetsAt: firstDate(source, FIELD_PATHS.fiveHourResetsAt),
    weeklyPct: firstNumber(source, FIELD_PATHS.weeklyPct),
    weeklyResetsAt: firstDate(source, FIELD_PATHS.weeklyResetsAt),
    opusWeeklyPct: firstNumber(source, FIELD_PATHS.opusWeeklyPct),
  }
  const recognized =
    windows.fiveHourPct !== null ||
    windows.weeklyPct !== null ||
    windows.fiveHourResetsAt !== null
  if (!recognized) {
    throw new SchemaError('usage response contained no recognized limit fields')
  }
  return windows
}

export async function fetchUsage(
  token: string,
  deps: { fetcher: typeof fetch; endpoint: string; timeoutMs: number },
): Promise<UsageWindows> {
  const response = await deps.fetcher(deps.endpoint, {
    headers: {
      authorization: `Bearer ${token}`,
      'anthropic-beta': OAUTH_BETA_HEADER,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(deps.timeoutMs),
  })

  if (response.status === 401 || response.status === 403) {
    // The body is discarded: it can echo credential material.
    throw new AuthError(`token rejected (HTTP ${response.status})`)
  }
  if (!response.ok) {
    throw new SchemaError(`usage request failed (HTTP ${response.status})`)
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new SchemaError('usage response was not valid JSON')
  }
  return normalizeApiResponse(payload)
}
