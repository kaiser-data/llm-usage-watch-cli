import type { IsolatedLogin } from '../claude-login'
import { parseCredential } from '../credentials'
import type { Keychain } from '../keychain'
import type { Identity } from '../profile'
import { loadRegistry } from '../registry'
import type { Account } from '../types'
import { recordAccount } from './add'
import type { Io } from './status'

export type LoginDeps = {
  registryFile: string
  keychain: Keychain
  /** Runs one browser sign-in in a throwaway profile; null when it did not finish. */
  signIn: IsolatedLogin
  fetchIdentity: (token: string) => Promise<Identity | null>
  /** True when the stored credential is missing or can no longer be refreshed. */
  needsLogin: (id: string) => Promise<boolean>
}

type Outcome = { ok: true } | { ok: false; reason: string }

async function loginOne(id: string, accounts: Account[], deps: LoginDeps, io: Io): Promise<Outcome> {
  const existing = accounts.find(account => account.id === id)
  io.out('')
  io.out(existing === undefined
    ? `→ ${id}: sign in with the subscription to add`
    : `→ ${id}: sign in as ${existing.email}`)
  io.out('  (a browser signed into another claude.ai account authorizes that one — switch it first)')

  const blob = await deps.signIn(existing?.email)
  if (blob === null) return { ok: false, reason: 'sign-in did not complete' }

  let credential
  try {
    credential = parseCredential(blob)
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  }

  const identity = await deps.fetchIdentity(credential.accessToken)
  if (identity === null) {
    return { ok: false, reason: 'cannot read the account profile — check your connection and retry' }
  }

  // The usual mistake with several subscriptions: the browser was still signed
  // into a different one. Storing that would silently relabel the row.
  if (existing?.uuid !== undefined && existing.uuid !== identity.uuid) {
    return {
      ok: false,
      reason: `signed in as ${identity.email}, but "${id}" is ${existing.email} — ` +
        `switch claude.ai to ${existing.email} in the browser and retry`,
    }
  }
  if (existing === undefined) {
    const twin = accounts.find(account => account.uuid === identity.uuid)
    if (twin !== undefined) {
      return {
        ok: false,
        reason: `${identity.email} is already configured as "${twin.id}" — run \`cuw login ${twin.id}\``,
      }
    }
  }

  const saved = await recordAccount(id, credential, identity, deps)
  if (saved !== 'created' && saved !== 'updated') return { ok: false, reason: saved.error }

  io.out(`✓ ${id} (${identity.email}) ${saved === 'created' ? 'added' : 'signed in'}`)
  return { ok: true }
}

/**
 * Signs accounts back in, one browser round-trip each, without touching the
 * terminal's own Claude Code login. With explicit ids it signs in exactly
 * those (adding any that are new); with none it finds every account whose
 * stored credential is dead and works through them in order.
 */
export async function runLogin(ids: string[], deps: LoginDeps, io: Io): Promise<number> {
  const accounts = await loadRegistry(deps.registryFile)

  let targets = ids
  if (targets.length === 0) {
    if (accounts.length === 0) {
      io.err('no accounts configured — run `cuw login <id>` to add one')
      return 1
    }
    const checks = await Promise.all(accounts.map(async account => ({
      id: account.id,
      dead: await deps.needsLogin(account.id),
    })))
    targets = checks.filter(check => check.dead).map(check => check.id)
    if (targets.length === 0) {
      io.out(`all ${accounts.length} accounts are signed in — nothing to do`)
      return 0
    }
    io.out(`${targets.length} of ${accounts.length} accounts need a fresh sign-in: ${targets.join(', ')}`)
  }

  const failed: string[] = []
  for (const id of targets) {
    // Re-read each time so an account added earlier in this run counts as a twin.
    const current = await loadRegistry(deps.registryFile)
    const outcome = await loginOne(id, current, deps, io)
    if (!outcome.ok) {
      io.err(`✗ ${id}: ${outcome.reason} — nothing was stored`)
      failed.push(id)
    }
  }

  io.out('')
  if (failed.length === 0) {
    io.out('done — run `cuw` to see usage')
    return 0
  }
  io.err(`${failed.length} not signed in: ${failed.join(', ')} — retry with \`cuw login ${failed.join(' ')}\``)
  return 2
}
