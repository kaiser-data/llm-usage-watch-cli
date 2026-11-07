import {
  CredentialError,
  isExpired,
  parseCredential,
  refreshCredential,
  serializeCredential,
} from './credentials'
import type { Keychain } from './keychain'
import { mergeLogin, type LoginStore } from './login'
import type { Credential } from './types'

export type TokenSourceDeps = {
  fetcher: typeof fetch
  now: () => number
  /**
   * The terminal's Claude Code login. When the credential being refreshed is
   * the one that login also holds, the rotated copy is written back into it —
   * otherwise refreshing here would sign the terminal out.
   */
  login?: LoginStore
  /** Re-imports the live login before a rejection is trusted. */
  resync?: () => Promise<void>
}

/**
 * Wraps a Keychain so `get(id)` returns a currently-valid *access token*
 * rather than the stored credential blob: it parses the credential, refreshes
 * it when expired, and persists the refreshed copy before returning.
 *
 * Shaped as a Keychain so every existing consumer (usage, prime, doctor) works
 * unchanged — they only ever needed "give me a usable token for this account".
 *
 * The endpoint rotates refresh tokens, which makes a spent one single-use and
 * makes a concurrent refresh actively destructive rather than merely wasteful:
 * two callers posting the same token leave one winner and one spurious
 * rejection, and the loser can then persist its stale copy over the winner's.
 * Both halves of that are handled below — collapsed in-process, re-read
 * across processes.
 */
export function createRefreshingTokenSource(
  keychain: Keychain,
  deps: TokenSourceDeps,
): Keychain {
  async function refreshAndStore(id: string, credential: Credential): Promise<string> {
    const refreshed = await refreshCredential(credential, {
      fetcher: deps.fetcher,
      now: deps.now(),
    })
    await keychain.set(id, serializeCredential(refreshed))
    await shareWithLogin(credential, refreshed)
    return refreshed.accessToken
  }

  /** Best effort: the refresh itself already succeeded and is stored. */
  async function shareWithLogin(spent: Credential, refreshed: Credential): Promise<void> {
    if (deps.login === undefined) return
    try {
      const live = await deps.login.read()
      if (live === null) return
      const branch = live.claudeAiOauth as { refreshToken?: unknown } | undefined
      if (branch?.refreshToken !== spent.refreshToken) return
      await deps.login.write(mergeLogin(live, refreshed))
    } catch {
      // A legacy credential or an unreadable login: nothing safe to write.
    }
  }

  /**
   * A rejection is only trustworthy if the credential we posted is still the
   * stored one. Another `cuw` process — or the Claude CLI, which shares the
   * login lineage — may have rotated it in the meantime, which spends our copy
   * without saying anything about the account.
   */
  async function retryIfRotated(
    id: string,
    posted: Credential,
    rejection: unknown,
  ): Promise<string> {
    if (!(rejection instanceof CredentialError) || rejection.cause !== 'refresh-rejected') {
      throw rejection
    }

    // Claude Code may have renewed this account's login itself; pull that in.
    if (deps.resync !== undefined) {
      try {
        await deps.resync()
      } catch {
        // Resync is an optimisation; the stored-copy check below still applies.
      }
    }

    const stored = await keychain.get(id)
    if (stored === null) throw rejection

    const latest = parseCredential(stored)
    // Unchanged: nothing rotated, so the token really is dead.
    if (latest.refreshToken === posted.refreshToken) throw rejection
    // The winner already persisted a usable access token — take it as-is.
    if (!isExpired(latest, deps.now())) return latest.accessToken
    return await refreshAndStore(id, latest)
  }

  async function resolve(id: string): Promise<string | null> {
    const stored = await keychain.get(id)
    if (stored === null) return null

    const credential = parseCredential(stored)
    if (!isExpired(credential, deps.now())) return credential.accessToken

    try {
      return await refreshAndStore(id, credential)
    } catch (error) {
      return await retryIfRotated(id, credential, error)
    }
  }

  // Collapses concurrent reads of one account onto a single refresh. Keyed per
  // id so a batch across accounts still runs in parallel, and cleared on settle
  // so a later call in the same process re-reads rather than serving a stale
  // token. Cross-process overlap is what `retryIfRotated` is for.
  const inFlight = new Map<string, Promise<string | null>>()

  return {
    async get(id) {
      const existing = inFlight.get(id)
      if (existing !== undefined) return await existing

      const pending = resolve(id)
      inFlight.set(id, pending)
      try {
        return await pending
      } finally {
        inFlight.delete(id)
      }
    },

    set: keychain.set,
    remove: keychain.remove,
  }
}
