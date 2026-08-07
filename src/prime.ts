import { hasOpenWindow } from './classify'
import {
  PRIME_CONFIRM_ATTEMPTS,
  PRIME_CONFIRM_DELAY_MS,
  PRIME_MODEL,
  PRIME_PROMPT,
} from './constants'
import type { Spawner } from './spawn'
import type { Account, UsageWindows } from './types'

export type PrimeDeps = {
  spawn: Spawner
  scratchDir: string
  configDir: string
  readWindows: (token: string) => Promise<UsageWindows>
  /** Injected so the confirmation poll costs no real time under test. */
  sleep: (ms: number) => Promise<void>
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
 * Reads the usage endpoint until it admits the window is open. The endpoint
 * trails a freshly opened window by a second or two, so the first read after a
 * successful session routinely still reports a dormant account.
 */
async function confirmWindow(token: string, deps: PrimeDeps): Promise<UsageWindows | null> {
  for (let attempt = 0; attempt < PRIME_CONFIRM_ATTEMPTS; attempt++) {
    if (attempt > 0) await deps.sleep(PRIME_CONFIRM_DELAY_MS)
    const windows = await deps.readWindows(token)
    if (hasOpenWindow(windows)) return windows
  }
  return null
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

  // Never report a window as started without confirming it. The confirmation
  // rests on the reset time, not the percentage: one `hi` on the cheapest model
  // registers as 0% utilization, which is indistinguishable from no window at
  // all unless the clock is read directly.
  const windows = await confirmWindow(token, deps)
  if (windows === null) {
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
