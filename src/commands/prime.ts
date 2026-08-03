import { classify } from '../classify'
import { formatDuration } from '../render'
import type { Account } from '../types'
import { collectUsage, type UsageDeps } from '../usage'
import { primeAccount, type PrimeDeps, type PrimeResult } from '../prime'
import type { Io } from './status'

export type PrimeCommandDeps = {
  accounts: Account[]
  usage: UsageDeps
  prime: PrimeDeps
  now: Date
}

async function resolveTargets(
  args: { ids: string[]; cold: boolean },
  deps: PrimeCommandDeps,
  io: Io,
): Promise<Account[] | null> {
  if (args.cold) {
    const rows = await collectUsage(deps.accounts, deps.usage)
    const coldIds = new Set(rows.filter(row => classify(row) === 'cold').map(row => row.id))
    return deps.accounts.filter(account => coldIds.has(account.id))
  }

  const targets: Account[] = []
  for (const id of args.ids) {
    const account = deps.accounts.find(candidate => candidate.id === id)
    if (!account) {
      io.err(`"${id}" is not configured`)
      return null
    }
    targets.push(account)
  }
  return targets
}

function report(result: PrimeResult, now: Date, io: Io): void {
  if (!result.ok) {
    io.err(`✗ ${result.id}: ${result.detail}`)
    return
  }
  const countdown = result.resetsAt === null
    ? 'unknown'
    : formatDuration(result.resetsAt.getTime() - now.getTime())
  io.out(`✓ ${result.id}: window started, resets in ${countdown}`)
}

export async function runPrime(
  args: { ids: string[]; cold: boolean },
  deps: PrimeCommandDeps,
  io: Io,
): Promise<number> {
  if (deps.accounts.length === 0) {
    io.out('No subscriptions configured yet.\nAdd one with: cuw add <id>')
    return 0
  }

  const targets = await resolveTargets(args, deps, io)
  if (targets === null) return 1

  if (targets.length === 0) {
    io.out(args.cold ? 'every account already has an open window' : 'nothing to prime')
    return 0
  }

  const results = await Promise.all(targets.map(async account => {
    const token = await deps.usage.keychain.get(account.id)
    if (token === null) {
      return {
        id: account.id, ok: false, resetsAt: null, exitCode: 0,
        detail: `no token stored — run \`cuw add ${account.id}\``,
      } satisfies PrimeResult
    }
    return primeAccount(account, token, deps.prime)
  }))

  for (const result of results) report(result, deps.now, io)
  return results.every(result => result.ok) ? 0 : 2
}
