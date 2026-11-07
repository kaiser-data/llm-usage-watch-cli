import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runLogin, type LoginDeps } from '../src/commands/login'
import { REQUIRED_SCOPE } from '../src/constants'
import { loadRegistry } from '../src/registry'
import type { Identity } from '../src/profile'

const EXPIRES_AT = new Date('2099-01-01T00:00:00Z').getTime()

function loginBlob(accessToken: string): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken,
      refreshToken: `refresh-${accessToken}`,
      expiresAt: EXPIRES_AT,
      scopes: ['user:inference', REQUIRED_SCOPE],
    },
  })
}

const PEOPLE: Record<string, Identity> = {
  'tok-main': { uuid: 'uuid-main', email: 'main@example.com' },
  'tok-work': { uuid: 'uuid-work', email: 'work@example.com' },
  'tok-other': { uuid: 'uuid-other', email: 'other@example.com' },
}

function captureIo() {
  const out: string[] = []
  const err: string[] = []
  return { io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) }, out, err }
}

async function deps(
  registry: unknown[],
  overrides: Partial<LoginDeps> & { signInAs?: string[] } = {},
): Promise<LoginDeps & { stored: Map<string, string>; emailsOffered: (string | undefined)[] }> {
  const dir = await mkdtemp(join(tmpdir(), 'cuw-login-'))
  const registryFile = join(dir, 'accounts.json')
  await writeFile(registryFile, JSON.stringify(registry))
  const stored = new Map<string, string>()
  const emailsOffered: (string | undefined)[] = []
  const queue = [...(overrides.signInAs ?? [])]
  return {
    stored,
    emailsOffered,
    registryFile,
    keychain: {
      get: async id => stored.get(id) ?? null,
      set: async (id, value) => { stored.set(id, value) },
      remove: async id => { stored.delete(id) },
    },
    signIn: async email => {
      emailsOffered.push(email)
      const token = queue.shift()
      return token === undefined ? null : loginBlob(token)
    },
    fetchIdentity: async token => PEOPLE[token] ?? null,
    needsLogin: async () => true,
    ...overrides,
  }
}

const MAIN = { id: 'main', label: 'main', email: 'main@example.com', order: 1, uuid: 'uuid-main' }
const WORK = { id: 'work', label: 'Work', email: 'work@example.com', order: 2, uuid: 'uuid-work' }

describe('runLogin', () => {
  test('signs a named account in, pre-filling its email, and keeps its row', async () => {
    const { io } = captureIo()
    const d = await deps([MAIN, WORK], { signInAs: ['tok-work'] })

    expect(await runLogin(['work'], d, io)).toBe(0)
    expect(d.emailsOffered).toEqual(['work@example.com'])
    expect(JSON.parse(d.stored.get('work')!).accessToken).toBe('tok-work')
    expect(await loadRegistry(d.registryFile)).toEqual([MAIN, WORK])
  })

  test('with no ids, signs in only the accounts that need it', async () => {
    const { io, out } = captureIo()
    const d = await deps([MAIN, WORK], {
      signInAs: ['tok-work'],
      needsLogin: async id => id === 'work',
    })

    expect(await runLogin([], d, io)).toBe(0)
    expect(d.emailsOffered).toEqual(['work@example.com'])
    expect(d.stored.has('main')).toBe(false)
    expect(out.join('\n')).toContain('1 of 2 accounts need a fresh sign-in: work')
  })

  test('with no ids and nothing dead, does not open a browser', async () => {
    const { io, out } = captureIo()
    const d = await deps([MAIN, WORK], { needsLogin: async () => false })

    expect(await runLogin([], d, io)).toBe(0)
    expect(d.emailsOffered).toEqual([])
    expect(out.join('\n')).toContain('nothing to do')
  })

  test('refuses a sign-in into the wrong subscription and stores nothing', async () => {
    const { io, err } = captureIo()
    const d = await deps([MAIN, WORK], { signInAs: ['tok-other'] })

    expect(await runLogin(['work'], d, io)).toBe(2)
    expect(d.stored.size).toBe(0)
    expect(err.join('\n')).toContain('signed in as other@example.com')
    expect(err.join('\n')).toContain('work@example.com')
  })

  test('carries on after one failure and reports what is left', async () => {
    const { io, err } = captureIo()
    const d = await deps([MAIN, WORK], { signInAs: ['tok-other', 'tok-work'] })

    expect(await runLogin(['main', 'work'], d, io)).toBe(2)
    expect(d.stored.has('main')).toBe(false)
    expect(d.stored.has('work')).toBe(true)
    expect(err.join('\n')).toContain('cuw login main')
  })

  test('adds a new account under a fresh id', async () => {
    const { io } = captureIo()
    const d = await deps([MAIN], { signInAs: ['tok-work'] })

    expect(await runLogin(['work'], d, io)).toBe(0)
    expect(d.emailsOffered).toEqual([undefined])
    const registry = await loadRegistry(d.registryFile)
    expect(registry.map(a => [a.id, a.uuid, a.order])).toEqual([['main', 'uuid-main', 1], ['work', 'uuid-work', 2]])
  })

  test('refuses to add a subscription already configured under another id', async () => {
    const { io, err } = captureIo()
    const d = await deps([MAIN], { signInAs: ['tok-main'] })

    expect(await runLogin(['second'], d, io)).toBe(2)
    expect(err.join('\n')).toContain('already configured as "main"')
    expect((await loadRegistry(d.registryFile)).map(a => a.id)).toEqual(['main'])
  })

  test('reports an abandoned sign-in without storing anything', async () => {
    const { io, err } = captureIo()
    const d = await deps([MAIN], { signInAs: [] })

    expect(await runLogin(['main'], d, io)).toBe(2)
    expect(d.stored.size).toBe(0)
    expect(err.join('\n')).toContain('did not complete')
  })

  test('never echoes a token', async () => {
    const { io, out, err } = captureIo()
    const d = await deps([MAIN], { signInAs: ['tok-main'] })
    await runLogin(['main'], d, io)
    expect([...out, ...err].join('\n')).not.toContain('refresh-tok-main')
  })
})
