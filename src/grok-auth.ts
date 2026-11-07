import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { GrokErrorCause } from './types'

export type GrokAuth = {
  accessToken: string
  refreshToken: string | null
  clientId: string | null
  expiresAt: Date | null
}

export type GrokAuthStore = {
  resolveAuthPath: () => string | null
  readFile: (path: string) => Promise<string>
}

export class GrokAuthError extends Error {
  constructor(
    readonly authCause: GrokErrorCause,
    message: string,
  ) {
    super(message)
    this.name = 'GrokAuthError'
  }
}

export function defaultGrokHome(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return env.GROK_HOME ?? join(home, '.grok')
}

export function defaultGrokAuthPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return join(defaultGrokHome(env, home), 'auth.json')
}

export function resolveGrokAuthPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string | null {
  const path = defaultGrokAuthPath(env, home)
  return existsSync(path) ? path : null
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : null
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function parseExpiresAt(value: unknown): Date | null {
  if (typeof value !== 'string' || value === '') return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * Picks the best credential entry from auth.json. Prefer a non-expired access
 * token when several issuers are present; otherwise take the first usable key.
 */
export function pickGrokAuthEntry(raw: unknown): GrokAuth {
  const root = record(raw)
  if (root === null) {
    throw new GrokAuthError('schema', 'Grok auth.json was not a JSON object')
  }

  const entries = Object.values(root)
    .map(value => record(value))
    .filter((value): value is Record<string, unknown> => value !== null)

  if (entries.length === 0) {
    throw new GrokAuthError(
      'not-logged-in',
      'Grok is not logged in on this machine — run `grok login`',
    )
  }

  const now = Date.now()
  const candidates = entries
    .map(entry => {
      const accessToken = asNonEmptyString(entry.key)
      if (accessToken === null) return null
      const expiresAt = parseExpiresAt(entry.expires_at)
      return {
        accessToken,
        refreshToken: asNonEmptyString(entry.refresh_token),
        clientId: asNonEmptyString(entry.oidc_client_id)
          ?? asNonEmptyString(entry.client_id),
        expiresAt,
      } satisfies GrokAuth
    })
    .filter((entry): entry is GrokAuth => entry !== null)

  if (candidates.length === 0) {
    throw new GrokAuthError(
      'not-logged-in',
      'Grok is not logged in on this machine — run `grok login`',
    )
  }

  const live = candidates.find(entry =>
    entry.expiresAt === null || entry.expiresAt.getTime() > now)
  return live ?? candidates[0]!
}

export function realGrokAuthStore(): GrokAuthStore {
  return {
    resolveAuthPath: () => resolveGrokAuthPath(),
    readFile: path => readFile(path, 'utf8'),
  }
}

export async function readGrokAuth(store: GrokAuthStore): Promise<GrokAuth> {
  const authPath = store.resolveAuthPath()
  if (authPath === null) {
    throw new GrokAuthError(
      'not-installed',
      'Grok auth file was not found — is the Grok CLI installed and signed in?',
    )
  }

  let text: string
  try {
    text = await store.readFile(authPath)
  } catch {
    throw new GrokAuthError(
      'not-logged-in',
      'Grok auth file could not be read — run `grok login`',
    )
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new GrokAuthError('schema', 'Grok auth.json was not valid JSON')
  }

  return pickGrokAuthEntry(raw)
}
