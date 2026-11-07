import { parseCredential, serializeCredential } from '../credentials'
import type { Keychain } from '../keychain'
import type { Identity } from '../profile'
import type { Credential } from '../types'
import { loadRegistry, RegistryError, saveRegistry } from '../registry'
import type { Io } from './status'

export type AddDeps = {
  registryFile: string
  keychain: Keychain
  /** Reads the blob `claude auth login` stored, or null if not logged in. */
  readLoginCredential: () => Promise<string | null>
  /** Names the account behind the credential, or null when unreadable. */
  fetchIdentity: (token: string) => Promise<Identity | null>
}

const NOT_LOGGED_IN =
  'no Claude Code login found. Run `claude auth login` for the subscription you ' +
  'want to add, then run this command again.'

/**
 * Captures a copy of the credential the current `claude auth login` session
 * holds. A `setup-token` is deliberately not accepted: it carries
 * `user:inference` only and is refused by the usage endpoint with HTTP 403.
 *
 * `label` mirrors the id, and `uuid` plus `email` come from the profile
 * endpoint — the usage endpoint exposes neither. The uuid is what lets a later
 * switch recognise this account in the live Keychain login.
 */
export type AddOptions = {
  /** Re-record an already-configured account instead of refusing it. */
  force?: boolean
}

export async function runAdd(
  id: string,
  deps: AddDeps,
  io: Io,
  options: AddOptions = {},
): Promise<number> {
  const accounts = await loadRegistry(deps.registryFile)
  const existing = accounts.find(account => account.id === id)
  if (existing !== undefined && options.force !== true) {
    io.err(`"${id}" is already configured — re-record it in place with`)
    io.err(`\`cuw add --force ${id}\`, or remove it first with \`cuw rm ${id}\``)
    return 1
  }

  const blob = await deps.readLoginCredential()
  if (blob === null) {
    io.err(NOT_LOGGED_IN)
    return 2
  }

  let credential
  try {
    credential = parseCredential(blob)
  } catch (error) {
    // parseCredential's messages are token-free and carry the remedy.
    io.err(`cannot use the current login: ${(error as Error).message}`)
    io.err('nothing was stored')
    return 2
  }

  // Without an identity the account cannot be recognised during a switch, and a
  // registry missing one blocks `cuw use` from capturing an untracked login.
  // Refuse now rather than store a half-usable entry.
  const identity = await deps.fetchIdentity(credential.accessToken)
  if (identity === null) {
    io.err('cannot read the account profile for this login — check your connection and retry')
    io.err('nothing was stored')
    return 2
  }

  const saved = await recordAccount(id, credential, identity, deps)
  if (saved !== 'created' && saved !== 'updated') {
    io.err(saved.error)
    return 1
  }

  io.out(existing === undefined
    ? `stored "${id}" — run \`cuw\` to see it`
    : `re-recorded "${id}" (${identity.email}) — \`cuw use ${id}\` can now restore it`)
  return 0
}

/**
 * Writes one account's registry entry and its credential. Re-recording keeps
 * the row where it was: `order` and `label` are the user's arrangement, not
 * properties of the credential being refreshed. The registry is validated
 * before the Keychain is touched, so a bad id leaves no orphan item.
 */
export async function recordAccount(
  id: string,
  credential: Credential,
  identity: Identity,
  deps: Pick<AddDeps, 'registryFile' | 'keychain'>,
): Promise<'created' | 'updated' | { error: string }> {
  const accounts = await loadRegistry(deps.registryFile)
  const existing = accounts.find(account => account.id === id)
  const order = accounts.reduce((max, account) => Math.max(max, account.order), 0) + 1
  const updated = existing === undefined
    ? [...accounts, { id, label: id, email: identity.email, order, uuid: identity.uuid }]
    : accounts.map(account => account.id === id
      ? { ...account, email: identity.email, uuid: identity.uuid }
      : account)

  try {
    await saveRegistry(deps.registryFile, updated)
  } catch (error) {
    if (error instanceof RegistryError) return { error: error.message }
    throw error
  }

  await deps.keychain.set(id, serializeCredential(credential))
  return existing === undefined ? 'created' : 'updated'
}
