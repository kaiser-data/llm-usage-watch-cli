import { HEADER_KEYS, PRIME_MODEL, PRIME_PROMPT } from './constants'
import type { Spawner } from './spawn'
import type { UsageWindows } from './types'

/** Matches `... <header-name>: <value>` anywhere in a debug log line. */
function headerMap(debugLog: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of debugLog.split('\n')) {
    const match = line.match(/([A-Za-z0-9-]*ratelimit[A-Za-z0-9-]*)\s*:\s*(\S+)/i)
    const [, name, value] = match ?? []
    if (name !== undefined && value !== undefined) map.set(name.toLowerCase(), value)
  }
  return map
}

/** Remaining is a 0-1 fraction of budget left; we report percentage used. */
function usedPct(map: Map<string, string>, key: string): number | null {
  const raw = map.get(key.toLowerCase())
  if (raw === undefined) return null
  const remaining = Number(raw)
  if (!Number.isFinite(remaining)) return null
  const fraction = remaining <= 1 ? remaining : remaining / 100
  return Math.round((1 - fraction) * 100)
}

function resetDate(map: Map<string, string>, key: string): Date | null {
  const raw = map.get(key.toLowerCase())
  if (raw === undefined) return null
  const epochSeconds = Number(raw)
  if (Number.isFinite(epochSeconds)) return new Date(epochSeconds * 1000)
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export function parseRateLimitHeaders(debugLog: string): UsageWindows {
  const map = headerMap(debugLog)
  return {
    fiveHourPct: usedPct(map, HEADER_KEYS.fiveHourRemaining),
    fiveHourResetsAt: resetDate(map, HEADER_KEYS.fiveHourReset),
    weeklyPct: usedPct(map, HEADER_KEYS.weeklyRemaining),
    weeklyResetsAt: resetDate(map, HEADER_KEYS.weeklyReset),
    opusWeeklyPct: usedPct(map, HEADER_KEYS.opusWeeklyRemaining),
  }
}

export type ProbeDeps = {
  spawn: Spawner
  scratchDir: string
  configDir: string
  logPath: string
  readLog: (path: string) => Promise<string>
}

/**
 * The probe both measures and primes: it sends a real request. Callers must
 * surface that — `collectUsage` marks such rows `source: 'probe'`.
 */
export async function probeUsage(token: string, deps: ProbeDeps): Promise<UsageWindows> {
  const argv = [
    'claude',
    '-p', PRIME_PROMPT,
    '--model', PRIME_MODEL,
    '--tools', '',
    '--safe-mode',
    '--no-session-persistence',
    '--debug', 'api',
    '--debug-file', deps.logPath,
  ]
  const env = {
    ...(process.env as Record<string, string>),
    CLAUDE_CODE_OAUTH_TOKEN: token,
    CLAUDE_CONFIG_DIR: deps.configDir,
  }

  const result = await deps.spawn(argv, env, deps.scratchDir)
  if (result.code !== 0) {
    // stderr is not included: the debug stream can contain request material.
    throw new Error(`probe failed (exit ${result.code})`)
  }
  return parseRateLimitHeaders(await deps.readLog(deps.logPath))
}
