import { describe, expect, test } from 'bun:test'
import { collectUsage, type UsageDeps } from '../src/usage'
import { AuthError, SchemaError } from '../src/usage-api'
import type { Account, UsageWindows } from '../src/types'

const WINDOWS: UsageWindows = {
  fiveHourPct: 20,
  fiveHourResetsAt: new Date('2026-08-03T12:00:00Z'),
  weeklyPct: 30,
  weeklyResetsAt: new Date('2026-08-08T12:00:00Z'),
  opusWeeklyPct: null,
}

const accounts: Account[] = [
  { id: 'a', label: 'A', email: 'a@x.com', order: 1 },
  { id: 'b', label: 'B', email: 'b@x.com', order: 2 },
]

function deps(overrides: Partial<UsageDeps> = {}): UsageDeps {
  return {
    keychain: {
      get: async () => 'tok',
      set: async () => {},
      remove: async () => {},
    },
    fetchWindows: async () => WINDOWS,
    probeWindows: async () => WINDOWS,
    ...overrides,
  }
}

describe('collectUsage', () => {
  test('returns one row per account, in order', async () => {
    const rows = await collectUsage(accounts, deps())
    expect(rows.map(r => r.id)).toEqual(['a', 'b'])
    expect(rows.every(r => r.source === 'api')).toBe(true)
  })

  test('marks an account with no stored token', async () => {
    const rows = await collectUsage(accounts, deps({ keychain: {
      get: async (id: string) => (id === 'a' ? null : 'tok'),
      set: async () => {}, remove: async () => {},
    } }))
    expect(rows[0]!.error?.cause).toBe('no-token')
    expect(rows[0]!.source).toBe('none')
    expect(rows[1]!.error).toBeNull()
  })

  test('does not fall back to probe on an auth failure', async () => {
    let probed = false
    const rows = await collectUsage(accounts, deps({
      fetchWindows: async () => { throw new AuthError('token rejected (HTTP 401)') },
      probeWindows: async () => { probed = true; return WINDOWS },
    }))
    expect(probed).toBe(false)
    expect(rows[0]!.error?.cause).toBe('auth')
  })

  test('falls back to probe on a schema failure', async () => {
    const rows = await collectUsage(accounts, deps({
      fetchWindows: async () => { throw new SchemaError('unrecognized') },
    }))
    expect(rows[0]!.source).toBe('probe')
    expect(rows[0]!.error).toBeNull()
    expect(rows[0]!.fiveHourPct).toBe(20)
  })

  test('falls back to probe on a network failure', async () => {
    const rows = await collectUsage(accounts, deps({
      fetchWindows: async () => { throw new TypeError('fetch failed') },
    }))
    expect(rows[0]!.source).toBe('probe')
  })

  test('reports probe-failed when both paths fail', async () => {
    const rows = await collectUsage(accounts, deps({
      fetchWindows: async () => { throw new SchemaError('unrecognized') },
      probeWindows: async () => { throw new Error('probe failed (exit 1)') },
    }))
    expect(rows[0]!.error?.cause).toBe('probe-failed')
    expect(rows[0]!.source).toBe('none')
    expect(rows[0]!.fiveHourPct).toBeNull()
  })

  test('one failing account does not affect the others', async () => {
    const rows = await collectUsage(accounts, deps({
      fetchWindows: async (token: string) => {
        if (token === 'bad') throw new AuthError('token rejected (HTTP 401)')
        return WINDOWS
      },
      keychain: {
        get: async (id: string) => (id === 'a' ? 'bad' : 'tok'),
        set: async () => {}, remove: async () => {},
      },
    }))
    expect(rows[0]!.error?.cause).toBe('auth')
    expect(rows[1]!.error).toBeNull()
    expect(rows[1]!.fiveHourPct).toBe(20)
  })

  test('runs accounts concurrently', async () => {
    let inFlight = 0
    let peak = 0
    await collectUsage(accounts, deps({
      fetchWindows: async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await Bun.sleep(10)
        inFlight -= 1
        return WINDOWS
      },
    }))
    expect(peak).toBe(2)
  })
})
