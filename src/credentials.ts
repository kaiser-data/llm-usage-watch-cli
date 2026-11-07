import {
  OAUTH_CLIENT_ID,
  OAUTH_TOKEN_ENDPOINT,
  REFRESH_SKEW_MS,
  REQUIRED_SCOPE,
} from './constants'
import { RE_ADD_HINT } from './hints'
import type { Credential } from './types'

export type CredentialErrorCause = 'malformed' | 'insufficient-scope' | 'refresh-rejected'

export class CredentialError extends Error {
  constructor(message: string, override readonly cause: CredentialErrorCause) {
    super(message)
    this.name = 'CredentialError'
  }
}

const SETUP_TOKEN_HELP =
  'this looks like a setup-token, which is inference-only and cannot read usage. ' +
  // Reached from both a first add and a re-record, so it names neither form:
  // whichever the user ran is the one to repeat.
  'Log into the account with `claude auth login`, then run the add again.'

const SCOPE_HELP =
  `credential lacks the "${REQUIRED_SCOPE}" scope (inference-only). ` +
  'Long-lived tokens from `claude setup-token` cannot read usage — ' +
  'log in with `claude auth login` and re-add the account.'

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null
}

/**
 * Accepts either the blob `claude auth login` writes to the Keychain
 * (`{claudeAiOauth: {...}}`) or the bare credential cuw itself stores.
 */
export function parseCredential(raw: string): Credential {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // A pasted setup-token is a bare string, not JSON — the most likely mistake.
    throw new CredentialError(SETUP_TOKEN_HELP, 'insufficient-scope')
  }

  const root = asRecord(parsed)
  if (root === null) throw new CredentialError(SETUP_TOKEN_HELP, 'insufficient-scope')

  const wrapped = asRecord(root.claudeAiOauth)
  const source = wrapped ?? root

  const accessToken = source.accessToken
  const refreshToken = source.refreshToken
  const expiresAt = source.expiresAt
  const scopes = source.scopes

  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new CredentialError('credential has no access token', 'malformed')
  }
  if (typeof refreshToken !== 'string' || refreshToken === '') {
    throw new CredentialError(
      'credential has no refresh token — it cannot be renewed, so cuw will not store it',
      'malformed',
    )
  }
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    throw new CredentialError('credential has no expiry timestamp', 'malformed')
  }
  if (!Array.isArray(scopes) || !scopes.every(scope => typeof scope === 'string')) {
    throw new CredentialError('credential has no scope list', 'malformed')
  }
  if (!scopes.includes(REQUIRED_SCOPE)) {
    throw new CredentialError(SCOPE_HELP, 'insufficient-scope')
  }

  return {
    accessToken,
    refreshToken,
    expiresAt,
    scopes: scopes as string[],
    // Wrapped form: the branch itself. cuw's own form: the persisted copy.
    raw: wrapped ?? asRecord(source.raw) ?? {},
  }
}

export function serializeCredential(credential: Credential): string {
  return JSON.stringify(credential)
}

/** True for a credential stored before cuw kept the full login branch. */
export function isLegacyCredential(credential: Credential): boolean {
  return Object.keys(credential.raw).length === 0
}

/** True once the access token is expired, or close enough to it to be risky. */
export function isExpired(credential: Credential, now: number): boolean {
  return credential.expiresAt - now <= REFRESH_SKEW_MS
}

/**
 * Projects refreshed values back into the passthrough. A legacy credential has
 * none and must not gain one: a half-populated branch would look restorable and
 * would be written over a working login. `refreshTokenExpiresAt` is left as it
 * was — the token endpoint does not report it.
 */
function refreshedRaw(
  raw: Record<string, unknown>,
  next: { accessToken: string; refreshToken: string; expiresAt: number },
): Record<string, unknown> {
  if (Object.keys(raw).length === 0) return {}
  return { ...raw, ...next }
}

/**
 * RFC 6749 §5.2 error codes are bare snake_case words. Matching that shape is
 * what makes the value safe to display: a token, a quoted body, or a prose
 * sentence cannot satisfy it, so nothing secret survives the filter.
 * `error_description` is free-form and is never read.
 */
const OAUTH_ERROR_CODE = /^[a-z][a-z_]{2,39}$/

async function oauthErrorCode(response: Response): Promise<string | null> {
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return null
  }
  const code = asRecord(payload)?.error
  return typeof code === 'string' && OAUTH_ERROR_CODE.test(code) ? code : null
}

export type RefreshDeps = { fetcher: typeof fetch; now: number }

export async function refreshCredential(
  credential: Credential,
  deps: RefreshDeps,
): Promise<Credential> {
  const response = await deps.fetcher(OAUTH_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: credential.refreshToken,
      client_id: OAUTH_CLIENT_ID,
    }).toString(),
  })

  if (!response.ok) {
    // The body at large stays discarded — it can echo the submitted refresh
    // token — but the bare error code is worth keeping: `invalid_grant` (dead or
    // already-rotated) and a server-side fault are otherwise the same opaque 400.
    const code = await oauthErrorCode(response)
    const detail = code === null ? `HTTP ${response.status}` : `HTTP ${response.status}: ${code}`
    throw new CredentialError(
      `refresh token expired or rejected (${detail}) — sign it back in with \`${RE_ADD_HINT}\``,
      'refresh-rejected',
    )
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new CredentialError('refresh response was not valid JSON', 'refresh-rejected')
  }

  const body = asRecord(payload)
  const accessToken = body?.access_token
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new CredentialError('refresh response carried no access token', 'refresh-rejected')
  }

  const expiresIn = typeof body?.expires_in === 'number' ? body.expires_in : 0
  const rotated = typeof body?.refresh_token === 'string' ? body.refresh_token : null
  const scope = typeof body?.scope === 'string' ? body.scope.split(' ') : credential.scopes

  // The endpoint may rotate the refresh token or reuse the existing one.
  const refreshToken = rotated ?? credential.refreshToken
  const expiresAt = deps.now + expiresIn * 1000

  return {
    accessToken,
    refreshToken,
    expiresAt,
    scopes: scope,
    raw: refreshedRaw(credential.raw, { accessToken, refreshToken, expiresAt }),
  }
}
