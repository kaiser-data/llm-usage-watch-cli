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
    expect(source.get('main')).rejects.toThrow(/cuw login/i)
  })

  // The endpoint rotates refresh tokens, so a spent one is single-use. Two
  // callers that each read the same stored credential and each POST it leave
  // one winner and one spurious "expired" — with the loser able to overwrite
  // the winner's freshly rotated token on its way out.
  test('refreshes once when several callers race for the same account', async () => {
    const keychain = fakeKeychain({ main: serializeCredential(STALE) })
    let refreshes = 0
    const counting = (async () => {
      refreshes += 1
      return new Response(JSON.stringify({
        access_token: 'access-renewed',
        refresh_token: 'refresh-2',
        expires_in: 28_800,
      }), { status: 200 })
    }) as unknown as typeof fetch
    const source = createRefreshingTokenSource(keychain, { fetcher: counting, now: () => NOW })

    const tokens = await Promise.all([source.get('main'), source.get('main'), source.get('main')])
    expect(refreshes).toBe(1)
    expect(tokens).toEqual(['access-renewed', 'access-renewed', 'access-renewed'])
  })

  test('does not conflate separate accounts in the same batch', async () => {
    const keychain = fakeKeychain({
      main: serializeCredential(STALE),
      other: serializeCredential({ ...STALE, refreshToken: 'refresh-other' }),
    })
    let refreshes = 0
    const counting = (async () => {
      refreshes += 1
      return new Response(JSON.stringify({ access_token: 'access-renewed', expires_in: 60 }), { status: 200 })
    }) as unknown as typeof fetch
    const source = createRefreshingTokenSource(keychain, { fetcher: counting, now: () => NOW })

    await Promise.all([source.get('main'), source.get('other')])
    expect(refreshes).toBe(2)
  })

  // Another process (a second `cuw`, or the Claude CLI itself) can rotate the
  // token between our read and our POST. Ours is then already spent, and the
  // rejection says nothing about whether the account is still usable.
  test('re-reads after a rejection in case another process rotated the token', async () => {
    const keychain = fakeKeychain({ main: serializeCredential(STALE) })
    const failing = (async () => {
      // Simulate the winner persisting its rotated credential mid-flight.
      await keychain.set('main', serializeCredential({
        ...STALE,
        accessToken: 'access-by-other-process',
        refreshToken: 'refresh-rotated',
        expiresAt: NOW + 3_600_000,
      }))
      return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
    }) as unknown as typeof fetch
    const source = createRefreshingTokenSource(keychain, { fetcher: failing, now: () => NOW })

    expect(await source.get('main')).toBe('access-by-other-process')
  })

  test('still reports a genuinely dead token when nothing rotated', async () => {
    const keychain = fakeKeychain({ main: serializeCredential(STALE) })
    let attempts = 0
    const failing = (async () => {
      attempts += 1
      return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
    }) as unknown as typeof fetch
    const source = createRefreshingTokenSource(keychain, { fetcher: failing, now: () => NOW })

    expect(source.get('main')).rejects.toThrow(/cuw login/i)
    // The stored token never changed, so there is nothing to retry with.
    expect(attempts).toBeLessThanOrEqual(1)
  })
})

describe('createRefreshingTokenSource and the live login', () => {
  const SHARED: Credential = { ...STALE, raw: { accessToken: 'access-stale', refreshToken: 'refresh-1', subscriptionType: 'pro' } }

  function fakeLogin(blob: Record<string, unknown> | null) {
    const writes: Record<string, unknown>[] = []
    return {
      writes,
      store: {
        read: async () => blob,
        write: async (next: Record<string, unknown>) => { writes.push(next) },
      },
    }
  }

  test('writes the rotated token back when Claude Code holds the same login', async () => {
    const keychain = fakeKeychain({ main: serializeCredential(SHARED) })
    const login = fakeLogin({ claudeAiOauth: SHARED.raw, mcpOAuth: { keep: true } })
    const source = createRefreshingTokenSource(keychain, { fetcher: okFetcher, now: () => NOW, login: login.store })

    expect(await source.get('main')).toBe('access-renewed')
    expect(login.writes).toHaveLength(1)
    const written = login.writes[0] as { claudeAiOauth: Record<string, unknown>; mcpOAuth: unknown }
    expect(written.claudeAiOauth.refreshToken).toBe('refresh-2')
    expect(written.claudeAiOauth.subscriptionType).toBe('pro')
    expect(written.mcpOAuth).toEqual({ keep: true })
  })

  test('leaves a live login for another account alone', async () => {
    const keychain = fakeKeychain({ main: serializeCredential(SHARED) })
    const login = fakeLogin({ claudeAiOauth: { ...SHARED.raw, refreshToken: 'someone-else' } })
    const source = createRefreshingTokenSource(keychain, { fetcher: okFetcher, now: () => NOW, login: login.store })

    await source.get('main')
    expect(login.writes).toEqual([])
  })

  test('re-imports the live login before trusting a rejection', async () => {
    const keychain = fakeKeychain({ main: serializeCredential(STALE) })
    const failing = (async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })) as unknown as typeof fetch
    const source = createRefreshingTokenSource(keychain, {
      fetcher: failing,
      now: () => NOW,
      // Claude Code renewed this account; the sync drops its fresh copy in.
      resync: async () => { keychain.store.set('main', serializeCredential({ ...FRESH, refreshToken: 'refresh-live', accessToken: 'access-live' })) },
    })

    expect(await source.get('main')).toBe('access-live')
  })
})
