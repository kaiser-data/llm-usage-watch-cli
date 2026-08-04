import { CLAUDE_CREDENTIAL_SERVICE } from './constants'
import type { Runner } from './keychain'
import type { Credential } from './types'

/** `security` exit code for "the specified item could not be found". */
const NOT_FOUND_CODE = 44

/** `security` prints item attributes on stdout, one `"key"<blob>="value"` per line. */
const ACCOUNT_ATTRIBUTE = /^\s*"acct"<blob>="(.*)"\s*$/m

/** The whole Keychain item: the login plus every MCP server's OAuth tokens. */
export type LoginBlob = Record<string, unknown>

export class LoginError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LoginError'
  }
}

/**
 * Replaces only the login branch. Every other top-level key — notably
 * `mcpOAuth`, which holds each MCP server's OAuth tokens — is carried across
 * untouched. Replacing the item wholesale would sign the user out of every
 * connected MCP server, silently and with no way back.
 */
export function mergeLogin(live: LoginBlob, credential: Credential): LoginBlob {
  if (Object.keys(credential.raw).length === 0) {
    throw new LoginError('credential predates the stored login branch and cannot be restored')
  }
  return { ...live, claudeAiOauth: credential.raw }
}

export type LoginStore = {
  /** Null when no login item exists. */
  read(): Promise<LoginBlob | null>
  write(blob: LoginBlob): Promise<void>
}

export function createLoginStore(run: Runner): LoginStore {
  /**
   * Read rather than assume: the item is created by `claude auth login` under
   * whatever account name that machine used.
   */
  async function accountName(): Promise<string> {
    const result = await run(['security', 'find-generic-password', '-s', CLAUDE_CREDENTIAL_SERVICE])
    const account = ACCOUNT_ATTRIBUTE.exec(result.stdout)?.[1]
    if (result.code !== 0 || account === undefined) {
      throw new LoginError('cannot read the Claude Code login item')
    }
    return account
  }

  return {
    async read() {
      const result = await run([
        'security', 'find-generic-password', '-s', CLAUDE_CREDENTIAL_SERVICE, '-w',
      ])
      if (result.code === NOT_FOUND_CODE) return null
      // stderr is not included: it can echo the queried item.
      if (result.code !== 0) throw new LoginError('cannot read the Claude Code login item')

      let parsed: unknown
      try {
        parsed = JSON.parse(result.stdout.trim())
      } catch {
        throw new LoginError('the Claude Code login item is not valid JSON')
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new LoginError('the Claude Code login item is not a JSON object')
      }
      return parsed as LoginBlob
    },

    async write(blob) {
      const account = await accountName()
      // As in `keychain.set`, the value travels as an argv element and is
      // briefly visible to same-user processes. Here it is wider than one
      // account's credential: this blob also carries the MCP server tokens.
      const result = await run([
        'security', 'add-generic-password', '-U',
        '-s', CLAUDE_CREDENTIAL_SERVICE, '-a', account,
        '-w', JSON.stringify(blob),
      ])
      // stderr is discarded: it may echo the argv containing the blob.
      if (result.code !== 0) {
        throw new LoginError(`writing the Claude Code login failed (exit ${result.code})`)
      }
    },
  }
}
