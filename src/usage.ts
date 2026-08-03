import type { Keychain } from './keychain'
import type { Account, AccountUsage, UsageError, UsageWindows } from './types'
import { AuthError } from './usage-api'

export type UsageDeps = {
  keychain: Keychain
  fetchWindows: (token: string) => Promise<UsageWindows>
  probeWindows: (token: string) => Promise<UsageWindows>
}

const EMPTY_WINDOWS: UsageWindows = {
  fiveHourPct: null,
  fiveHourResetsAt: null,
  weeklyPct: null,
  weeklyResetsAt: null,
  opusWeeklyPct: null,
}

function failed(account: Account, error: UsageError): AccountUsage {
  return { ...EMPTY_WINDOWS, id: account.id, label: account.label, source: 'none', error }
}

async function collectOne(account: Account, deps: UsageDeps): Promise<AccountUsage> {
  const token = await deps.keychain.get(account.id)
  if (token === null) {
    return failed(account, {
      cause: 'no-token',
      message: `no token stored — run \`cuw add ${account.id}\``,
    })
  }

  try {
    const windows = await deps.fetchWindows(token)
    return { ...windows, id: account.id, label: account.label, source: 'api', error: null }
  } catch (error) {
    // A rejected token will be rejected by the probe too — do not spend a
    // request, and do not hide an expired credential behind a slower path.
    if (error instanceof AuthError) {
      return failed(account, {
        cause: 'auth',
        message: `token rejected — re-mint with \`cuw add ${account.id}\``,
      })
    }
  }

  try {
    const windows = await deps.probeWindows(token)
    return { ...windows, id: account.id, label: account.label, source: 'probe', error: null }
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
