import { PRIME_MODEL, PRIME_PROMPT } from './constants'
import type { Spawner } from './spawn'
import type { Account, UsageWindows } from './types'

export type PrimeDeps = {
  spawn: Spawner
  scratchDir: string
  configDir: string
  readWindows: (token: string) => Promise<UsageWindows>
}

export type PrimeResult = {
  id: string
  ok: boolean
  resetsAt: Date | null
  exitCode: number
  detail: string
}

/** Strips any occurrence of the token from text bound for a message. */
function redact(text: string, token: string): string {
  return token === '' ? text : text.split(token).join('[redacted]')
}

/**
 * Opens the five-hour window with the smallest real request possible:
 * the cheapest model, a two-character prompt, no tools, no plugins or hooks
 * (`--safe-mode`), no session file, an isolated config directory, and an empty
 * working directory so no CLAUDE.md is discovered.
 */
export async function primeAccount(
  account: Account,
  token: string,
  deps: PrimeDeps,
): Promise<PrimeResult> {
  const argv = [
    'claude',
    '-p', PRIME_PROMPT,
    '--model', PRIME_MODEL,
    '--tools', '',
    '--safe-mode',
    '--no-session-persistence',
  ]
  const env = {
    ...(process.env as Record<string, string>),
    CLAUDE_CODE_OAUTH_TOKEN: token,
    CLAUDE_CONFIG_DIR: deps.configDir,
  }

  const spawned = await deps.spawn(argv, env, deps.scratchDir)
  if (spawned.code !== 0) {
    return {
      id: account.id,
      ok: false,
      resetsAt: null,
      exitCode: spawned.code,
      detail: redact(spawned.stderrTail.trim() || 'claude exited non-zero', token),
    }
  }

  // Never report a window as started without confirming it.
  const windows = await deps.readWindows(token)
  if (windows.fiveHourPct === null) {
    return {
      id: account.id,
      ok: false,
      resetsAt: null,
      exitCode: 0,
      detail: 'claude succeeded but no window is open yet',
    }
  }

  return {
    id: account.id,
    ok: true,
    resetsAt: windows.fiveHourResetsAt,
    exitCode: 0,
    detail: 'window started',
  }
}
