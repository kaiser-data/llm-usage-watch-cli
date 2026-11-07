import { describe, expect, test } from 'bun:test'
import { GrokAuthError, type GrokAuth } from '../src/grok-auth'
import {
  collectGrokUsage,
  normalizeGrokBilling,
  type GrokUsageDeps,
} from '../src/grok-usage'

const BILLING = {
  config: {
    monthlyLimit: { val: 15000 },
    used: { val: 1500 },
    onDemandCap: { val: 5000 },
    onDemandUsed: { val: 1000 },
    billingPeriodStart: '2026-08-01T00:00:00+00:00',
    billingPeriodEnd: '2026-09-01T00:00:00+00:00',
    history: [],
  },
}

const AUTH: GrokAuth = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  clientId: 'client-id',
  expiresAt: new Date('2099-01-01T00:00:00Z'),
}

function deps(overrides: Partial<GrokUsageDeps> = {}): GrokUsageDeps {
  return {
    readAuth: async () => AUTH,
    fetch: async (input) => {
      const url = String(input)
      if (url.includes('/billing')) {
        return new Response(JSON.stringify(BILLING), { status: 200 })
      }
      if (url.includes('/user')) {
        return new Response(JSON.stringify({ subscriptionTiers: 'GrokPro' }), {
          status: 200,
        })
      }
      return new Response('{}', { status: 404 })
    },
    now: () => new Date('2026-08-08T00:00:00Z'),
    timeoutMs: 8_000,
    ...overrides,
  }
}

describe('normalizeGrokBilling', () => {
  test('builds monthly and on-demand rows from the billing response', () => {
    const usage = normalizeGrokBilling(BILLING, 'GrokPro')
    expect(usage.provider).toBe('grok')
    expect(usage.plan).toBe('pro')
    expect(usage.error).toBeNull()
    expect(usage.periodEnd).toEqual(new Date('2026-09-01T00:00:00+00:00'))
    expect(usage.limits.map(limit => limit.id)).toEqual(['monthly', 'on-demand'])
    expect(usage.limits[0]).toEqual({
      id: 'monthly',
      name: 'monthly',
      usedPct: 10,
      resetsAt: new Date('2026-09-01T00:00:00+00:00'),
    })
    expect(usage.limits[1]!.usedPct).toBe(20)
  })

  test('omits on-demand when the cap is zero', () => {
    const usage = normalizeGrokBilling({
      config: {
        monthlyLimit: { val: 100 },
        used: { val: 25 },
        onDemandCap: { val: 0 },
        billingPeriodEnd: '2026-09-01T00:00:00Z',
      },
    }, 'SuperGrok')
    expect(usage.plan).toBe('supergrok')
    expect(usage.limits.map(limit => limit.id)).toEqual(['monthly'])
    expect(usage.limits[0]!.usedPct).toBe(25)
  })

  test('accepts bare numeric money fields', () => {
    const usage = normalizeGrokBilling({
      config: {
        monthlyLimit: 200,
        used: 50,
        billingPeriodEnd: null,
      },
    }, null)
    expect(usage.limits[0]!.usedPct).toBe(25)
    expect(usage.periodEnd).toBeNull()
    expect(usage.plan).toBeNull()
  })

  test('rejects missing monthly fields', () => {
    expect(() => normalizeGrokBilling({ config: {} }, null)).toThrow()
  })
})

describe('collectGrokUsage', () => {
  test('returns normalized usage for a healthy login', async () => {
    const usage = await collectGrokUsage(deps())
    expect(usage.error).toBeNull()
    expect(usage.plan).toBe('pro')
    expect(usage.limits[0]!.usedPct).toBe(10)
  })

  test('surfaces auth-store failures as display errors', async () => {
    const usage = await collectGrokUsage(deps({
      readAuth: async () => {
        throw new GrokAuthError('not-logged-in', 'Grok is not logged in')
      },
    }))
    expect(usage.error?.cause).toBe('not-logged-in')
    expect(usage.limits).toEqual([])
  })

  test('refreshes an expired access token before the billing call', async () => {
    const calls: string[] = []
    const usage = await collectGrokUsage(deps({
      readAuth: async () => ({
        ...AUTH,
        expiresAt: new Date('2020-01-01T00:00:00Z'),
      }),
      fetch: async (input, init) => {
        const url = String(input)
        calls.push(`${init?.method ?? 'GET'} ${url}`)
        if (url.includes('oauth2/token')) {
          return Response.json({ access_token: 'fresh-token', expires_in: 3600 })
        }
        if (url.includes('/billing')) {
          const auth = (init?.headers as Record<string, string>)?.Authorization
            ?? (init?.headers as Headers | undefined)?.get?.('Authorization')
          expect(auth).toBe('Bearer fresh-token')
          return Response.json(BILLING)
        }
        if (url.includes('/user')) {
          return Response.json({ subscriptionTiers: 'GrokPro' })
        }
        return new Response('{}', { status: 404 })
      },
    }))
    expect(usage.error).toBeNull()
    expect(calls.some(call => call.includes('oauth2/token'))).toBe(true)
  })

  test('retries once after a 401 by refreshing the token', async () => {
    let billingHits = 0
    const usage = await collectGrokUsage(deps({
      fetch: async (input) => {
        const url = String(input)
        if (url.includes('oauth2/token')) {
          return Response.json({ access_token: 'fresh-token', expires_in: 3600 })
        }
        if (url.includes('/billing')) {
          billingHits += 1
          if (billingHits === 1) return new Response('{}', { status: 401 })
          return Response.json(BILLING)
        }
        if (url.includes('/user')) {
          return Response.json({ subscriptionTiers: 'GrokPro' })
        }
        return new Response('{}', { status: 404 })
      },
    }))
    expect(usage.error).toBeNull()
    expect(usage.limits[0]!.usedPct).toBe(10)
    expect(billingHits).toBe(2)
  })

  test('survives a profile failure and still returns billing', async () => {
    const usage = await collectGrokUsage(deps({
      fetch: async (input) => {
        const url = String(input)
        if (url.includes('/billing')) return Response.json(BILLING)
        if (url.includes('/user')) return new Response('{}', { status: 500 })
        return new Response('{}', { status: 404 })
      },
    }))
    expect(usage.error).toBeNull()
    expect(usage.plan).toBeNull()
    expect(usage.limits[0]!.usedPct).toBe(10)
  })

  test('never throws on network failure', async () => {
    const usage = await collectGrokUsage(deps({
      fetch: async () => { throw new Error('offline') },
    }))
    expect(usage.error?.cause).toBe('network')
  })
})
