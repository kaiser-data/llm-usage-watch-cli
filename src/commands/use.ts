import { recommend } from '../classify'
import { isLegacyCredential, parseCredential, serializeCredential } from '../credentials'
import type { Keychain } from '../keychain'
import { mergeLogin, type LoginBlob, type LoginStore } from '../login'
import type { Identity } from '../profile'
import { loadRegistry, saveRegistry } from '../registry'
import type { Account } from '../types'
import { collectUsage, type UsageDeps } from '../usage'
import type { Io } from './status'

export type UseDeps = {
  registryFile: string
  accounts: Account[]
  usage: UsageDeps
  /** The raw credential store, not the refreshing wrapper: `use` needs blobs. */
  keychain: Keychain
  login: LoginStore
  fetchIdentity: (token: string) => Promise<Identity | null>
}

const ID_MAX = 32

/** An id derived from an email local part, kept within the registry's pattern. */
function deriveId(email: string, taken: Set<string>): string {
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

/**
 * Captures the login currently in the Keychain as a new account, so the switch
 * about to overwrite it does not strand the user outside an account they may
 * not be able to log back into.
 */
async function capture(
  live: LoginBlob,
  identity: Identity,
  deps: UseDeps,
  io: Io,
): Promise<string> {
  const id = deriveId(identity.email, new Set(deps.accounts.map(account => account.id)))
  const credential = parseCredential(JSON.stringify(live))
  const existing = await loadRegistry(deps.registryFile)
  const order = existing.reduce((max, account) => Math.max(max, account.order), 0) + 1

  await saveRegistry(deps.registryFile, [
    ...existing,
    { id, label: id, email: identity.email, order, uuid: identity.uuid },
  ])
  await deps.keychain.set(id, serializeCredential(credential))

  io.out(`the active login was not tracked — captured it as "${id}" (${identity.email})`)
  return id
}

export async function runUse(
  id: string | undefined,
  deps: UseDeps,
  io: Io,
): Promise<number> {
  const rows = await collectUsage(deps.accounts, deps.usage)

  const targetId = id ?? recommend(rows).useId
  if (targetId === null || targetId === undefined) {
    io.err('no usable account — every subscription is spent or unreachable')
    return 2
  }
  if (!deps.accounts.some(account => account.id === targetId)) {
    io.err(`unknown account "${targetId}"`)
    return 2
  }

  const stored = await deps.keychain.get(targetId)
  if (stored === null) {
    io.err(`no token stored for "${targetId}" — run \`cuw add ${targetId}\``)
    return 2
  }

  const target = parseCredential(stored)
  if (isLegacyCredential(target)) {
    io.err(`"${targetId}" was stored before cuw kept the full login blob, so it`)
    io.err('cannot be restored without losing plan metadata.')
    io.err(`Re-add it: claude auth login && cuw add ${targetId}`)
    return 2
  }

  const live = await deps.login.read()
  if (live === null) {
    io.err('no Claude Code login found — run `claude auth login`')
    return 2
  }

  const liveCredential = parseCredential(JSON.stringify(live))
  const identity = await deps.fetchIdentity(liveCredential.accessToken)
  if (identity === null) {
    io.err('cannot identify the active login, so it cannot be protected — not switching')
    return 2
  }

  const known = deps.accounts.find(account => account.uuid === identity.uuid)
  let activeId: string
  if (known !== undefined) {
    activeId = known.id
  } else {
    // A registry mid-migration cannot tell "untracked" from "tracked but never
    // identified", and guessing wrong duplicates an account.
    const unidentified = deps.accounts.filter(account => account.uuid === undefined)
    if (unidentified.length > 0) {
      io.err('the active login is unknown, and these accounts have no recorded identity:')
      io.err(`  ${unidentified.map(account => account.id).join(', ')}`)
      io.err('re-add them first: claude auth login && cuw add <id>')
      return 2
    }
    activeId = await capture(live, identity, deps, io)
  }

  if (activeId === targetId) {
    io.out(`already on "${targetId}"`)
    return 0
  }

  try {
    await deps.login.write(mergeLogin(live, target))
  } catch (error) {
    io.err((error as Error).message)
    io.err('nothing was changed')
    return 1
  }

  const row = rows.find(candidate => candidate.id === targetId)
  io.out(`switched: ${activeId} → ${targetId}`)
  if (row !== undefined) {
    io.out(`  five-hour ${row.fiveHourPct ?? 0}%, weekly ${row.weeklyPct ?? 0}%`)
  }
  io.out('  running sessions keep their current account')
  return 0
}
