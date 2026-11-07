import {
  GROK_API_BASE,
  GROK_CLIENT_MODE,
  GROK_OAUTH_TOKEN_ENDPOINT,
  REFRESH_SKEW_MS,
} from './constants'
import {
  GrokAuthError,
  type GrokAuth,
  type GrokAuthStore,
  readGrokAuth,
} from './grok-auth'
import type {
  GrokErrorCause,
  GrokLimitId,
  GrokUsage,
  GrokUsageLimit,
} from './types'

export class GrokSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GrokSchemaError'
  }
}

class GrokClientError extends Error {
  constructor(
    readonly clientCause: GrokErrorCause,
    message: string,
  ) {
    super(message)
    this.name = 'GrokClientError'
  }
}

export type GrokFetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export type GrokUsageDeps = {
  readAuth: () => Promise<GrokAuth>
  fetch: GrokFetcher
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

function moneyVal(value: unknown, field: string): number {
  if (value === null || value === undefined) {
    throw new GrokSchemaError(`missing ${field}`)
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const wrapped = record(value)
  const nested = wrapped === null ? null : asNumber(wrapped.val)
  if (nested === null) throw new GrokSchemaError(`invalid ${field}`)
  return nested
}

function optionalMoneyVal(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null
  return moneyVal(value, field)
}

function isoDate(value: unknown, field: string): Date | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || value === '') {
    throw new GrokSchemaError(`invalid ${field}`)
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new GrokSchemaError(`invalid ${field}`)
  }
  return date
}

function percentFromAmounts(used: number, limit: number, field: string): number {
  if (limit <= 0) throw new GrokSchemaError(`invalid ${field} limit`)
  if (used < 0) throw new GrokSchemaError(`invalid ${field} used`)
  const pct = (used / limit) * 100
  if (!Number.isFinite(pct)) throw new GrokSchemaError(`invalid ${field} percent`)
  return Math.min(100, Math.max(0, Math.round(pct)))
}

function limitRow(
  id: GrokLimitId,
  usedPct: number,
  resetsAt: Date | null,
): GrokUsageLimit {
  return { id, name: id, usedPct, resetsAt }
}

function normalizePlan(raw: string | null): string | null {
  if (raw === null) return null
  // subscriptionTiers looks like "GrokPro" / "SuperGrok" — keep readable.
  return raw.replace(/^Grok/i, '').toLowerCase() || raw.toLowerCase()
}

export function failedGrokUsage(cause: GrokErrorCause, message: string): GrokUsage {
  return {
    provider: 'grok',
    plan: null,
    periodEnd: null,
    limits: [],
    error: { cause, message },
  }
}

export function normalizeGrokBilling(
  billingRaw: unknown,
  plan: string | null,
): GrokUsage {
  const root = record(billingRaw)
  if (root === null) {
    throw new GrokSchemaError('Grok billing result was not an object')
  }
  const config = record(root.config)
  if (config === null) {
    throw new GrokSchemaError('Grok billing response missing config')
  }

  const monthlyLimit = moneyVal(config.monthlyLimit, 'monthlyLimit')
  const used = moneyVal(config.used, 'used')
  const periodEnd = isoDate(config.billingPeriodEnd, 'billingPeriodEnd')
  const limits: GrokUsageLimit[] = [
    limitRow('monthly', percentFromAmounts(used, monthlyLimit, 'monthly'), periodEnd),
  ]

  const onDemandCap = optionalMoneyVal(config.onDemandCap, 'onDemandCap') ?? 0
  if (onDemandCap > 0) {
    const onDemandUsed = optionalMoneyVal(config.onDemandUsed, 'onDemandUsed') ?? 0
    limits.push(
      limitRow(
        'on-demand',
        percentFromAmounts(onDemandUsed, onDemandCap, 'on-demand'),
        periodEnd,
      ),
    )
  }

  return {
    provider: 'grok',
    plan: normalizePlan(plan),
    periodEnd,
    limits,
    error: null,
  }
}

function accessTokenNeedsRefresh(auth: GrokAuth, now: Date): boolean {
  if (auth.expiresAt === null) return false
  return auth.expiresAt.getTime() <= now.getTime() + REFRESH_SKEW_MS
}

async function refreshAccessToken(
  auth: GrokAuth,
  fetcher: GrokFetcher,
  signal: AbortSignal,
): Promise<string> {
  if (auth.refreshToken === null || auth.clientId === null) {
    throw new GrokClientError(
      'not-logged-in',
      'Grok access token expired and no refresh credentials are available',
    )
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: auth.refreshToken,
    client_id: auth.clientId,
  })

  let response: Response
  try {
    response = await fetcher(GROK_OAUTH_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal,
    })
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw new GrokClientError('timeout', 'Grok usage check timed out')
    }
    throw new GrokClientError('network', 'Grok token refresh failed')
  }

  let json: unknown
  try {
    json = await response.json()
  } catch {
    throw new GrokClientError('auth', 'Grok token refresh returned invalid JSON')
  }
  const recordBody = record(json)
  const access = recordBody === null ? null : asNonEmptyString(recordBody.access_token)
  if (!response.ok || access === null) {
    if (response.status === 400 || response.status === 401) {
      throw new GrokClientError(
        'not-logged-in',
        'Grok is not logged in on this machine — run `grok login`',
      )
    }
    throw new GrokClientError('auth', 'Grok token refresh was rejected')
  }
  return access
}

async function fetchJson(
  url: string,
  accessToken: string,
  fetcher: GrokFetcher,
  signal: AbortSignal,
  label: string,
): Promise<unknown> {
  let response: Response
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'x-grok-client-mode': GROK_CLIENT_MODE,
      },
      signal,
    })
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw new GrokClientError('timeout', 'Grok usage check timed out')
    }
    throw new GrokClientError('network', `${label} request failed`)
  }

  if (response.status === 401 || response.status === 403) {
    throw new GrokClientError('auth', `${label} was rejected`)
  }
  if (!response.ok) {
    throw new GrokClientError('network', `${label} failed (${response.status})`)
  }

  try {
    return await response.json()
  } catch {
    throw new GrokClientError('schema', `${label} response was not JSON`)
  }
}

function planFromUser(raw: unknown): string | null {
  const source = record(raw)
  if (source === null) return null
  return asNonEmptyString(source.subscriptionTiers)
    ?? asNonEmptyString(source.subscriptionTier)
    ?? asNonEmptyString(source.plan)
}

async function fetchBillingAndPlan(
  accessToken: string,
  fetcher: GrokFetcher,
  signal: AbortSignal,
): Promise<{ billing: unknown; plan: string | null }> {
  const [billing, user] = await Promise.all([
    fetchJson(`${GROK_API_BASE}/billing`, accessToken, fetcher, signal, 'Grok billing'),
    fetchJson(
      `${GROK_API_BASE}/user?include=subscription`,
      accessToken,
      fetcher,
      signal,
      'Grok profile',
    ).catch(() => null),
  ])
  return { billing, plan: planFromUser(user) }
}

export async function collectGrokUsage(deps: GrokUsageDeps): Promise<GrokUsage> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), deps.timeoutMs)
  try {
    const auth = await deps.readAuth()
    let accessToken = auth.accessToken
    if (accessTokenNeedsRefresh(auth, deps.now())) {
      accessToken = await refreshAccessToken(auth, deps.fetch, controller.signal)
    }

    let payload: { billing: unknown; plan: string | null }
    try {
      payload = await fetchBillingAndPlan(accessToken, deps.fetch, controller.signal)
    } catch (error) {
      if (
        error instanceof GrokClientError
        && error.clientCause === 'auth'
        && auth.refreshToken !== null
        && accessToken === auth.accessToken
      ) {
        accessToken = await refreshAccessToken(auth, deps.fetch, controller.signal)
        payload = await fetchBillingAndPlan(accessToken, deps.fetch, controller.signal)
      } else {
        throw error
      }
    }

    return normalizeGrokBilling(payload.billing, payload.plan)
  } catch (error) {
    if (error instanceof GrokAuthError) {
      return failedGrokUsage(error.authCause, error.message)
    }
    if (error instanceof GrokClientError) {
      return failedGrokUsage(error.clientCause, error.message)
    }
    if (error instanceof GrokSchemaError) {
      return failedGrokUsage('schema', error.message)
    }
    if ((error as Error).name === 'AbortError') {
      return failedGrokUsage('timeout', 'Grok usage check timed out')
    }
    return failedGrokUsage('network', 'Grok usage could not be read')
  } finally {
    clearTimeout(timeout)
  }
}

export function buildCollectGrokUsage(
  store: GrokAuthStore,
  options: { fetch?: GrokFetcher; timeoutMs: number; now?: () => Date },
): () => Promise<GrokUsage> {
  return () => collectGrokUsage({
    readAuth: () => readGrokAuth(store),
    fetch: options.fetch ?? fetch,
    now: options.now ?? (() => new Date()),
    timeoutMs: options.timeoutMs,
  })
}
