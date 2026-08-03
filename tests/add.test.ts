import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAdd, type AddDeps } from '../src/commands/add'
import { loadRegistry } from '../src/registry'

function captureIo() {
  const out: string[] = []
  return { io: { out: (t: string) => out.push(t), err: (t: string) => out.push(t) }, out }
}

async function deps(overrides: Partial<AddDeps> = {}): Promise<AddDeps> {
  const dir = await mkdtemp(join(tmpdir(), 'cuw-add-'))
  const stored = new Map<string, string>()
  return {
    registryFile: join(dir, 'accounts.json'),
    keychain: {
      get: async id => stored.get(id) ?? null,
      set: async (id, token) => { stored.set(id, token) },
      remove: async id => { stored.delete(id) },
    },
    readToken: async () => 'sk-ant-oat01-example',
    verify: async () => {},
    ...overrides,
  }
}

describe('runAdd', () => {
  test('stores the token and appends the account', async () => {
    const { io } = captureIo()
    const d = await deps()
    expect(await runAdd('main', d, io)).toBe(0)
    const accounts = await loadRegistry(d.registryFile)
    expect(accounts.map(a => a.id)).toEqual(['main'])
    expect(await d.keychain.get('main')).toBe('sk-ant-oat01-example')
  })

  test('never echoes the token', async () => {
    const { io, out } = captureIo()
    await runAdd('main', await deps(), io)
    expect(out.join('')).not.toContain('sk-ant-oat01-example')
  })

  test('rejects an empty token without writing anything', async () => {
    const { io } = captureIo()
    const d = await deps({ readToken: async () => '  ' })
    expect(await runAdd('main', d, io)).toBe(1)
    expect(await loadRegistry(d.registryFile)).toEqual([])
  })

  test('does not store a token that fails verification', async () => {
    const { io } = captureIo()
    const d = await deps({ verify: async () => { throw new Error('token rejected (HTTP 401)') } })
    expect(await runAdd('main', d, io)).toBe(2)
    expect(await d.keychain.get('main')).toBeNull()
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
    const accounts = await loadRegistry(d.registryFile)
    expect(accounts.map(a => a.order)).toEqual([1, 2])
  })
})
