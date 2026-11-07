import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runUse, type UseDeps } from '../src/commands/use'
import { parseCredential, serializeCredential } from '../src/credentials'
import { loadRegistry, saveRegistry } from '../src/registry'
import { REQUIRED_SCOPE } from '../src/constants'
import type { Keychain } from '../src/keychain'
import type { LoginBlob, LoginStore } from '../src/login'
import type { Account, UsageWindows } from '../src/types'

const FUTURE = new Date('2099-01-01T00:00:00Z')

function loginBranch(accessToken: string): Record<string, unknown> {
  return {
    accessToken,
    refreshToken: `${accessToken}-refresh`,
    expiresAt: FUTURE.getTime(),
    scopes: [REQUIRED_SCOPE],
    subscriptionType: 'pro',
  }
}

function storedCredential(accessToken: string): string {
  return serializeCredential(
    parseCredential(JSON.stringify({ claudeAiOauth: loginBranch(accessToken) })),
  )
}

const ACCOUNTS: Account[] = [
  { id: 'main', label: 'main', email: 'main@x.c', order: 1, uuid: 'uuid-main' },
  { id: 'spare', label: 'spare', email: 'spare@x.c', order: 2, uuid: 'uuid-spare' },
]

function windows(fiveHourPct: number, weeklyPct: number): UsageWindows {
  return {
    fiveHourPct,
    fiveHourResetsAt: FUTURE,
    weeklyPct,
    weeklyResetsAt: FUTURE,
    opusWeeklyPct: null,
  }
}

function captureIo() {
  const lines: string[] = []
  return { io: { out: (t: string) => lines.push(t), err: (t: string) => lines.push(t) }, lines }
}

function fakeKeychain(initial: Record<string, string>): Keychain {
  const store = new Map(Object.entries(initial))
  return {
    get: async id => store.get(id) ?? null,
    set: async (id, value) => { store.set(id, value) },
    remove: async id => { store.delete(id) },
  }
}

function fakeLogin(initial: LoginBlob | null): LoginStore {
  let current = initial
  return {
    read: async () => current,
    write: async blob => { current = blob },
  }
}

/** The access token currently installed in the login branch. */
async function activeToken(login: LoginStore): Promise<unknown> {
  const blob = await login.read()
  return (blob?.claudeAiOauth as Record<string, unknown> | undefined)?.accessToken
}

/** main is spent, spare is fresh — so `recommend()` picks spare. */
function baseDeps(overrides: Partial<UseDeps> = {}): UseDeps {
  return {
    registryFile: '',
    accounts: ACCOUNTS,
    usage: {
      keychain: fakeKeychain({ main: 'token-main', spare: 'token-spare' }),
      fetchWindows: async (token: string) =>
        token === 'token-main' ? windows(100, 90) : windows(0, 10),
      probeWindows: async () => windows(0, 0),
    },
    keychain: fakeKeychain({
      main: storedCredential('a-main'),
      spare: storedCredential('a-spare'),
    }),
    login: fakeLogin({
      mcpOAuth: { 'notion|abc': { accessToken: 'mcp-secret' } },
      claudeAiOauth: loginBranch('a-main'),
    }),
    fetchIdentity: async () => ({ uuid: 'uuid-main', email: 'main@x.c' }),
    ...overrides,
  }
}

describe('runUse', () => {
  test('switches to the recommended account when given no id', async () => {
    const { io, lines } = captureIo()
    const deps = baseDeps()

    expect(await runUse(undefined, deps, io)).toBe(0)
    expect(lines.join('\n')).toContain('main → spare')
    expect(await activeToken(deps.login)).toBe('a-spare')
  })

  test('preserves the MCP tokens through the switch', async () => {
    const { io } = captureIo()
    const deps = baseDeps()

    await runUse('spare', deps, io)
    expect((await deps.login.read())?.mcpOAuth)
      .toEqual({ 'notion|abc': { accessToken: 'mcp-secret' } })
  })

  test('does nothing when the target is already active', async () => {
    const { io, lines } = captureIo()
    const deps = baseDeps()

    expect(await runUse('main', deps, io)).toBe(0)
    expect(lines.join('\n')).toContain('already on')
    expect(await activeToken(deps.login)).toBe('a-main')
  })

  test('rejects an unknown account id', async () => {
    const { io, lines } = captureIo()
    expect(await runUse('nope', baseDeps(), io)).toBe(2)
    expect(lines.join('\n')).toContain('unknown account')
  })

  test('refuses a legacy credential without writing', async () => {
    const { io, lines } = captureIo()
    const deps = baseDeps({
      keychain: fakeKeychain({
        main: storedCredential('a-main'),
        spare: JSON.stringify({
          accessToken: 'a-spare',
          refreshToken: 'r',
          expiresAt: FUTURE.getTime(),
          scopes: [REQUIRED_SCOPE],
        }),
      }),
    })

    expect(await runUse('spare', deps, io)).toBe(2)
    // The remedy must name the failing account, so the user can run it as-is.
    expect(lines.join('\n')).toContain('cuw login spare')
    expect(lines.join('\n')).not.toMatch(/cuw add (?!--force)/)
    expect(await activeToken(deps.login)).toBe('a-main')
  })

  test('aborts when the active login cannot be identified', async () => {
    const { io, lines } = captureIo()
    const deps = baseDeps({ fetchIdentity: async () => null })

    expect(await runUse('spare', deps, io)).toBe(2)
    expect(lines.join('\n')).toContain('cannot identify')
    expect(await activeToken(deps.login)).toBe('a-main')
  })

  test('aborts when no login exists', async () => {
    const { io, lines } = captureIo()
    expect(await runUse('spare', baseDeps({ login: fakeLogin(null) }), io)).toBe(2)
    expect(lines.join('\n')).toContain('claude auth login')
  })

  test('captures an untracked login before overwriting it', async () => {
    const { io, lines } = captureIo()
    const registryFile = join(await mkdtemp(join(tmpdir(), 'cuw-use-')), 'accounts.json')
    await saveRegistry(registryFile, ACCOUNTS)

    const keychain = fakeKeychain({
      main: storedCredential('a-main'),
      spare: storedCredential('a-spare'),
    })
    const deps = baseDeps({
      registryFile,
      keychain,
      login: fakeLogin({ claudeAiOauth: loginBranch('a-other') }),
      fetchIdentity: async () => ({ uuid: 'uuid-other', email: 'work@example.com' }),
    })

    expect(await runUse('spare', deps, io)).toBe(0)
    expect(lines.join('\n')).toContain('work')
    const saved = await loadRegistry(registryFile)
    expect(saved.some(account => account.uuid === 'uuid-other')).toBe(true)
    expect(await keychain.get('work')).not.toBeNull()
    expect(await activeToken(deps.login)).toBe('a-spare')
  })

  test('refuses to capture while an account is missing a uuid', async () => {
    const { io, lines } = captureIo()
    const deps = baseDeps({
      accounts: [ACCOUNTS[0] as Account, { id: 'spare', label: 'spare', email: '', order: 2 }],
      login: fakeLogin({ claudeAiOauth: loginBranch('a-other') }),
      fetchIdentity: async () => ({ uuid: 'uuid-other', email: 'work@example.com' }),
    })

    expect(await runUse('spare', deps, io)).toBe(2)
    expect(lines.join('\n')).toContain('spare')
    expect(await activeToken(deps.login)).toBe('a-other')
  })

  test('reports a write failure as leaving nothing changed', async () => {
    const { io, lines } = captureIo()
    const deps = baseDeps({
      login: {
        read: async () => ({ claudeAiOauth: loginBranch('a-main') }),
        write: async () => { throw new Error('keychain is locked') },
      },
    })

    expect(await runUse('spare', deps, io)).toBe(1)
    expect(lines.join('\n')).toContain('nothing was changed')
  })

  test('never prints a token', async () => {
    const { io, lines } = captureIo()
    await runUse('spare', baseDeps(), io)
    expect(lines.join('\n')).not.toContain('a-spare')
  })
})
