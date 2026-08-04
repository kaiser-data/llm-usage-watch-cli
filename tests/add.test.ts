import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAdd, type AddDeps } from '../src/commands/add'
import { loadRegistry } from '../src/registry'
import { REQUIRED_SCOPE } from '../src/constants'

const EXPIRES_AT = new Date('2099-01-01T00:00:00Z').getTime()

function loginBlob(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      expiresAt: EXPIRES_AT,
      scopes: ['user:inference', REQUIRED_SCOPE],
      ...overrides,
    },
  })
}

function captureIo() {
  const out: string[] = []
  return { io: { out: (t: string) => out.push(t), err: (t: string) => out.push(t) }, out }
}

async function deps(overrides: Partial<AddDeps> = {}): Promise<AddDeps & { stored: Map<string, string> }> {
  const dir = await mkdtemp(join(tmpdir(), 'cuw-add-'))
  const stored = new Map<string, string>()
  return {
    stored,
    registryFile: join(dir, 'accounts.json'),
    keychain: {
      get: async id => stored.get(id) ?? null,
      set: async (id, value) => { stored.set(id, value) },
      remove: async id => { stored.delete(id) },
    },
    readLoginCredential: async () => loginBlob(),
    fetchIdentity: async () => ({ uuid: 'acc-existing', email: 'existing@example.com' }),
    ...overrides,
  }
}

describe('runAdd', () => {
  test('captures the current login and appends the account', async () => {
    const { io } = captureIo()
    const d = await deps()
    expect(await runAdd('main', d, io)).toBe(0)
    expect((await loadRegistry(d.registryFile)).map(a => a.id)).toEqual(['main'])
    const saved = JSON.parse(d.stored.get('main') as string)
    expect(saved.accessToken).toBe('access-secret')
    expect(saved.refreshToken).toBe('refresh-secret')
  })

  test('never echoes any token', async () => {
    const { io, out } = captureIo()
    await runAdd('main', await deps(), io)
    expect(out.join('')).not.toContain('access-secret')
    expect(out.join('')).not.toContain('refresh-secret')
  })

  test('refuses an inference-only login and explains why', async () => {
    const { io, out } = captureIo()
    const d = await deps({ readLoginCredential: async () => loginBlob({ scopes: ['user:inference'] }) })
    expect(await runAdd('main', d, io)).toBe(2)
    expect(out.join('')).toMatch(/inference-only|user:profile/i)
    expect(d.stored.size).toBe(0)
    expect(await loadRegistry(d.registryFile)).toEqual([])
  })

  test('refuses a pasted setup-token with a pointer to auth login', async () => {
    const { io, out } = captureIo()
    const d = await deps({ readLoginCredential: async () => 'sk-ant-oat01-example' })
    expect(await runAdd('main', d, io)).toBe(2)
    expect(out.join('')).toMatch(/claude auth login/i)
    expect(d.stored.size).toBe(0)
  })

  test('reports when nobody is logged in', async () => {
    const { io, out } = captureIo()
    const d = await deps({ readLoginCredential: async () => null })
    expect(await runAdd('main', d, io)).toBe(2)
    expect(out.join('')).toMatch(/claude auth login/i)
    expect(await loadRegistry(d.registryFile)).toEqual([])
  })

  test('rejects a duplicate id', async () => {
    const { io } = captureIo()
    const d = await deps()
    await runAdd('main', d, io)
    expect(await runAdd('main', d, io)).toBe(1)
  })

  test('rejects an id that is not slug-safe', async () => {
    const { io } = captureIo()
    const d = await deps()
    expect(await runAdd('bad id!', d, io)).toBe(1)
    expect(await loadRegistry(d.registryFile)).toEqual([])
  })

  test('assigns increasing order values', async () => {
    const { io } = captureIo()
    const d = await deps()
    await runAdd('one', d, io)
    await runAdd('two', d, io)
    expect((await loadRegistry(d.registryFile)).map(a => a.order)).toEqual([1, 2])
  })
})

describe('runAdd identity', () => {
  test('records the account uuid and email from the profile', async () => {
    const { io, out } = captureIo()
    const d = await deps({
      fetchIdentity: async () => ({ uuid: 'acc-123', email: 'someone@example.com' }),
    })

    expect(await runAdd('main', d, io)).toBe(0)
    const stored = await loadRegistry(d.registryFile)
    expect(stored[0]?.uuid).toBe('acc-123')
    expect(stored[0]?.email).toBe('someone@example.com')
    expect(out.join('\n')).not.toContain('access-secret')
  })

  test('refuses to store an account whose identity cannot be read', async () => {
    const { io } = captureIo()
    const d = await deps({ fetchIdentity: async () => null })

    expect(await runAdd('main', d, io)).toBe(2)
    expect(await loadRegistry(d.registryFile)).toEqual([])
    expect(d.stored.get('main')).toBeUndefined()
  })
})
