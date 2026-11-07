import { USAGE_RETRY_ATTEMPTS, USAGE_RETRY_DELAY_MS } from './constants'
import { CredentialError } from './credentials'
import { RE_ADD_HINT, reAddHint } from './hints'
import type { Keychain } from './keychain'
import type { Account, AccountUsage, Subscription, UsageError, UsageWindows } from './types'
import { AuthError, RateLimitError } from './usage-api'

export type UsageDeps = {
  keychain: Keychain
  fetchWindows: (token: string) => Promise<UsageWindows>
  probeWindows: (token: string) => Promise<UsageWindows>
  /** Optional decoration; never fails a row. Defaults to no subscription info. */
  fetchSubscription?: (token: string) => Promise<Subscription | null>
  /** Injected so the retry backoff costs no wall-clock in tests. */
  sleep?: (ms: number) => Promise<void>
}

const EMPTY_WINDOWS: UsageWindows = {
  fiveHourPct: null,
  fiveHourResetsAt: null,
  weeklyPct: null,
  weeklyResetsAt: null,
  opusWeeklyPct: null,
}

function failed(account: Account, error: UsageError): AccountUsage {
  return {
    ...EMPTY_WINDOWS,
    id: account.id,
    label: account.label,
    subscription: null,
    source: 'none',
    error,
  }
}

/** A stored token, which may legitimately be absent, or the reason there is none. */
type TokenResult = { token: string | null } | { error: UsageError }

/** Safe for display: an error cuw raised itself, never a raw response body. */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

/**
 * A throttled read is retried in place rather than escalated. The usage
 * endpoint limits reads independently of the account's own budget, so a 429
 * here is a fact about the request, not about the subscription.
 */
async function fetchWithRetry(token: string, deps: UsageDeps): Promise<UsageWindows> {
  const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await deps.fetchWindows(token)
    } catch (error) {
      if (!(error instanceof RateLimitError) || attempt >= USAGE_RETRY_ATTEMPTS) throw error
      await sleep(USAGE_RETRY_DELAY_MS * attempt)
    }
  }
}

/**
 * Obtaining the token is itself fallible: the keychain hands back a stored
 * credential, and turning that into a usable access token can need a refresh
 * that the endpoint rejects. Left to throw, it rejected `collectUsage`'s
 * `Promise.all` and took every other account's row down with it — including
 * under `cuw doctor`, whose whole job is to report this.
 *
 * Every failure here lands on 'auth': whatever the cause, cuw could not get a
 * usable token, and that is the state the caller acts on (`cuw status` exits
 * EXIT_AUTH on it).
 */
async function tokenFor(account: Account, deps: UsageDeps): Promise<TokenResult> {
  try {
    return { token: await deps.keychain.get(account.id) }
  } catch (error) {
    if (error instanceof CredentialError) {
      return {
        error: {
          cause: 'auth',
          // The message is already display-safe — credentials.ts discards response
          // bodies precisely so it can be shown. It carries the generic hint, so
          // re-point it at the account the user actually has to repair.
          message: error.message.replace(RE_ADD_HINT, reAddHint(account.id)),
        },
      }
    }
    return {
      error: { cause: 'auth', message: `could not read the stored token — ${reason(error)}` },
    }
  }
}

async function collectOne(account: Account, deps: UsageDeps): Promise<AccountUsage> {
  const result = await tokenFor(account, deps)
  if ('error' in result) return failed(account, result.error)

  const token = result.token
  if (token === null) {
    return failed(account, {
      cause: 'no-token',
      message: `no token stored — run \`${reAddHint(account.id)}\``,
    })
  }

  // Plan info rides along with the usage call rather than after it.
  const subscriptionPromise = deps.fetchSubscription?.(token) ?? Promise.resolve(null)

  try {
    const [windows, subscription] = await Promise.all([
      fetchWithRetry(token, deps),
      subscriptionPromise,
    ])
    return {
      ...windows,
      id: account.id,
      label: account.label,
      subscription,
      source: 'api',
      error: null,
    }
  } catch (error) {
    // A rejected token will be rejected by the probe too — do not spend a
    // request, and do not hide an expired credential behind a slower path.
    if (error instanceof AuthError) {
      return failed(account, {
        cause: 'auth',
        message: `token rejected — re-mint with \`${reAddHint(account.id)}\``,
      })
    }
    // Likewise for a throttle that outlasted its retries: the probe would spend
    // real quota and open a window to report what the API will supply shortly.
    if (error instanceof RateLimitError) {
      return failed(account, {
        cause: 'rate-limited',
        message: 'usage reads are being throttled — try again in a moment',
      })
    }
  }

  try {
    const windows = await deps.probeWindows(token)
    return {
      ...windows,
      id: account.id,
      label: account.label,
      subscription: await subscriptionPromise,
      source: 'probe',
      error: null,
    }
  } catch (error) {
    if (error instanceof AuthError) {
      return failed(account, {
        cause: 'auth',
        message: `token rejected — re-mint with \`${reAddHint(account.id)}\``,
      })
    }
    // Naming `cuw doctor` here sent doctor's own output into a loop: it printed
    // this message, which told the user to run the command they had just run.
    // The underlying reason is the useful part, and is already display-safe.
    return failed(account, {
      cause: 'probe-failed',
      message: `usage API and probe both failed — ${reason(error)}`,
    })
  }
}

export async function collectUsage(accounts: Account[], deps: UsageDeps): Promise<AccountUsage[]> {
  return Promise.all(accounts.map(account => collectOne(account, deps)))
}
