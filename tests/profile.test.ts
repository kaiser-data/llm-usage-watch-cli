import { describe, expect, test } from 'bun:test'
import { fetchSubscription, nextMonthlyAnniversary, normalizeProfile } from '../src/profile'
import { SchemaError } from '../src/usage-api'

const CREATED = '2026-07-28T10:32:23.265057Z'

function profilePayload(overrides: Record<string, unknown> = {}) {
  return {
    account: { has_claude_pro: true, has_claude_max: false },
    organization: {
      organization_type: 'claude_pro',
      subscription_status: 'active',
      subscription_created_at: CREATED,
      claude_code_trial_ends_at: null,
      ...overrides,
    },
  }
}

describe('nextMonthlyAnniversary', () => {
  test('returns the same day next month when the day has passed', () => {
    const start = new Date('2026-07-28T10:00:00Z')
    const now = new Date('2026-08-03T00:00:00Z')
    expect(nextMonthlyAnniversary(start, now)?.toISOString().slice(0, 10)).toBe('2026-08-28')
  })

  test('returns this month when the day is still ahead', () => {
    const start = new Date('2026-07-28T10:00:00Z')
    const now = new Date('2026-08-20T00:00:00Z')
    expect(nextMonthlyAnniversary(start, now)?.toISOString().slice(0, 10)).toBe('2026-08-28')
  })

  test('rolls into the next month once the day is past', () => {
    const start = new Date('2026-07-05T10:00:00Z')
    const now = new Date('2026-08-20T00:00:00Z')
    expect(nextMonthlyAnniversary(start, now)?.toISOString().slice(0, 10)).toBe('2026-09-05')
  })

  test('clamps a 31st start date to a short month', () => {
    const start = new Date('2026-01-31T10:00:00Z')
    const now = new Date('2026-02-10T00:00:00Z')
    // February has no 31st; the anniversary lands on the last valid day.
    const result = nextMonthlyAnniversary(start, now)
    expect(result?.getUTCMonth()).toBe(2)
  })

  test('returns null without a start date', () => {
    expect(nextMonthlyAnniversary(null, new Date())).toBeNull()
  })
})

describe('normalizeProfile', () => {
  const now = new Date('2026-08-03T00:00:00Z')

  test('reads a pro plan', () => {
    expect(normalizeProfile(profilePayload(), now).plan).toBe('pro')
  })

  test('reads a max plan', () => {
    const payload = profilePayload()
    payload.account = { has_claude_pro: false, has_claude_max: true }
    expect(normalizeProfile(payload, now).plan).toBe('max')
  })

  test('falls back to the raw organization type for anything else', () => {
    const payload = profilePayload({ organization_type: 'enterprise' })
    payload.account = { has_claude_pro: false, has_claude_max: false }
    expect(normalizeProfile(payload, now).plan).toBe('enterprise')
  })

  test('carries the subscription status', () => {
    expect(normalizeProfile(profilePayload(), now).status).toBe('active')
  })

  test('derives the next renewal from the creation date', () => {
    const subscription = normalizeProfile(profilePayload(), now)
    expect(subscription.renewsAt?.toISOString().slice(0, 10)).toBe('2026-08-28')
  })

  test('surfaces a trial end date when present', () => {
    const payload = profilePayload({ claude_code_trial_ends_at: '2026-08-10T00:00:00Z' })
    expect(normalizeProfile(payload, now).trialEndsAt?.toISOString().slice(0, 10)).toBe('2026-08-10')
  })

  test('tolerates a payload with no organization block', () => {
    const subscription = normalizeProfile({ account: {} }, now)
    expect(subscription.plan).toBe('unknown')
    expect(subscription.renewsAt).toBeNull()
  })

  test('throws SchemaError when the payload is not an object', () => {
    expect(() => normalizeProfile('nope', now)).toThrow(SchemaError)
  })
})

describe('fetchSubscription', () => {
  test('sends the bearer token', async () => {
    let seen: Request | undefined
    const fetcher = (async (input: string, init?: RequestInit) => {
      seen = new Request(input, init)
      return Response.json(profilePayload())
    }) as unknown as typeof fetch
    await fetchSubscription('tok-abc', {
      fetcher, endpoint: 'https://x/profile', timeoutMs: 1000, now: new Date(),
    })
    expect(seen?.headers.get('authorization')).toBe('Bearer tok-abc')
  })

  test('returns null rather than failing the whole row on error', async () => {
    const fetcher = (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch
    const result = await fetchSubscription('tok', {
      fetcher, endpoint: 'https://x/profile', timeoutMs: 1000, now: new Date(),
    })
    expect(result).toBeNull()
  })
})
