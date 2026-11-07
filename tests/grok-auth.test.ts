import { describe, expect, test } from 'bun:test'
import {
  GrokAuthError,
  pickGrokAuthEntry,
  readGrokAuth,
  type GrokAuthStore,
} from '../src/grok-auth'

const ENTRY = {
  key: 'access-token',
  refresh_token: 'refresh-token',
  oidc_client_id: 'client-id',
  expires_at: '2099-01-01T00:00:00Z',
}

function store(overrides: Partial<GrokAuthStore> = {}): GrokAuthStore {
  return {
    resolveAuthPath: () => '/tmp/fake-grok-auth.json',
    readFile: async () => JSON.stringify({
      'https://auth.x.ai::client-id': ENTRY,
    }),
    ...overrides,
  }
}

describe('pickGrokAuthEntry', () => {
  test('reads access/refresh tokens and client id', () => {
    expect(pickGrokAuthEntry({
      'https://auth.x.ai::client-id': ENTRY,
    })).toEqual({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      clientId: 'client-id',
      expiresAt: new Date('2099-01-01T00:00:00Z'),
    })
  })

  test('prefers a non-expired entry when several are present', () => {
    const auth = pickGrokAuthEntry({
      expired: {
        key: 'old-token',
        refresh_token: 'old-refresh',
        oidc_client_id: 'old-client',
        expires_at: '2000-01-01T00:00:00Z',
      },
      live: {
        key: 'live-token',
        refresh_token: 'live-refresh',
        oidc_client_id: 'live-client',
        expires_at: '2099-01-01T00:00:00Z',
      },
    })
    expect(auth.accessToken).toBe('live-token')
    expect(auth.clientId).toBe('live-client')
  })

  test('reports not-logged-in when no usable key exists', () => {
    expect(() => pickGrokAuthEntry({ empty: { refresh_token: 'x' } }))
      .toThrow(GrokAuthError)
  })
})

describe('readGrokAuth', () => {
  test('returns tokens from the local Grok auth file', async () => {
    const auth = await readGrokAuth(store())
    expect(auth).toEqual({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      clientId: 'client-id',
      expiresAt: new Date('2099-01-01T00:00:00Z'),
    })
  })

  test('reports not-installed when the auth file is missing', async () => {
    try {
      await readGrokAuth(store({ resolveAuthPath: () => null }))
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(GrokAuthError)
      expect((error as GrokAuthError).authCause).toBe('not-installed')
    }
  })

  test('reports not-logged-in when the file has no access token', async () => {
    try {
      await readGrokAuth(store({
        readFile: async () => JSON.stringify({ empty: {} }),
      }))
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(GrokAuthError)
      expect((error as GrokAuthError).authCause).toBe('not-logged-in')
    }
  })

  test('reports schema when the file is not JSON', async () => {
    try {
      await readGrokAuth(store({ readFile: async () => 'not-json' }))
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(GrokAuthError)
      expect((error as GrokAuthError).authCause).toBe('schema')
    }
  })
})
