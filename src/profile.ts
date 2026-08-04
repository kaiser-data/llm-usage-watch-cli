import { OAUTH_BETA_HEADER } from './constants'
import type { Subscription } from './types'
import { SchemaError } from './usage-api'

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null
}

function asDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/**
 * The next monthly anniversary of `start` at or after `now`.
 *
 * This is a *derivation*, not a fact: the API exposes no billing period and no
 * end date, so an annual subscription will renew later than this suggests.
 * Callers must present it as an estimate.
 */
export function nextMonthlyAnniversary(start: Date | null, now: Date): Date | null {
  if (start === null) return null

  const day = start.getUTCDate()
  const candidate = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    day,
    start.getUTCHours(),
    start.getUTCMinutes(),
  ))

  // A 31st start date overflows a short month; Date rolls it forward, which is
  // the behaviour we want — the charge lands at the start of the next month.
  if (candidate.getTime() >= now.getTime()) return candidate

  return new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth() + 1,
    day,
    start.getUTCHours(),
    start.getUTCMinutes(),
  ))
}

function planOf(account: Record<string, unknown>, organization: Record<string, unknown>): string {
  if (account.has_claude_max === true) return 'max'
  if (account.has_claude_pro === true) return 'pro'
  const raw = organization.organization_type
  if (typeof raw !== 'string' || raw === '') return 'unknown'
  // 'claude_pro' -> 'pro', 'claude_max' -> 'max', 'enterprise' -> 'enterprise'
  return raw.replace(/^claude_/, '')
}

export function normalizeProfile(raw: unknown, now: Date): Subscription {
  const root = asRecord(raw)
  if (root === null) throw new SchemaError('profile response was not a JSON object')

  const account = asRecord(root.account) ?? {}
  const organization = asRecord(root.organization) ?? {}
  const createdAt = asDate(organization.subscription_created_at)

  return {
    plan: planOf(account, organization),
    status: typeof organization.subscription_status === 'string'
      ? organization.subscription_status
      : null,
    createdAt,
    renewsAt: nextMonthlyAnniversary(createdAt, now),
    trialEndsAt: asDate(organization.claude_code_trial_ends_at),
  }
}

/** Who a credential belongs to. Used to name and protect the outgoing login. */
export type Identity = { uuid: string; email: string }

export function normalizeIdentity(raw: unknown): Identity | null {
  const account = asRecord(asRecord(raw)?.account)
  const uuid = account?.uuid
  if (typeof uuid !== 'string' || uuid === '') return null
  const email = account?.email
  return { uuid, email: typeof email === 'string' ? email : '' }
}

export type ProfileDeps = {
  fetcher: typeof fetch
  endpoint: string
  timeoutMs: number
  now: Date
}

/** Returns the parsed profile payload, or null on any failure. */
async function requestProfile(token: string, deps: ProfileDeps): Promise<unknown | null> {
  try {
    const response = await deps.fetcher(deps.endpoint, {
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': OAUTH_BETA_HEADER,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(deps.timeoutMs),
    })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

/**
 * Returns null on any failure. Plan info is a nice-to-have decoration: it must
 * never turn a usable usage row into an error row.
 */
export async function fetchSubscription(
  token: string,
  deps: ProfileDeps,
): Promise<Subscription | null> {
  const payload = await requestProfile(token, deps)
  if (payload === null) return null
  try {
    return normalizeProfile(payload, deps.now)
  } catch {
    return null
  }
}

/** Null when the profile cannot be read or carries no account uuid. */
export async function fetchIdentity(
  token: string,
  deps: ProfileDeps,
): Promise<Identity | null> {
  const payload = await requestProfile(token, deps)
  return payload === null ? null : normalizeIdentity(payload)
}
