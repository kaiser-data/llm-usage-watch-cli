import { describe, expect, test } from 'bun:test'
import {
  CredentialError,
  isExpired,
  isLegacyCredential,
  parseCredential,
  refreshCredential,
  serializeCredential,
} from '../src/credentials'
import { REQUIRED_SCOPE } from '../src/constants'
import type { Credential } from '../src/types'

const NOW = new Date('2026-08-03T12:00:00Z').getTime()

const FULL: Credential = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresAt: NOW + 3_600_000,
  scopes: ['user:inference', REQUIRED_SCOPE],
  raw: {},
}

/** The shape `claude auth login` writes to the Keychain. */
function loginBlob(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: NOW + 3_600_000,
      scopes: ['user:inference', REQUIRED_SCOPE],
      subscriptionType: 'max',
      ...overrides,
    },
  })
}

describe('parseCredential', () => {
  test('reads the login blob shape', () => {
    const credential = parseCredential(loginBlob())
    expect(credential.accessToken).toBe('access-1')
    expect(credential.refreshToken).toBe('refresh-1')
    expect(credential.scopes).toContain(REQUIRED_SCOPE)
  })

  test('reads a bare credential object, as cuw stores it', () => {
    const credential = parseCredential(serializeCredential(FULL))
    expect(credential).toEqual(FULL)
  })

  test('round-trips through serialize', () => {
    expect(parseCredential(serializeCredential(FULL))).toEqual(FULL)
  })

  test('rejects an inference-only token with an actionable message', () => {
    const blob = loginBlob({ scopes: ['user:inference'] })
    expect(() => parseCredential(blob)).toThrow(/inference-only|user:profile/i)
  })

  test('rejects a credential with no refresh token', () => {
    expect(() => parseCredential(loginBlob({ refreshToken: undefined })))
      .toThrow(CredentialError)
  })

  test('rejects malformed JSON', () => {
    expect(() => parseCredential('{ not json')).toThrow(CredentialError)
  })

  test('rejects a setup-token pasted as a bare string', () => {
    expect(() => parseCredential('sk-ant-oat01-example')).toThrow(/inference-only|not a login credential/i)
  })

  test('captures the login branch verbatim, including unmodelled fields', () => {
    const credential = parseCredential(loginBlob({ rateLimitTier: 'default_claude_ai' }))
    expect(credential.raw.subscriptionType).toBe('max')
    expect(credential.raw.rateLimitTier).toBe('default_claude_ai')
  })

  test("round-trips the passthrough through cuw's own stored form", () => {
    const stored = serializeCredential(parseCredential(loginBlob()))
    expect(parseCredential(stored).raw.subscriptionType).toBe('max')
  })

  test('reports a credential stored before the passthrough as legacy', () => {
    const old = JSON.stringify({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: NOW + 3_600_000,
      scopes: [REQUIRED_SCOPE],
    })
    expect(isLegacyCredential(parseCredential(old))).toBe(true)
    expect(isLegacyCredential(parseCredential(loginBlob()))).toBe(false)
  })

  test('error messages never contain the token', () => {
    let message = ''
    try {
      parseCredential(loginBlob({ scopes: ['user:inference'] }))
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).not.toContain('access-1')
    expect(message).not.toContain('refresh-1')
  })
})

describe('isExpired', () => {
  test('is false well before expiry', () => {
    expect(isExpired(FULL, NOW)).toBe(false)
  })

  test('is true after expiry', () => {
    expect(isExpired({ ...FULL, expiresAt: NOW - 1 }, NOW)).toBe(true)
  })

  test('is true inside the refresh skew window', () => {
    expect(isExpired({ ...FULL, expiresAt: NOW + 60_000 }, NOW)).toBe(true)
  })
})

describe('refreshCredential', () => {
  function fetcherReturning(body: unknown, status = 200): typeof fetch {
    return (async () => new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
  }

  test('exchanges the refresh token for a new access token', async () => {
    const fetcher = fetcherReturning({
      access_token: 'access-2',
      refresh_token: 'refresh-2',
      expires_in: 28_800,
      scope: `user:inference ${REQUIRED_SCOPE}`,
    })
    const refreshed = await refreshCredential(FULL, { fetcher, now: NOW })
    expect(refreshed.accessToken).toBe('access-2')
    expect(refreshed.refreshToken).toBe('refresh-2')
    expect(refreshed.expiresAt).toBe(NOW + 28_800_000)
  })

  test('projects refreshed values into the passthrough', async () => {
    const fetcher = fetcherReturning({
      access_token: 'access-2',
      refresh_token: 'refresh-2',
      expires_in: 3600,
    })
    const refreshed = await refreshCredential(parseCredential(loginBlob()), { fetcher, now: NOW })
    expect(refreshed.raw.accessToken).toBe('access-2')
    expect(refreshed.raw.refreshToken).toBe('refresh-2')
    expect(refreshed.raw.expiresAt).toBe(NOW + 3_600_000)
    // Untouched fields survive the refresh.
    expect(refreshed.raw.subscriptionType).toBe('max')
  })

  test('does not give a legacy credential a passthrough', async () => {
    const fetcher = fetcherReturning({ access_token: 'access-2', expires_in: 3600 })
    const refreshed = await refreshCredential(FULL, { fetcher, now: NOW })
    expect(isLegacyCredential(refreshed)).toBe(true)
  })

  test('keeps the old refresh token when the response omits one', async () => {
    const fetcher = fetcherReturning({ access_token: 'access-2', expires_in: 3600 })
    const refreshed = await refreshCredential(FULL, { fetcher, now: NOW })
    expect(refreshed.refreshToken).toBe('refresh-1')
  })

  test('posts a form-encoded refresh_token grant', async () => {
    let seenBody = ''
    const fetcher = (async (_url: string, init?: RequestInit) => {
      seenBody = String(init?.body ?? '')
      return new Response(JSON.stringify({ access_token: 'a', expires_in: 60 }), { status: 200 })
    }) as unknown as typeof fetch
    await refreshCredential(FULL, { fetcher, now: NOW })
    expect(seenBody).toContain('grant_type=refresh_token')
    expect(seenBody).toContain('client_id=')
  })

  test('throws an actionable error when the refresh token is rejected', async () => {
    const fetcher = fetcherReturning({ error: 'invalid_grant' }, 400)
    expect(refreshCredential(FULL, { fetcher, now: NOW })).rejects.toThrow(/re-add|expired/i)
  })

  test('refresh failure never leaks a token', async () => {
    const fetcher = fetcherReturning({ error: 'invalid_grant refresh-1' }, 400)
    let message = ''
    try {
      await refreshCredential(FULL, { fetcher, now: NOW })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).not.toContain('refresh-1')
  })
})
