import {
  CURSOR_API_BASE,
  CURSOR_OAUTH_CLIENT_ID,
  REFRESH_SKEW_MS,
} from './constants'
import {
  CursorAuthError,
  type CursorAuth,
  type CursorAuthStore,
  readCursorAuth,
} from './cursor-auth'
import type {
  CursorErrorCause,
  CursorLimitId,
  CursorUsage,
  CursorUsageLimit,
} from './types'

export class CursorSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CursorSchemaError'
  }
}

class CursorClientError extends Error {
  constructor(
    readonly clientCause: CursorErrorCause,
    message: string,
  ) {
    super(message)
    this.name = 'CursorClientError'
  }
}

export type CursorFetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export type CursorUsageDeps = {
  readAuth: () => Promise<CursorAuth>
  fetch: CursorFetcher
  now: () => Date
  timeoutMs: number
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function percent(value: unknown, field: string): number {
  const n = asNumber(value)
  if (n === null || n < 0 || n > 100) {
    throw new CursorSchemaError(`invalid ${field} percent`)
  }
  return Math.round(n)
}

function optionalPercent(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null
  return percent(value, field)
}

function msTimestamp(value: unknown): Date | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value)
  }
  if (typeof value === 'string' && value !== '') {
    const n = Number(value)
    if (!Number.isFinite(n)) {
      throw new CursorSchemaError('invalid billingCycleEnd')
    }
    return new Date(n)
  }
  throw new CursorSchemaError('invalid billingCycleEnd')
}

function limitRow(
  id: CursorLimitId,
  usedPct: number,
  resetsAt: Date | null,
): CursorUsageLimit {
  return { id, name: id, usedPct, resetsAt }
}

function onDemandPercent(spend: Record<string, unknown> | null): number | null {
  if (spend === null) return null

  const individualLimit = asNumber(spend.individualLimit) ?? 0
  const pooledLimit = asNumber(spend.pooledLimit) ?? 0
  if (individualLimit > 0) {
    const used = asNumber(spend.individualUsed) ?? 0
    return percent((used / individualLimit) * 100, 'on-demand')
  }
  if (pooledLimit > 0) {
    const used = asNumber(spend.pooledUsed) ?? 0
    return percent((used / pooledLimit) * 100, 'on-demand')
  }
  return null
}

export function failedCursorUsage(cause: CursorErrorCause, message: string): CursorUsage {
  return {
    provider: 'cursor',
    plan: null,
    periodEnd: null,
    limits: [],
    error: { cause, message },
  }
}

export function normalizeCurrentPeriodUsage(
  raw: unknown,
  plan: string | null,
): CursorUsage {
  const source = record(raw)
  if (source === null) {
    throw new CursorSchemaError('Cursor usage result was not an object')
  }

  const planUsage = record(source.planUsage)
  if (planUsage === null) {
    throw new CursorSchemaError('Cursor usage response missing planUsage')
  }

  const periodEnd = msTimestamp(source.billingCycleEnd)
  let planPct = optionalPercent(planUsage.totalPercentUsed, 'plan')
  if (planPct === null) {
    const included = asNumber(planUsage.includedSpend)
    const limit = asNumber(planUsage.limit)
    if (included === null || limit === null || limit <= 0) {
      throw new CursorSchemaError('Cursor usage response missing plan percent')
    }
    planPct = percent((included / limit) * 100, 'plan')
  }

  const limits: CursorUsageLimit[] = [limitRow('plan', planPct, periodEnd)]

  const autoPct = optionalPercent(planUsage.autoPercentUsed, 'auto')
  if (autoPct !== null) limits.push(limitRow('auto', autoPct, periodEnd))

  const apiPct = optionalPercent(planUsage.apiPercentUsed, 'api')
  if (apiPct !== null) limits.push(limitRow('api', apiPct, periodEnd))

  const onDemand = onDemandPercent(record(source.spendLimitUsage))
  if (onDemand !== null) limits.push(limitRow('on-demand', onDemand, periodEnd))

  return {
    provider: 'cursor',
    plan,
    periodEnd,
    limits,
    error: null,
  }
}

function jwtExpiryMs(token: string): number | null {
  const parts = token.split('.')
  if (parts.length < 2) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as {
      exp?: unknown
    }
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null
  } catch {
    return null
  }
}

function accessTokenNeedsRefresh(token: string, now: Date): boolean {
  const exp = jwtExpiryMs(token)
  if (exp === null) return false
  return exp <= now.getTime() + REFRESH_SKEW_MS
}

async function refreshAccessToken(
  refreshToken: string,
  fetcher: CursorFetcher,
  signal: AbortSignal,
): Promise<string> {
  let response: Response
  try {
    response = await fetcher(`${CURSOR_API_BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: CURSOR_OAUTH_CLIENT_ID,
        refresh_token: refreshToken,
      }),
      signal,
    })
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw new CursorClientError('timeout', 'Cursor usage check timed out')
    }
    throw new CursorClientError('network', 'Cursor token refresh failed')
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new CursorClientError('auth', 'Cursor token refresh returned invalid JSON')
  }
  const recordBody = record(body)
  if (recordBody === null) {
    throw new CursorClientError('auth', 'Cursor token refresh returned an invalid body')
  }
  if (recordBody.shouldLogout === true) {
    throw new CursorClientError(
      'not-logged-in',
      'Cursor is not logged in on this machine — open Cursor and sign in',
    )
  }
  const access = asNonEmptyString(recordBody.access_token)
  if (!response.ok || access === null) {
    throw new CursorClientError('auth', 'Cursor token refresh was rejected')
  }
  return access
}

async function fetchCurrentPeriodUsage(
  accessToken: string,
  fetcher: CursorFetcher,
  signal: AbortSignal,
): Promise<unknown> {
  let response: Response
  try {
    response = await fetcher(
      `${CURSOR_API_BASE}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
        },
        body: '{}',
        signal,
      },
    )
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw new CursorClientError('timeout', 'Cursor usage check timed out')
    }
    throw new CursorClientError('network', 'Cursor usage request failed')
  }

  if (response.status === 401 || response.status === 403) {
    throw new CursorClientError('auth', 'Cursor rejected the usage request')
  }
  if (!response.ok) {
    throw new CursorClientError('network', `Cursor usage request failed (${response.status})`)
  }

  try {
    return await response.json()
  } catch {
    throw new CursorClientError('schema', 'Cursor usage response was not JSON')
  }
}

export async function collectCursorUsage(deps: CursorUsageDeps): Promise<CursorUsage> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), deps.timeoutMs)
  try {
    const auth = await deps.readAuth()
    let accessToken = auth.accessToken
    if (accessTokenNeedsRefresh(accessToken, deps.now())) {
      if (auth.refreshToken === null) {
        throw new CursorClientError(
          'not-logged-in',
          'Cursor access token expired and no refresh token is available',
        )
      }
      accessToken = await refreshAccessToken(
        auth.refreshToken,
        deps.fetch,
        controller.signal,
      )
    }

    let raw: unknown
    try {
      raw = await fetchCurrentPeriodUsage(accessToken, deps.fetch, controller.signal)
    } catch (error) {
      if (
        error instanceof CursorClientError
        && error.clientCause === 'auth'
        && auth.refreshToken !== null
        && accessToken === auth.accessToken
      ) {
        accessToken = await refreshAccessToken(
          auth.refreshToken,
          deps.fetch,
          controller.signal,
        )
        raw = await fetchCurrentPeriodUsage(accessToken, deps.fetch, controller.signal)
      } else {
        throw error
      }
    }

    return normalizeCurrentPeriodUsage(raw, auth.plan)
  } catch (error) {
    if (error instanceof CursorAuthError) {
      return failedCursorUsage(error.authCause, error.message)
    }
    if (error instanceof CursorClientError) {
      return failedCursorUsage(error.clientCause, error.message)
    }
    if (error instanceof CursorSchemaError) {
      return failedCursorUsage('schema', error.message)
    }
    if ((error as Error).name === 'AbortError') {
      return failedCursorUsage('timeout', 'Cursor usage check timed out')
    }
    return failedCursorUsage('network', 'Cursor usage could not be read')
  } finally {
    clearTimeout(timeout)
  }
}

export function buildCollectCursorUsage(
  store: CursorAuthStore,
  options: { fetch?: CursorFetcher; timeoutMs: number; now?: () => Date },
): () => Promise<CursorUsage> {
  return () => collectCursorUsage({
    readAuth: () => readCursorAuth(store),
    fetch: options.fetch ?? fetch,
    now: options.now ?? (() => new Date()),
    timeoutMs: options.timeoutMs,
  })
}
