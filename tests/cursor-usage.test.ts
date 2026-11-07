import { describe, expect, test } from 'bun:test'
import { CursorAuthError, type CursorAuth } from '../src/cursor-auth'
import {
  collectCursorUsage,
  normalizeCurrentPeriodUsage,
  type CursorUsageDeps,
} from '../src/cursor-usage'

const PERIOD = {
  billingCycleStart: '1768399334000',
  billingCycleEnd: '1771077734000',
  planUsage: {
    totalSpend: 23222,
    includedSpend: 23222,
    bonusSpend: 0,
    remaining: 16778,
    limit: 40000,
    autoPercentUsed: 0,
    apiPercentUsed: 46.444,
    totalPercentUsed: 58.055,
  },
  spendLimitUsage: {
    totalSpend: 0,
    individualLimit: 10000,
    individualUsed: 2500,
    individualRemaining: 7500,
    pooledLimit: 0,
    pooledUsed: 0,
    limitType: 'user',
  },
}

const AUTH: CursorAuth = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  plan: 'pro',
}

function deps(overrides: Partial<CursorUsageDeps> = {}): CursorUsageDeps {
  return {
    readAuth: async () => AUTH,
    fetch: async () => new Response(JSON.stringify(PERIOD), { status: 200 }),
    now: () => new Date('2026-08-08T00:00:00Z'),
    timeoutMs: 8_000,
    ...overrides,
  }
}

describe('normalizeCurrentPeriodUsage', () => {
  test('builds plan/auto/api/on-demand rows from the dashboard response', () => {
    const usage = normalizeCurrentPeriodUsage(PERIOD, 'ultra')
    expect(usage.provider).toBe('cursor')
    expect(usage.plan).toBe('ultra')
    expect(usage.error).toBeNull()
    expect(usage.periodEnd).toEqual(new Date(1771077734000))
    expect(usage.limits.map(limit => limit.id)).toEqual([
      'plan',
      'auto',
      'api',
      'on-demand',
    ])
    expect(usage.limits[0]).toEqual({
      id: 'plan',
      name: 'plan',
      usedPct: 58,
      resetsAt: new Date(1771077734000),
    })
    expect(usage.limits[1]!.usedPct).toBe(0)
    expect(usage.limits[2]!.usedPct).toBe(46)
    expect(usage.limits[3]!.usedPct).toBe(25)
  })

  test('derives plan percent from includedSpend/limit when totalPercentUsed is absent', () => {
    const usage = normalizeCurrentPeriodUsage({
      billingCycleEnd: '1771077734000',
      planUsage: {
        includedSpend: 1000,
        limit: 4000,
        autoPercentUsed: 10,
        apiPercentUsed: 20,
      },
    }, 'pro')
    expect(usage.limits[0]!.usedPct).toBe(25)
    expect(usage.limits.map(limit => limit.id)).toEqual(['plan', 'auto', 'api'])
  })

  test('omits on-demand when no spend limit is set', () => {
    const usage = normalizeCurrentPeriodUsage({
      billingCycleEnd: null,
      planUsage: {
        totalPercentUsed: 12,
        autoPercentUsed: 1,
        apiPercentUsed: 2,
      },
      spendLimitUsage: {
        individualLimit: 0,
        pooledLimit: 0,
      },
    }, null)
    expect(usage.periodEnd).toBeNull()
    expect(usage.limits.map(limit => limit.id)).toEqual(['plan', 'auto', 'api'])
  })

  test('rejects invalid percentages', () => {
    expect(() => normalizeCurrentPeriodUsage({
      planUsage: { totalPercentUsed: 101 },
    }, 'pro')).toThrow(/percent/)
  })

  test('rejects a response without planUsage', () => {
    expect(() => normalizeCurrentPeriodUsage({}, 'pro')).toThrow(/planUsage/)
  })
})

describe('collectCursorUsage', () => {
  test('returns normalized usage for a successful read', async () => {
    const usage = await collectCursorUsage(deps())
    expect(usage.error).toBeNull()
    expect(usage.plan).toBe('pro')
    expect(usage.limits[0]!.usedPct).toBe(58)
  })

  test('refreshes an expired access token in memory and retries', async () => {
    const expired = [
      Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
      Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url'),
      'sig',
    ].join('.')
    const calls: Array<{ url: string; auth?: string | null }> = []
    const usage = await collectCursorUsage(deps({
      readAuth: async () => ({
        accessToken: expired,
        refreshToken: 'refresh-token',
        plan: 'pro',
      }),
      fetch: async (input, init) => {
        const url = String(input)
        const auth = init?.headers instanceof Headers
          ? init.headers.get('Authorization')
          : (init?.headers as Record<string, string> | undefined)?.Authorization ?? null
        calls.push({ url, auth })
        if (url.includes('/oauth/token')) {
          return new Response(JSON.stringify({
            access_token: 'fresh-token',
            shouldLogout: false,
          }), { status: 200 })
        }
        return new Response(JSON.stringify(PERIOD), { status: 200 })
      },
    }))
    expect(usage.error).toBeNull()
    expect(calls.some(call => call.url.includes('/oauth/token'))).toBe(true)
    expect(calls.some(call => call.auth === 'Bearer fresh-token')).toBe(true)
  })

  test('reports not-logged-in when refresh requires logout', async () => {
    const expired = [
      Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
      Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url'),
      'sig',
    ].join('.')
    const usage = await collectCursorUsage(deps({
      readAuth: async () => ({
        accessToken: expired,
        refreshToken: 'refresh-token',
        plan: 'pro',
      }),
      fetch: async url => {
        if (String(url).includes('/oauth/token')) {
          return new Response(JSON.stringify({
            access_token: '',
            shouldLogout: true,
          }), { status: 200 })
        }
        return new Response('no', { status: 500 })
      },
    }))
    expect(usage.error?.cause).toBe('not-logged-in')
  })

  test('reports auth when the usage endpoint returns 401 after refresh', async () => {
    const usage = await collectCursorUsage(deps({
      readAuth: async () => ({
        accessToken: 'access-token',
        refreshToken: null,
        plan: 'pro',
      }),
      fetch: async () => new Response('nope', { status: 401 }),
    }))
    expect(usage.error?.cause).toBe('auth')
  })

  test('isolates auth-reader failures into a safe CursorUsage error', async () => {
    const usage = await collectCursorUsage(deps({
      readAuth: async () => {
        throw new CursorAuthError(
          'not-logged-in',
          'Cursor is not logged in on this machine',
        )
      },
    }))
    expect(usage.error?.cause).toBe('not-logged-in')
    expect(usage.error?.message).toMatch(/not logged in/i)
  })

  test('never puts tokens into the returned value', async () => {
    const usage = await collectCursorUsage(deps())
    expect(JSON.stringify(usage)).not.toContain('access-token')
    expect(JSON.stringify(usage)).not.toContain('refresh-token')
  })
})
