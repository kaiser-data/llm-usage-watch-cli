import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runRm, type RmDeps } from '../src/commands/rm'
import { loadRegistry, saveRegistry } from '../src/registry'

function captureIo() {
  const out: string[] = []
  return { io: { out: (t: string) => out.push(t), err: (t: string) => out.push(t) }, out }
}

async function deps(confirmValue = true): Promise<RmDeps & { stored: Map<string, string> }> {
  const dir = await mkdtemp(join(tmpdir(), 'cuw-rm-'))
  const registryFile = join(dir, 'accounts.json')
  await saveRegistry(registryFile, [{ id: 'main', label: 'main', email: 'm@x.com', order: 1 }])
  const stored = new Map([['main', 'tok']])
  return {
    registryFile,
    stored,
    keychain: {
      get: async id => stored.get(id) ?? null,
      set: async (id, token) => { stored.set(id, token) },
      remove: async id => { stored.delete(id) },
    },
    confirm: async () => confirmValue,
  }
}

describe('runRm', () => {
  test('removes the registry entry and the keychain item', async () => {
    const { io } = captureIo()
    const d = await deps()
    expect(await runRm('main', d, io)).toBe(0)
    expect(await loadRegistry(d.registryFile)).toEqual([])
    expect(d.stored.has('main')).toBe(false)
  })

  test('does nothing when the confirmation is declined', async () => {
    const { io } = captureIo()
    const d = await deps(false)
    expect(await runRm('main', d, io)).toBe(0)
    expect((await loadRegistry(d.registryFile)).length).toBe(1)
    expect(d.stored.has('main')).toBe(true)
  })

  test('reports an unknown id', async () => {
    const { io, out } = captureIo()
    const d = await deps()
    expect(await runRm('nope', d, io)).toBe(1)
    expect(out.join('')).toMatch(/not configured/i)
  })
})
