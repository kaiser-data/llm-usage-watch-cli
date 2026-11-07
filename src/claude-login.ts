import { createHash } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { CLAUDE_CREDENTIAL_SERVICE } from './constants'
import type { Runner } from './keychain'

/** `security` exit code for "the specified item could not be found". */
const NOT_FOUND_CODE = 44

/**
 * The Keychain service Claude Code uses for a login made under a custom config
 * directory: the default name plus the first eight hex digits of the
 * directory's SHA-256. Mirrors Claude Code's own derivation (2.1.x), which keys
 * on `CLAUDE_SECURESTORAGE_CONFIG_DIR` when set — so the login is spawned with
 * that variable pinned to the same string hashed here.
 */
export function isolatedCredentialService(configDir: string): string {
  const digest = createHash('sha256').update(configDir.normalize('NFC')).digest('hex')
  return `${CLAUDE_CREDENTIAL_SERVICE}-${digest.substring(0, 8)}`
}

/** Runs a child attached to the terminal, so the user can drive the browser flow. */
export type InteractiveSpawner = (argv: string[], env: Record<string, string>) => Promise<number>

export const realInteractiveSpawner: InteractiveSpawner = async (argv, env) => {
  const proc = Bun.spawn(argv, { env, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
  return await proc.exited
}

export type IsolatedLoginDeps = {
  run: Runner
  spawn: InteractiveSpawner
  /** Throwaway config directory; wiped before and after every login. */
  configDir: string
}

/** Signs in once and returns the resulting credential blob, or null. */
export type IsolatedLogin = (email?: string) => Promise<string | null>

/**
 * Runs `claude auth login` in a throwaway config directory and hands back the
 * credential it produced, then deletes every local trace of it.
 *
 * Two properties matter. The user's real Claude Code login is never touched, so
 * re-signing a stored account does not sign the terminal out. And the grant is
 * held by `cuw` alone: a credential copied out of the live login shares its
 * refresh-token lineage with Claude Code, which rotates it on its own schedule
 * and so silently kills `cuw`'s copy. A separate grant has no second holder.
 */
export function createIsolatedLogin(deps: IsolatedLoginDeps): IsolatedLogin {
  const service = isolatedCredentialService(deps.configDir)

  async function deleteItem(): Promise<void> {
    const result = await deps.run(['security', 'delete-generic-password', '-s', service])
    if (result.code !== 0 && result.code !== NOT_FOUND_CODE) {
      throw new Error(`could not clear the temporary login item (exit ${result.code})`)
    }
  }

  async function wipe(): Promise<void> {
    await deleteItem()
    await rm(deps.configDir, { recursive: true, force: true })
  }

  async function readBlob(): Promise<string | null> {
    const result = await deps.run(['security', 'find-generic-password', '-s', service, '-w'])
    if (result.code === 0 && result.stdout.trim() !== '') return result.stdout.trim()
    // Claude Code falls back to a plaintext file when the Keychain is unavailable.
    try {
      const text = (await readFile(join(deps.configDir, '.credentials.json'), 'utf8')).trim()
      return text === '' ? null : text
    } catch {
      return null
    }
  }

  return async email => {
    await wipe()
    await mkdir(deps.configDir, { recursive: true })
    try {
      const argv = ['claude', 'auth', 'login', '--claudeai']
      if (email !== undefined && email !== '') argv.push('--email', email)
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        CLAUDE_CONFIG_DIR: deps.configDir,
        CLAUDE_SECURESTORAGE_CONFIG_DIR: deps.configDir,
      }
      // A token in the parent environment would make the child skip the login.
      delete env.CLAUDE_CODE_OAUTH_TOKEN
      delete env.ANTHROPIC_API_KEY

      const code = await deps.spawn(argv, env)
      if (code !== 0) return null
      return await readBlob()
    } finally {
      await wipe()
    }
  }
}
