import { describe, expect, test } from 'bun:test'
import { runStatus, type StatusDeps } from '../src/commands/status'
import type { Account, CodexUsage, UsageWindows } from '../src/types'

const NOW = new Date('2026-08-03T08:00:00Z')

const WINDOWS: UsageWindows = {
  fiveHourPct: 12,
  fiveHourResetsAt: new Date('2026-08-03T11:41:00Z'),
  weeklyPct: 34,
  weeklyResetsAt: null,
  opusWeeklyPct: null,
}

const CODEX: CodexUsage = {
  provider: 'codex',
  plan: 'plus',
  limits: [{
    id: 'codex',
    name: null,
    windows: [{
      role: 'primary',
      usedPct: 73,
      durationMinutes: 10080,
      resetsAt: new Date('2026-08-07T08:00:00Z'),
    }],
  }],
  error: null,
}

const accounts: Account[] = [{ id: 'main', label: 'main', email: 'm@x.com', order: 1 }]

function deps(overrides: Partial<StatusDeps> = {}): StatusDeps {
  return {
    accounts,
    color: false,
    width: 80,
    now: NOW,
    collectCodex: async () => CODEX,
    usage: {
      keychain: { get: async () => 'tok', set: async () => {}, remove: async () => {} },
      fetchWindows: async () => WINDOWS,
      probeWindows: async () => WINDOWS,
    },
    ...overrides,
  }
}

function captureIo() {
  const out: string[] = []
  const err: string[] = []
  return { io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) }, out, err }
}

describe('runStatus', () => {
  test('prints the table and exits 0', async () => {
    const { io, out } = captureIo()
    expect(await runStatus({ json: false }, deps(), io)).toBe(0)
    expect(out.join('')).toContain('main')
    expect(out.join('')).toContain('3h41m')
    expect(out.join('')).toContain('CODEX')
    expect(out.join('')).toContain('73%')
  })

  test('emits the combined JSON envelope', async () => {
    const { io, out } = captureIo()
    await runStatus({ json: true }, deps(), io)
    const parsed = JSON.parse(out.join(''))
    expect(parsed.claude[0].id).toBe('main')
    expect(parsed.claude[0].fiveHourPct).toBe(12)
    expect(parsed.claude[0].state).toBe('warm')
    expect(parsed.codex.plan).toBe('plus')
    expect(parsed.codex.limits[0].windows[0].usedPct).toBe(73)
  })

  test('JSON output never contains a token', async () => {
    const { io, out } = captureIo()
    await runStatus({ json: true }, deps(), io)
    expect(out.join('')).not.toContain('tok')
  })

  test('exits 2 when an account has no stored token', async () => {
    const { io } = captureIo()
    const code = await runStatus({ json: false }, deps({
      usage: {
        keychain: { get: async () => null, set: async () => {}, remove: async () => {} },
        fetchWindows: async () => WINDOWS,
        probeWindows: async () => WINDOWS,
      },
    }), io)
    expect(code).toBe(2)
  })

  test('exits 0 with the first-run message when no accounts exist', async () => {
    const { io, out } = captureIo()
    expect(await runStatus({ json: false }, deps({ accounts: [] }), io)).toBe(0)
    expect(out.join('')).toMatch(/cuw add/)
    expect(out.join('')).toContain('CODEX')
    expect(out.join('')).toContain('73%')
  })

  test('a Codex error does not affect the exit code', async () => {
    const failed: CodexUsage = {
      provider: 'codex',
      plan: null,
      limits: [],
      error: { cause: 'timeout', message: 'Codex usage check timed out' },
    }
    const { io, out } = captureIo()

    expect(await runStatus({ json: false }, deps({
      collectCodex: async () => failed,
    }), io)).toBe(0)
    expect(out.join('')).toContain('timed out')
  })

  test('an unexpected Codex rejection is isolated from Claude output', async () => {
    const { io, out } = captureIo()

    expect(await runStatus({ json: false }, deps({
      collectCodex: async () => { throw new Error('secret-detail') },
    }), io)).toBe(0)
    expect(out.join('')).toContain('main')
    expect(out.join('')).toContain('Codex usage could not be read')
    expect(out.join('')).not.toContain('secret-detail')
  })

  test('starts Claude and Codex collection concurrently', async () => {
    let releaseClaude: (() => void) | undefined
    let codexStarted = false
    const claudeGate = new Promise<void>(resolve => { releaseClaude = resolve })
    const configured = deps({
      collectCodex: async () => {
        codexStarted = true
        return CODEX
      },
      usage: {
        keychain: {
          get: async () => {
            await claudeGate
            return 'tok'
          },
          set: async () => {},
          remove: async () => {},
        },
        fetchWindows: async () => WINDOWS,
        probeWindows: async () => WINDOWS,
      },
    })
    const { io } = captureIo()

    const running = runStatus({ json: false }, configured, io)
    await Promise.resolve()
    expect(codexStarted).toBe(true)
    releaseClaude?.()
    await running
  })
})
