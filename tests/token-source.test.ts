import { describe, expect, test } from 'bun:test'
import { createRefreshingTokenSource } from '../src/token-source'
import { serializeCredential } from '../src/credentials'
import { REQUIRED_SCOPE } from '../src/constants'
import type { Keychain } from '../src/keychain'
import type { Credential } from '../src/types'

const NOW = new Date('2026-08-03T12:00:00Z').getTime()

const FRESH: Credential = {
  accessToken: 'access-fresh',
  refreshToken: 'refresh-1',
  expiresAt: NOW + 3_600_000,
  scopes: ['user:inference', REQUIRED_SCOPE],
  raw: {},
}

const STALE: Credential = { ...FRESH, accessToken: 'access-stale', expiresAt: NOW - 1 }

function fakeKeychain(initial: Record<string, string> = {}): Keychain & { store: Map<string, string> } {
  const store = new Map(Object.entries(initial))
  return {
    store,
    get: async id => store.get(id) ?? null,
    set: async (id, value) => { store.set(id, value) },
    remove: async id => { store.delete(id) },
  }
}

const okFetcher = (async () => new Response(JSON.stringify({
  access_token: 'access-renewed',
  refresh_token: 'refresh-2',
  expires_in: 28_800,
}), { status: 200 })) as unknown as typeof fetch

describe('createRefreshingTokenSource', () => {
  test('returns the stored access token when it is still valid', async () => {
    const keychain = fakeKeychain({ main: serializeCredential(FRESH) })
    let fetched = false
    const source = createRefreshingTokenSource(keychain, {
      fetcher: (async () => { fetched = true; return new Response('{}') }) as unknown as typeof fetch,
      now: () => NOW,
    })
    expect(await source.get('main')).toBe('access-fresh')
    expect(fetched).toBe(false)
  })

  test('returns null for an account with nothing stored', async () => {
    const source = createRefreshingTokenSource(fakeKeychain(), { fetcher: okFetcher, now: () => NOW })
    expect(await source.get('missing')).toBeNull()
  })

  test('refreshes an expired credential and returns the new token', async () => {
    const keychain = fakeKeychain({ main: serializeCredential(STALE) })
    const source = createRefreshingTokenSource(keychain, { fetcher: okFetcher, now: () => NOW })
    expect(await source.get('main')).toBe('access-renewed')
  })

  test('persists the refreshed credential so the next call is cheap', async () => {
    const keychain = fakeKeychain({ main: serializeCredential(STALE) })
    const source = createRefreshingTokenSource(keychain, { fetcher: okFetcher, now: () => NOW })
    await source.get('main')
    const stored = JSON.parse(keychain.store.get('main') as string)
    expect(stored.accessToken).toBe('access-renewed')
    expect(stored.refreshToken).toBe('refresh-2')
    expect(stored.expiresAt).toBe(NOW + 28_800_000)
  })

  test('propagates an inference-only credential as an actionable error', async () => {
    const keychain = fakeKeychain({ main: JSON.stringify({ ...FRESH, scopes: ['user:inference'] }) })
    const source = createRefreshingTokenSource(keychain, { fetcher: okFetcher, now: () => NOW })
    expect(source.get('main')).rejects.toThrow(/inference-only|user:profile/i)
  })

  test('propagates a rejected refresh token', async () => {
    const keychain = fakeKeychain({ main: serializeCredential(STALE) })
    const failing = (async () => new Response('{}', { status: 400 })) as unknown as typeof fetch
    const source = createRefreshingTokenSource(keychain, { fetcher: failing, now: () => NOW })
    expect(source.get('main')).rejects.toThrow(/re-add/i)
  })
})
