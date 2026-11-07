import { CredentialError, isExpired, parseCredential, serializeCredential } from './credentials'
import type { Keychain } from './keychain'
import type { LoginStore } from './login'
import type { Identity } from './profile'
import { loadRegistry, saveRegistry } from './registry'

const ID_MAX = 32

/** An id derived from an email local part, kept within the registry's pattern. */
export function deriveId(email: string, taken: Set<string>): string {
  const base = (email.split('@')[0] ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, ID_MAX)
  const seed = base === '' ? 'account' : base
  if (!taken.has(seed)) return seed
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${seed.slice(0, ID_MAX - 3)}-${suffix}`
    if (!taken.has(candidate)) return candidate
  }
}

export type SyncDeps = {
  registryFile: string
  /** The raw credential store. */
  keychain: Keychain
  login: LoginStore
  fetchIdentity: (token: string) => Promise<Identity | null>
  now: () => number
}

export type SyncResult =
  | { kind: 'no-login' }
  | { kind: 'unchanged'; ids: string[] }
  | { kind: 'updated'; ids: string[]; email: string }
  | { kind: 'added'; id: string; email: string }
  | { kind: 'skipped'; reason: string }

/**
 * Mirrors the terminal's Claude Code login into `cuw`, so that logging into a
 * subscription — or Claude Code renewing its token — keeps the matching
 * account fresh without any manual step.
 *
 * The common case costs no network: if a stored credential already carries the
 * live refresh token, nothing changed. Otherwise the live login is identified
 * once through the profile endpoint and written to every account with that
 * identity, or added as a new account when none matches.
 *
 * Never writes the live login, and never refreshes it: Claude Code owns its
 * renewal, and a refresh here would rotate the token out from under it.
 */
export async function syncLiveLogin(deps: SyncDeps): Promise<SyncResult> {
  const live = await deps.login.read()
  if (live === null) return { kind: 'no-login' }

  let credential
  try {
    credential = parseCredential(JSON.stringify(live))
  } catch (error) {
    if (error instanceof CredentialError) return { kind: 'skipped', reason: error.message }
    throw error
  }

  const accounts = await loadRegistry(deps.registryFile)
  const stored = await Promise.all(accounts.map(async account => {
    const blob = await deps.keychain.get(account.id)
    if (blob === null) return null
    try {
      return parseCredential(blob)
    } catch {
      return null
    }
  }))

  const current = accounts.filter((_, index) =>
    stored[index]?.refreshToken === credential.refreshToken &&
    stored[index]?.accessToken === credential.accessToken)
  if (current.length > 0) return { kind: 'unchanged', ids: current.map(account => account.id) }

  if (isExpired(credential, deps.now())) {
    return { kind: 'skipped', reason: 'the live login is expired — Claude Code renews it on its next request' }
  }

  const identity = await deps.fetchIdentity(credential.accessToken)
  if (identity === null) return { kind: 'skipped', reason: 'cannot identify the live login' }

  let matches = accounts.filter(account => account.uuid === identity.uuid)
  // An entry from before identities were recorded: trust the email instead.
  if (matches.length === 0) {
    matches = accounts.filter(account => account.uuid === undefined && account.email === identity.email)
  }

  const serialized = serializeCredential(credential)
  if (matches.length > 0) {
    const ids = new Set(matches.map(account => account.id))
    await saveRegistry(deps.registryFile, accounts.map(account => ids.has(account.id)
      ? { ...account, email: identity.email, uuid: identity.uuid }
      : account))
    for (const id of ids) await deps.keychain.set(id, serialized)
    return { kind: 'updated', ids: [...ids], email: identity.email }
  }

  const id = deriveId(identity.email, new Set(accounts.map(account => account.id)))
  const order = accounts.reduce((max, account) => Math.max(max, account.order), 0) + 1
  await saveRegistry(deps.registryFile, [
    ...accounts,
    { id, label: id, email: identity.email, order, uuid: identity.uuid },
  ])
  await deps.keychain.set(id, serialized)
  return { kind: 'added', id, email: identity.email }
}

/** One line for a human, or null when there is nothing worth saying. */
export function describeSync(result: SyncResult): string | null {
  switch (result.kind) {
    case 'updated': return `synced the live login into ${result.ids.join(', ')} (${result.email})`
    case 'added': return `added the live login as "${result.id}" (${result.email})`
    case 'unchanged': return `already in sync: ${result.ids.join(', ')}`
    case 'no-login': return 'no Claude Code login on this machine'
    case 'skipped': return `not synced: ${result.reason}`
  }
}
