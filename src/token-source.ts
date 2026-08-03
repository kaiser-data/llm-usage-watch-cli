import { isExpired, parseCredential, refreshCredential, serializeCredential } from './credentials'
import type { Keychain } from './keychain'

export type TokenSourceDeps = {
  fetcher: typeof fetch
  now: () => number
}

/**
 * Wraps a Keychain so `get(id)` returns a currently-valid *access token*
 * rather than the stored credential blob: it parses the credential, refreshes
 * it when expired, and persists the refreshed copy before returning.
 *
 * Shaped as a Keychain so every existing consumer (usage, prime, doctor) works
 * unchanged — they only ever needed "give me a usable token for this account".
 */
export function createRefreshingTokenSource(
  keychain: Keychain,
  deps: TokenSourceDeps,
): Keychain {
  return {
    async get(id) {
      const stored = await keychain.get(id)
      if (stored === null) return null

      const credential = parseCredential(stored)
      if (!isExpired(credential, deps.now())) return credential.accessToken

      const refreshed = await refreshCredential(credential, {
        fetcher: deps.fetcher,
        now: deps.now(),
      })
      await keychain.set(id, serializeCredential(refreshed))
      return refreshed.accessToken
    },

    set: keychain.set,
    remove: keychain.remove,
  }
}
