import type { Keychain } from '../keychain'
import { loadRegistry, saveRegistry } from '../registry'
import type { Io } from './status'

export type RmDeps = {
  registryFile: string
  keychain: Keychain
  confirm: (prompt: string) => Promise<boolean>
}

export async function runRm(id: string, deps: RmDeps, io: Io): Promise<number> {
  const accounts = await loadRegistry(deps.registryFile)
  if (!accounts.some(account => account.id === id)) {
    io.err(`"${id}" is not configured`)
    return 1
  }

  const confirmed = await deps.confirm(`Remove "${id}" and delete its stored token? [y/N] `)
  if (!confirmed) {
    io.out('cancelled')
    return 0
  }

  await deps.keychain.remove(id)
  await saveRegistry(deps.registryFile, accounts.filter(account => account.id !== id))
  io.out(`removed "${id}"`)
  return 0
}
