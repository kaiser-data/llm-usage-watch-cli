import { describe, expect, test } from 'bun:test'
import { runDoctor, type DoctorDeps } from '../src/commands/doctor'
import { CredentialError } from '../src/credentials'
import type { Account, UsageWindows } from '../src/types'

const WINDOWS: UsageWindows = {
  fiveHourPct: 10,
  fiveHourResetsAt: new Date('2026-08-03T12:00:00Z'),
  weeklyPct: 20,
  weeklyResetsAt: null,
  opusWeeklyPct: null,
}

const accounts: Account[] = [{ id: 'main', label: 'main', email: 'm@x.com', order: 1 }]

function captureIo() {
  const out: string[] = []
  return { io: { out: (t: string) => out.push(t), err: (t: string) => out.push(t) }, out }
}

function deps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    accounts,
    claudeOnPath: async () => true,
    usage: {
      keychain: { get: async () => 'tok', set: async () => {}, remove: async () => {} },
      fetchWindows: async () => WINDOWS,
      probeWindows: async () => WINDOWS,
    },
    ...overrides,
  }
}

describe('runDoctor', () => {
  test('reports a healthy account and its data path', async () => {
    const { io, out } = captureIo()
    expect(await runDoctor(deps(), io)).toBe(0)
    expect(out.join('')).toContain('main')
    expect(out.join('')).toContain('api')
  })

  // Doctor is the command a user reaches for *because* a credential is broken.
  // It has to survive one, not die on it.
  test('reports a rejected refresh token instead of throwing', async () => {
    const { io, out } = captureIo()
    const code = await runDoctor(deps({ usage: {
      keychain: {
        get: async () => {
          throw new CredentialError('refresh token expired or rejected (HTTP 400)', 'refresh-rejected')
        },
        set: async () => {},
        remove: async () => {},
      },
      fetchWindows: async () => WINDOWS,
      probeWindows: async () => WINDOWS,
    } }), io)
    expect(code).toBe(2)
    expect(out.join('')).toContain('refresh token expired')
  })

  test('flags the probe downgrade', async () => {
    const { io, out } = captureIo()
    await runDoctor(deps({ usage: {
      keychain: { get: async () => 'tok', set: async () => {}, remove: async () => {} },
      fetchWindows: async () => { throw new Error('schema') },
      probeWindows: async () => WINDOWS,
    } }), io)
    expect(out.join('')).toContain('probe')
  })

  test('reports a missing claude binary and exits non-zero', async () => {
    const { io, out } = captureIo()
    expect(await runDoctor(deps({ claudeOnPath: async () => false }), io)).toBe(2)
    expect(out.join('')).toMatch(/claude.*not found/i)
  })

  test('exits 2 when an account has no token', async () => {
    const { io } = captureIo()
    expect(await runDoctor(deps({ usage: {
      keychain: { get: async () => null, set: async () => {}, remove: async () => {} },
      fetchWindows: async () => WINDOWS,
      probeWindows: async () => WINDOWS,
    } }), io)).toBe(2)
  })

  test('exits 2 and points at add when no accounts are configured', async () => {
    const { io, out } = captureIo()
    expect(await runDoctor(deps({ accounts: [] }), io)).toBe(2)
    expect(out.join('')).toMatch(/cuw add/)
  })

  test('never prints a token', async () => {
    const { io, out } = captureIo()
    await runDoctor(deps(), io)
    expect(out.join('')).not.toContain('tok')
  })
})
