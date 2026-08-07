import { reAddHint } from './hints'
import type { Keychain } from './keychain'
import type { Account, AccountUsage, Subscription, UsageError, UsageWindows } from './types'
import { AuthError } from './usage-api'

export type UsageDeps = {
  keychain: Keychain
  fetchWindows: (token: string) => Promise<UsageWindows>
  probeWindows: (token: string) => Promise<UsageWindows>
  /** Optional decoration; never fails a row. Defaults to no subscription info. */
  fetchSubscription?: (token: string) => Promise<Subscription | null>
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

async function collectOne(account: Account, deps: UsageDeps): Promise<AccountUsage> {
  const token = await deps.keychain.get(account.id)
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
      deps.fetchWindows(token),
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
  } catch {
    return failed(account, {
      cause: 'probe-failed',
      message: 'both the usage API and the probe failed — run `cuw doctor`',
    })
  }
}

export async function collectUsage(accounts: Account[], deps: UsageDeps): Promise<AccountUsage[]> {
  return Promise.all(accounts.map(account => collectOne(account, deps)))
}
