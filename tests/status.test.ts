import { describe, expect, test } from 'bun:test'
import { runStatus, type StatusDeps } from '../src/commands/status'
import type { Account, UsageWindows } from '../src/types'

const NOW = new Date('2026-08-03T08:00:00Z')

const WINDOWS: UsageWindows = {
  fiveHourPct: 12,
  fiveHourResetsAt: new Date('2026-08-03T11:41:00Z'),
  weeklyPct: 34,
  weeklyResetsAt: null,
  opusWeeklyPct: null,
}

const accounts: Account[] = [{ id: 'main', label: 'main', email: 'm@x.com', order: 1 }]

function deps(overrides: Partial<StatusDeps> = {}): StatusDeps {
  return {
    accounts,
    color: false,
    width: 80,
    now: NOW,
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
  })

  test('emits parseable JSON with --json', async () => {
    const { io, out } = captureIo()
    await runStatus({ json: true }, deps(), io)
    const parsed = JSON.parse(out.join(''))
    expect(parsed[0]!.id).toBe('main')
    expect(parsed[0]!.fiveHourPct).toBe(12)
    expect(parsed[0]!.state).toBe('warm')
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
  })
})
