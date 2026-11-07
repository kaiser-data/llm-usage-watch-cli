import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REQUIRED_SCOPE } from '../src/constants'
import { parseCredential, serializeCredential } from '../src/credentials'
import { syncLiveLogin, type SyncDeps } from '../src/live-sync'
import type { LoginBlob } from '../src/login'
import type { Identity } from '../src/profile'
import { loadRegistry } from '../src/registry'

const NOW = new Date('2026-11-07T12:00:00Z').getTime()

function oauth(access: string, refresh: string, expiresAt = NOW + 3_600_000) {
  return { accessToken: access, refreshToken: refresh, expiresAt, scopes: ['user:inference', REQUIRED_SCOPE], subscriptionType: 'pro' }
}

const MAIN = { id: 'main', label: 'Main', email: 'main@example.com', order: 1, uuid: 'uuid-main' }
const WORK = { id: 'work', label: 'work', email: 'work@example.com', order: 2, uuid: 'uuid-work' }

async function setup(opts: {
  registry: unknown[]
  live: LoginBlob | null
  stored?: Record<string, string>
  identity?: Identity | null
}) {
  const dir = await mkdtemp(join(tmpdir(), 'cuw-sync-'))
  const registryFile = join(dir, 'accounts.json')
  await writeFile(registryFile, JSON.stringify(opts.registry))
  const stored = new Map(Object.entries(opts.stored ?? {}))
  const writes: LoginBlob[] = []
  let identityCalls = 0
  const deps: SyncDeps = {
    registryFile,
    keychain: {
      get: async id => stored.get(id) ?? null,
      set: async (id, value) => { stored.set(id, value) },
      remove: async id => { stored.delete(id) },
    },
    login: { read: async () => opts.live, write: async blob => { writes.push(blob) } },
    fetchIdentity: async () => { identityCalls += 1; return opts.identity ?? null },
    now: () => NOW,
  }
  return { deps, stored, writes, registryFile, identityCalls: () => identityCalls }
}

describe('syncLiveLogin', () => {
  test('updates the matching account when the live login was renewed', async () => {
    const s = await setup({
      registry: [MAIN, WORK],
      live: { claudeAiOauth: oauth('a-new', 'r-new'), mcpOAuth: { x: 1 } },
      stored: { work: serializeCredential(parseCredential(JSON.stringify({ claudeAiOauth: oauth('a-old', 'r-old') }))) },
      identity: { uuid: 'uuid-work', email: 'work@example.com' },
    })

    expect(await syncLiveLogin(s.deps)).toEqual({ kind: 'updated', ids: ['work'], email: 'work@example.com' })
    const saved = parseCredential(s.stored.get('work')!)
    expect(saved.refreshToken).toBe('r-new')
    expect(saved.raw.subscriptionType).toBe('pro')
    // The MCP tokens in the live item are not copied into cuw.
    expect(s.stored.get('work')).not.toContain('mcpOAuth')
    expect(s.stored.has('main')).toBe(false)
    expect((await loadRegistry(s.registryFile)).map(a => a.label)).toEqual(['Main', 'work'])
  })

  test('costs no network when the stored copy is already current', async () => {
    const live = { claudeAiOauth: oauth('a-1', 'r-1') }
    const s = await setup({
      registry: [MAIN],
      live,
      stored: { main: serializeCredential(parseCredential(JSON.stringify(live))) },
    })

    expect(await syncLiveLogin(s.deps)).toEqual({ kind: 'unchanged', ids: ['main'] })
    expect(s.identityCalls()).toBe(0)
  })

  test('adds an untracked login under an id from its email', async () => {
    const s = await setup({
      registry: [MAIN],
      live: { claudeAiOauth: oauth('a-1', 'r-1') },
      identity: { uuid: 'uuid-new', email: 'Fresh.Person@example.com' },
    })

    expect(await syncLiveLogin(s.deps)).toEqual({ kind: 'added', id: 'fresh-person', email: 'Fresh.Person@example.com' })
    const registry = await loadRegistry(s.registryFile)
    expect(registry.map(a => [a.id, a.order, a.uuid])).toEqual([['main', 1, 'uuid-main'], ['fresh-person', 2, 'uuid-new']])
    expect(s.stored.has('fresh-person')).toBe(true)
  })

  test('refreshes every duplicate entry of the same subscription', async () => {
    const twin = { ...WORK, id: 'work-2', order: 3 }
    const s = await setup({
      registry: [MAIN, WORK, twin],
      live: { claudeAiOauth: oauth('a-1', 'r-1') },
      identity: { uuid: 'uuid-work', email: 'work@example.com' },
    })

    const result = await syncLiveLogin(s.deps)
    expect(result.kind).toBe('updated')
    expect(s.stored.has('work')).toBe(true)
    expect(s.stored.has('work-2')).toBe(true)
  })

  test('matches a pre-identity entry by email', async () => {
    const legacy = { id: 'old', label: 'old', email: 'old@example.com', order: 1 }
    const s = await setup({
      registry: [legacy],
      live: { claudeAiOauth: oauth('a-1', 'r-1') },
      identity: { uuid: 'uuid-old', email: 'old@example.com' },
    })

    expect(await syncLiveLogin(s.deps)).toEqual({ kind: 'updated', ids: ['old'], email: 'old@example.com' })
    expect((await loadRegistry(s.registryFile))[0]?.uuid).toBe('uuid-old')
  })

  test('never refreshes or writes the live login', async () => {
    const s = await setup({
      registry: [MAIN],
      live: { claudeAiOauth: oauth('a-1', 'r-1', NOW - 1) },
      identity: { uuid: 'uuid-main', email: 'main@example.com' },
    })

    expect((await syncLiveLogin(s.deps)).kind).toBe('skipped')
    expect(s.writes).toEqual([])
    expect(s.stored.size).toBe(0)
  })

  test('stores nothing when the live login cannot be identified', async () => {
    const s = await setup({ registry: [MAIN], live: { claudeAiOauth: oauth('a-1', 'r-1') }, identity: null })
    expect((await syncLiveLogin(s.deps)).kind).toBe('skipped')
    expect(s.stored.size).toBe(0)
  })

  test('reports a machine with no login', async () => {
    const s = await setup({ registry: [MAIN], live: null })
    expect(await syncLiveLogin(s.deps)).toEqual({ kind: 'no-login' })
  })
})
