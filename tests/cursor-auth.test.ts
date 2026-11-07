import { describe, expect, test } from 'bun:test'
import {
  CursorAuthError,
  readCursorAuth,
  type CursorAuthStore,
} from '../src/cursor-auth'

function store(overrides: Partial<CursorAuthStore> = {}): CursorAuthStore {
  return {
    resolveDbPath: () => '/tmp/fake-state.vscdb',
    readValues: async () => ({
      'cursorAuth/accessToken': 'access-token',
      'cursorAuth/refreshToken': 'refresh-token',
      'cursorAuth/stripeMembershipType': 'pro',
    }),
    ...overrides,
  }
}

describe('readCursorAuth', () => {
  test('returns tokens and plan from the local Cursor state DB', async () => {
    const auth = await readCursorAuth(store())
    expect(auth).toEqual({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      plan: 'pro',
    })
  })

  test('reports not-installed when the state DB is missing', async () => {
    await expect(readCursorAuth(store({
      resolveDbPath: () => null,
    }))).rejects.toBeInstanceOf(CursorAuthError)
    try {
      await readCursorAuth(store({ resolveDbPath: () => null }))
    } catch (error) {
      expect((error as CursorAuthError).authCause).toBe('not-installed')
    }
  })

  test('reports not-logged-in when the access token is absent', async () => {
    const missing = store({
      readValues: async () => ({
        'cursorAuth/accessToken': null,
        'cursorAuth/refreshToken': null,
        'cursorAuth/stripeMembershipType': null,
      }),
    })
    await expect(readCursorAuth(missing)).rejects.toBeInstanceOf(CursorAuthError)
    try {
      await readCursorAuth(missing)
    } catch (error) {
      expect((error as CursorAuthError).authCause).toBe('not-logged-in')
    }
  })

  test('allows a missing refresh token and plan', async () => {
    const auth = await readCursorAuth(store({
      readValues: async () => ({
        'cursorAuth/accessToken': 'access-token',
        'cursorAuth/refreshToken': null,
        'cursorAuth/stripeMembershipType': null,
      }),
    }))
    expect(auth.refreshToken).toBeNull()
    expect(auth.plan).toBeNull()
  })
})
