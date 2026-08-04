import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Account } from './types'

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/

export type RegistryErrorCause = 'malformed' | 'duplicate-id' | 'invalid-id'

export class RegistryError extends Error {
  constructor(message: string, override readonly cause: RegistryErrorCause) {
    super(message)
    this.name = 'RegistryError'
  }
}

export function registryPath(home: string): string {
  return join(home, '.config', 'cuw', 'accounts.json')
}

function assertAccount(raw: unknown, index: number): Account {
  if (typeof raw !== 'object' || raw === null) {
    throw new RegistryError(`entry ${index} is not an object`, 'malformed')
  }
  const entry = raw as Record<string, unknown>
  for (const field of ['id', 'label', 'email'] as const) {
    if (typeof entry[field] !== 'string') {
      throw new RegistryError(`entry ${index} is missing "${field}"`, 'malformed')
    }
  }
  if (typeof entry.order !== 'number') {
    throw new RegistryError(`entry ${index} is missing "order"`, 'malformed')
  }
  const id = entry.id as string
  if (!ID_PATTERN.test(id)) {
    throw new RegistryError(`invalid id "${id}": use lowercase letters, digits, - and _`, 'invalid-id')
  }
  const uuid = entry.uuid
  if (uuid !== undefined && typeof uuid !== 'string') {
    throw new RegistryError(`entry ${index} has a non-string "uuid"`, 'malformed')
  }
  return {
    id,
    label: entry.label as string,
    email: entry.email as string,
    order: entry.order,
    // Spread, so an absent uuid stays absent rather than serializing as null.
    ...(uuid === undefined ? {} : { uuid }),
  }
}

function assertUniqueIds(accounts: Account[]): void {
  const seen = new Set<string>()
  for (const account of accounts) {
    if (seen.has(account.id)) {
      throw new RegistryError(`duplicate id "${account.id}"`, 'duplicate-id')
    }
    seen.add(account.id)
  }
}

export async function loadRegistry(path: string): Promise<Account[]> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new RegistryError(`${path} is not valid JSON`, 'malformed')
  }
  if (!Array.isArray(parsed)) {
    throw new RegistryError(`${path} must contain a JSON array`, 'malformed')
  }
  const accounts = parsed.map(assertAccount)
  assertUniqueIds(accounts)
  return [...accounts].sort((a, b) => a.order - b.order)
}

export async function saveRegistry(path: string, accounts: Account[]): Promise<void> {
  const validated = accounts.map(assertAccount)
  assertUniqueIds(validated)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(validated, null, 2)}\n`, 'utf8')
}
