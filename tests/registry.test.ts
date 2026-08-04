import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRegistry, saveRegistry, registryPath, RegistryError } from '../src/registry'

const scratch = () => mkdtemp(join(tmpdir(), 'cuw-test-'))

describe('registryPath', () => {
  test('resolves under the XDG config directory', () => {
    expect(registryPath('/Users/x')).toBe('/Users/x/.config/cuw/accounts.json')
  })
})

describe('loadRegistry', () => {
  test('returns an empty list when the file does not exist', async () => {
    const dir = await scratch()
    expect(await loadRegistry(join(dir, 'accounts.json'))).toEqual([])
  })

  test('returns accounts sorted by order', async () => {
    const dir = await scratch()
    const path = join(dir, 'accounts.json')
    await writeFile(path, JSON.stringify([
      { id: 'b', label: 'B', email: 'b@x.com', order: 2 },
      { id: 'a', label: 'A', email: 'a@x.com', order: 1 },
    ]))
    const accounts = await loadRegistry(path)
    expect(accounts.map(a => a.id)).toEqual(['a', 'b'])
  })

  test('throws a malformed RegistryError on invalid JSON', async () => {
    const dir = await scratch()
    const path = join(dir, 'accounts.json')
    await writeFile(path, '{ not json')
    expect(loadRegistry(path)).rejects.toThrow(RegistryError)
  })

  test('throws when an entry is missing a required field', async () => {
    const dir = await scratch()
    const path = join(dir, 'accounts.json')
    await writeFile(path, JSON.stringify([{ id: 'a', label: 'A' }]))
    expect(loadRegistry(path)).rejects.toThrow(/missing/i)
  })

  test('throws on duplicate ids', async () => {
    const dir = await scratch()
    const path = join(dir, 'accounts.json')
    await writeFile(path, JSON.stringify([
      { id: 'a', label: 'A', email: 'a@x.com', order: 1 },
      { id: 'a', label: 'A2', email: 'a2@x.com', order: 2 },
    ]))
    expect(loadRegistry(path)).rejects.toThrow(/duplicate/i)
  })
})

describe('saveRegistry', () => {
  test('creates the parent directory and round-trips', async () => {
    const dir = await scratch()
    const path = join(dir, 'nested', 'accounts.json')
    const accounts = [{ id: 'a', label: 'A', email: 'a@x.com', order: 1 }]
    await saveRegistry(path, accounts)
    expect(await loadRegistry(path)).toEqual(accounts)
  })

  test('rejects ids that are not slug-safe', async () => {
    const dir = await scratch()
    const path = join(dir, 'accounts.json')
    expect(saveRegistry(path, [{ id: 'bad id!', label: 'X', email: 'x@x.com', order: 1 }]))
      .rejects.toThrow(/invalid id/i)
  })
})

describe('account uuid', () => {
  test('preserves an account uuid across a save and load', async () => {
    const path = join(await scratch(), 'accounts.json')
    await saveRegistry(path, [
      { id: 'main', label: 'main', email: 'a@b.c', order: 1, uuid: 'acc-123' },
    ])
    expect((await loadRegistry(path))[0]?.uuid).toBe('acc-123')
  })

  test('accepts an account without a uuid', async () => {
    const path = join(await scratch(), 'accounts.json')
    await saveRegistry(path, [{ id: 'main', label: 'main', email: '', order: 1 }])
    expect((await loadRegistry(path))[0]?.uuid).toBeUndefined()
  })

  test('rejects a non-string uuid', async () => {
    const path = join(await scratch(), 'accounts.json')
    await writeFile(path, JSON.stringify([
      { id: 'main', label: 'main', email: '', order: 1, uuid: 7 },
    ]), 'utf8')
    await expect(loadRegistry(path)).rejects.toThrow(RegistryError)
  })
})
