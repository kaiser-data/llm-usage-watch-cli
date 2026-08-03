import { describe, expect, test } from 'bun:test'
import { primeAccount, type PrimeDeps } from '../src/prime'
import { runPrime, type PrimeCommandDeps } from '../src/commands/prime'
import { PRIME_MODEL, PRIME_PROMPT } from '../src/constants'
import type { SpawnResult, Spawner } from '../src/spawn'
import type { Account, UsageWindows } from '../src/types'

const account: Account = { id: 'main', label: 'main', email: 'm@x.com', order: 1 }

const ACTIVE: UsageWindows = {
  fiveHourPct: 1,
  fiveHourResetsAt: new Date('2026-08-03T13:00:00Z'),
  weeklyPct: 5,
  weeklyResetsAt: null,
  opusWeeklyPct: null,
}

const COLD: UsageWindows = {
  fiveHourPct: null,
  fiveHourResetsAt: null,
  weeklyPct: 5,
  weeklyResetsAt: null,
  opusWeeklyPct: null,
}

function deps(
  spawnResult: SpawnResult = { code: 0, stderrTail: '' },
  after: UsageWindows = ACTIVE,
): PrimeDeps & { calls: { argv: string[]; env: Record<string, string>; cwd: string }[] } {
  const calls: { argv: string[]; env: Record<string, string>; cwd: string }[] = []
  const spawn: Spawner = async (argv, env, cwd) => {
    calls.push({ argv, env, cwd })
    return spawnResult
  }
  return {
    calls,
    spawn,
    scratchDir: '/tmp/cuw-empty',
    configDir: '/tmp/cuw-profile',
    readWindows: async () => after,
  }
}

describe('primeAccount', () => {
  test('sends the token by environment, never by argv', async () => {
    const d = deps()
    await primeAccount(account, 'sk-secret', d)
    expect(d.calls[0].argv.join(' ')).not.toContain('sk-secret')
    expect(d.calls[0].env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-secret')
  })

  test('uses the isolated, minimal flag set', async () => {
    const d = deps()
    await primeAccount(account, 'tok', d)
    const argv = d.calls[0].argv.join(' ')
    expect(argv).toContain(`--model ${PRIME_MODEL}`)
    expect(argv).toContain(`-p ${PRIME_PROMPT}`)
    expect(argv).toContain('--safe-mode')
    expect(argv).toContain('--no-session-persistence')
    expect(d.calls[0].env.CLAUDE_CONFIG_DIR).toBe('/tmp/cuw-profile')
    expect(d.calls[0].cwd).toBe('/tmp/cuw-empty')
  })

  test('reports success with the reset time once a window is open', async () => {
    const result = await primeAccount(account, 'tok', deps())
    expect(result.ok).toBe(true)
    expect(result.resetsAt).toEqual(ACTIVE.fiveHourResetsAt)
  })

  test('reports failure when the spawn exits non-zero', async () => {
    const result = await primeAccount(account, 'tok', deps({ code: 1, stderrTail: 'boom' }))
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.detail).toContain('boom')
  })

  test('does not claim success when no window opened', async () => {
    const result = await primeAccount(account, 'tok', deps({ code: 0, stderrTail: '' }, COLD))
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/no window/i)
  })

  test('failure detail never contains the token', async () => {
    const result = await primeAccount(account, 'sk-secret', deps({ code: 1, stderrTail: 'token sk-secret bad' }))
    expect(result.detail).not.toContain('sk-secret')
  })
})

describe('runPrime', () => {
  const NOW = new Date('2026-08-03T08:00:00Z')
  const accounts: Account[] = [
    { id: 'a', label: 'a', email: '', order: 1 },
    { id: 'b', label: 'b', email: '', order: 2 },
  ]

  function captureIo() {
    const out: string[] = []
    return { io: { out: (t: string) => out.push(t), err: (t: string) => out.push(t) }, out }
  }

  function commandDeps(
    windowsById: Record<string, UsageWindows> = { a: ACTIVE, b: COLD },
  ): PrimeCommandDeps & { primed: string[] } {
    const primed: string[] = []
    return {
      primed,
      accounts,
      now: NOW,
      usage: {
        keychain: { get: async () => 'tok', set: async () => {}, remove: async () => {} },
        fetchWindows: async () => ACTIVE,
        probeWindows: async () => ACTIVE,
      },
      prime: {
        spawn: async argv => {
          primed.push(argv.join(' '))
          return { code: 0, stderrTail: '' }
        },
        scratchDir: '/tmp/cuw-empty',
        configDir: '/tmp/cuw-profile',
        readWindows: async () => ACTIVE,
      },
    }
  }

  test('primes a named account', async () => {
    const { io, out } = captureIo()
    const d = commandDeps()
    expect(await runPrime({ ids: ['a'], cold: false }, d, io)).toBe(0)
    expect(d.primed).toHaveLength(1)
    expect(out.join('')).toContain('window started')
  })

  test('rejects an unknown id without priming anything', async () => {
    const { io, out } = captureIo()
    const d = commandDeps()
    expect(await runPrime({ ids: ['nope'], cold: false }, d, io)).toBe(1)
    expect(d.primed).toHaveLength(0)
    expect(out.join('')).toMatch(/not configured/i)
  })

  test('--cold primes only accounts with no open window', async () => {
    const { io } = captureIo()
    const d = commandDeps()
    // Both accounts report ACTIVE via usage, so none are cold.
    expect(await runPrime({ ids: [], cold: true }, d, io)).toBe(0)
    expect(d.primed).toHaveLength(0)
  })

  test('--cold primes every cold account', async () => {
    const { io } = captureIo()
    const d = commandDeps()
    d.usage.fetchWindows = async () => COLD
    expect(await runPrime({ ids: [], cold: true }, d, io)).toBe(0)
    expect(d.primed).toHaveLength(2)
  })

  test('reports a missing token instead of priming', async () => {
    const { io, out } = captureIo()
    const d = commandDeps()
    d.usage.keychain.get = async () => null
    expect(await runPrime({ ids: ['a'], cold: false }, d, io)).toBe(2)
    expect(out.join('')).toMatch(/no token stored/i)
  })

  test('says so when every account already has a window', async () => {
    const { io, out } = captureIo()
    expect(await runPrime({ ids: [], cold: true }, commandDeps(), io)).toBe(0)
    expect(out.join('')).toMatch(/already has an open window/i)
  })
})
