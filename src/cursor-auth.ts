import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CursorErrorCause } from './types'

const AUTH_KEYS = [
  'cursorAuth/accessToken',
  'cursorAuth/refreshToken',
  'cursorAuth/stripeMembershipType',
] as const

export type CursorAuth = {
  accessToken: string
  refreshToken: string | null
  plan: string | null
}

export type CursorAuthStore = {
  resolveDbPath: () => string | null
  readValues: (dbPath: string, keys: readonly string[]) => Promise<Record<string, string | null>>
}

export class CursorAuthError extends Error {
  constructor(
    readonly authCause: CursorErrorCause,
    message: string,
  ) {
    super(message)
    this.name = 'CursorAuthError'
  }
}

export function defaultCursorStateDbPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
  }
  if (platform === 'win32') {
    const appData = env.APPDATA ?? join(home, 'AppData', 'Roaming')
    return join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb')
  }
  const xdg = env.XDG_CONFIG_HOME ?? join(home, '.config')
  return join(xdg, 'Cursor', 'User', 'globalStorage', 'state.vscdb')
}

export function resolveCursorStateDbPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string | null {
  const path = defaultCursorStateDbPath(env, home, platform)
  return existsSync(path) ? path : null
}

export function readCursorAuthValues(
  dbPath: string,
  keys: readonly string[],
): Record<string, string | null> {
  const db = new Database(dbPath, { readonly: true })
  try {
    const query = db.query<{ value: string }, [string]>(
      'SELECT value FROM ItemTable WHERE key = ?',
    )
    const out: Record<string, string | null> = {}
    for (const key of keys) {
      const row = query.get(key)
      const value = row?.value
      out[key] = typeof value === 'string' && value !== '' ? value : null
    }
    return out
  } finally {
    db.close()
  }
}

export function realCursorAuthStore(): CursorAuthStore {
  return {
    resolveDbPath: () => resolveCursorStateDbPath(),
    readValues: async (dbPath, keys) => readCursorAuthValues(dbPath, keys),
  }
}

export async function readCursorAuth(store: CursorAuthStore): Promise<CursorAuth> {
  const dbPath = store.resolveDbPath()
  if (dbPath === null) {
    throw new CursorAuthError(
      'not-installed',
      'Cursor state database was not found — is Cursor installed?',
    )
  }

  const values = await store.readValues(dbPath, AUTH_KEYS)
  const accessToken = values['cursorAuth/accessToken']
  if (accessToken === null || accessToken === undefined) {
    throw new CursorAuthError(
      'not-logged-in',
      'Cursor is not logged in on this machine',
    )
  }

  return {
    accessToken,
    refreshToken: values['cursorAuth/refreshToken'] ?? null,
    plan: values['cursorAuth/stripeMembershipType'] ?? null,
  }
}
