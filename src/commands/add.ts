import type { Keychain } from '../keychain'
import { loadRegistry, RegistryError, saveRegistry } from '../registry'
import type { Io } from './status'

export type AddDeps = {
  registryFile: string
  keychain: Keychain
  readToken: () => Promise<string>
  verify: (token: string) => Promise<void>
}

const INSTRUCTIONS = `Log into this subscription in another terminal, then run:

  claude setup-token

Paste the token it prints below and press Enter. It is read from stdin, so it
never reaches your shell history.
`

/**
 * `label` mirrors the id and `email` is left empty: the usage endpoint does not
 * return an email, and every command and the table key off the id. Populating
 * `email` is deferred rather than guessed at.
 */
export async function runAdd(id: string, deps: AddDeps, io: Io): Promise<number> {
  const accounts = await loadRegistry(deps.registryFile)
  if (accounts.some(account => account.id === id)) {
    io.err(`"${id}" is already configured — remove it first with \`cuw rm ${id}\``)
    return 1
  }

  io.out(INSTRUCTIONS)
  const token = (await deps.readToken()).trim()
  if (token === '') {
    io.err('no token entered; nothing was stored')
    return 1
  }

  try {
    await deps.verify(token)
  } catch (error) {
    // The verifier's message is already token-free by construction.
    io.err(`token verification failed: ${(error as Error).message}`)
    io.err('nothing was stored')
    return 2
  }

  const order = accounts.reduce((max, account) => Math.max(max, account.order), 0) + 1
  const updated = [...accounts, { id, label: id, email: '', order }]

  // Validate before touching the Keychain, so a bad id leaves no orphan item.
  try {
    await saveRegistry(deps.registryFile, updated)
  } catch (error) {
    if (error instanceof RegistryError) {
      io.err(error.message)
      return 1
    }
    throw error
  }

  await deps.keychain.set(id, token)
  io.out(`stored "${id}" — run \`cuw\` to see it`)
  return 0
}
