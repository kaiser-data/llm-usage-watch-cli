import { describe, expect, test } from 'bun:test'
import { collectUsage, type UsageDeps } from '../src/usage'
import { AuthError, RateLimitError, SchemaError } from '../src/usage-api'
import { CredentialError } from '../src/credentials'
import { RE_ADD_HINT } from '../src/hints'
import type { Account, UsageWindows } from '../src/types'

/** A keychain whose `get` fails for account `a` and succeeds for every other. */
function keychainFailing(error: unknown) {
  return {
    get: async (id: string) => {
      if (id === 'a') throw error
      return 'tok'
    },
    set: async () => {},
    remove: async () => {},
  }
}

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
    sleep: async () => {},
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

  // A credential that cannot be turned into a token used to throw straight out
  // of collectOne, rejecting collectUsage's Promise.all and taking every other
  // account's row down with it — including under `cuw doctor`, whose whole job
  // is to report exactly this.
  test('fails only the account whose refresh token was rejected', async () => {
    const rows = await collectUsage(accounts, deps({
      keychain: keychainFailing(
        new CredentialError(
          `refresh token expired or rejected (HTTP 400) — re-add the account with \`${RE_ADD_HINT}\``,
          'refresh-rejected',
        ),
      ),
    }))
    expect(rows[0]!.error?.cause).toBe('auth')
    expect(rows[0]!.source).toBe('none')
    expect(rows[1]!.error).toBeNull()
    expect(rows[1]!.source).toBe('api')
  })

  test('points the re-add hint at the account that actually failed', async () => {
    const rows = await collectUsage(accounts, deps({
      keychain: keychainFailing(
        new CredentialError(
          `refresh token expired or rejected (HTTP 400) — re-add the account with \`${RE_ADD_HINT}\``,
          'refresh-rejected',
        ),
      ),
    }))
    expect(rows[0]!.error?.message).toContain('cuw login a')
    expect(rows[0]!.error?.message).not.toContain('<id>')
  })

  test('reports a malformed stored credential without probing', async () => {
    let probed = false
    const rows = await collectUsage(accounts, deps({
      keychain: keychainFailing(
        new CredentialError('credential has no refresh token', 'malformed'),
      ),
      probeWindows: async () => { probed = true; return WINDOWS },
    }))
    expect(probed).toBe(false)
    expect(rows[0]!.error?.cause).toBe('auth')
    expect(rows[0]!.error?.message).toContain('no refresh token')
  })

  test('survives a keychain that fails for reasons of its own', async () => {
    const rows = await collectUsage(accounts, deps({
      keychain: keychainFailing(new Error('security: exit status 1')),
    }))
    expect(rows[0]!.error?.cause).toBe('auth')
    expect(rows[0]!.error?.message).toContain('security: exit status 1')
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

  test('retries a throttled usage read rather than probing', async () => {
    // The probe spends real quota and opens a window. A 429 on the metadata
    // endpoint says nothing about the account, and clears on its own.
    let attempts = 0
    let probed = false
    const rows = await collectUsage(accounts, deps({
      fetchWindows: async () => {
        attempts += 1
        if (attempts <= 2) throw new RateLimitError('throttled (HTTP 429)')
        return WINDOWS
      },
      probeWindows: async () => { probed = true; return WINDOWS },
    }))
    expect(probed).toBe(false)
    expect(rows[0]!.source).toBe('api')
    expect(rows[0]!.fiveHourPct).toBe(20)
  })

  test('reports a persistent throttle without spending a probe', async () => {
    let probed = false
    const rows = await collectUsage(accounts, deps({
      fetchWindows: async () => { throw new RateLimitError('throttled (HTTP 429)') },
      probeWindows: async () => { probed = true; return WINDOWS },
    }))
    expect(probed).toBe(false)
    expect(rows[0]!.error?.cause).toBe('rate-limited')
    expect(rows[0]!.fiveHourPct).toBeNull()
  })

  test('reports auth when the probe rejects the token', async () => {
    const rows = await collectUsage(accounts, deps({
      fetchWindows: async () => { throw new SchemaError('unrecognized') },
      probeWindows: async () => { throw new AuthError('token rejected (HTTP 401)') },
    }))
    expect(rows[0]!.error?.cause).toBe('auth')
  })

  test('does not tell the user to run doctor, since doctor prints this too', async () => {
    const rows = await collectUsage(accounts, deps({
      fetchWindows: async () => { throw new SchemaError('unrecognized') },
      probeWindows: async () => { throw new Error('no rate-limit headers') },
    }))
    expect(rows[0]!.error?.message).not.toMatch(/cuw doctor/)
    expect(rows[0]!.error?.message).toContain('no rate-limit headers')
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
