import {
  OAUTH_CLIENT_ID,
  OAUTH_TOKEN_ENDPOINT,
  REFRESH_SKEW_MS,
  REQUIRED_SCOPE,
} from './constants'
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
  'Log into the account with `claude auth login`, then run `cuw add <id>` again.'

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

  const source = asRecord(root.claudeAiOauth) ?? root

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

  return { accessToken, refreshToken, expiresAt, scopes: scopes as string[] }
}

export function serializeCredential(credential: Credential): string {
  return JSON.stringify(credential)
}

/** True once the access token is expired, or close enough to it to be risky. */
export function isExpired(credential: Credential, now: number): boolean {
  return credential.expiresAt - now <= REFRESH_SKEW_MS
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
    // The body is discarded: it can echo the submitted refresh token.
    throw new CredentialError(
      `refresh token expired or rejected (HTTP ${response.status}) — re-add the account with \`cuw add <id>\``,
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

  return {
    accessToken,
    // The endpoint may rotate the refresh token or reuse the existing one.
    refreshToken: rotated ?? credential.refreshToken,
    expiresAt: deps.now + expiresIn * 1000,
    scopes: scope,
  }
}
