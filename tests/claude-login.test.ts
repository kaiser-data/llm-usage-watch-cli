import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createIsolatedLogin, isolatedCredentialService } from '../src/claude-login'
import type { Runner } from '../src/keychain'

describe('isolatedCredentialService', () => {
  test('appends the first eight hex digits of the directory hash', () => {
    const service = isolatedCredentialService('/tmp/x')
    expect(service).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/)
    expect(service).toBe(`Claude Code-credentials-${new Bun.CryptoHasher('sha256').update('/tmp/x').digest('hex').slice(0, 8)}`)
  })
})

function fakeSecurity(items: Map<string, string>): { run: Runner; calls: string[][] } {
  const calls: string[][] = []
  const run: Runner = async argv => {
    calls.push(argv)
    const service = argv[argv.indexOf('-s') + 1]!
    if (argv[1] === 'find-generic-password') {
      const value = items.get(service)
      return value === undefined
        ? { code: 44, stdout: '', stderr: '' }
        : { code: 0, stdout: `${value}\n`, stderr: '' }
    }
    if (argv[1] === 'delete-generic-password') {
      const had = items.delete(service)
      return { code: had ? 0 : 44, stdout: '', stderr: '' }
    }
    return { code: 1, stdout: '', stderr: '' }
  }
  return { run, calls }
}

describe('createIsolatedLogin', () => {
  test('runs claude auth login in the throwaway profile and returns its credential', async () => {
    const configDir = join(await mkdtemp(join(tmpdir(), 'cuw-iso-')), 'login')
    const service = isolatedCredentialService(configDir)
    const items = new Map<string, string>()
    const { run } = fakeSecurity(items)
    let seen: { argv: string[]; env: Record<string, string> } | null = null

    const signIn = createIsolatedLogin({
      run,
      configDir,
      spawn: async (argv, env) => {
        seen = { argv, env }
        items.set(service, '{"claudeAiOauth":{}}')
        return 0
      },
    })

    expect(await signIn('me@example.com')).toBe('{"claudeAiOauth":{}}')
    expect(seen!.argv).toEqual(['claude', 'auth', 'login', '--claudeai', '--email', 'me@example.com'])
    expect(seen!.env.CLAUDE_CONFIG_DIR).toBe(configDir)
    expect(seen!.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(configDir)
    // Nothing of the temporary login is left behind.
    expect(items.has(service)).toBe(false)
    expect(existsSync(configDir)).toBe(false)
  })

  test('never reads or deletes the real Claude Code login', async () => {
    const configDir = join(await mkdtemp(join(tmpdir(), 'cuw-iso-')), 'login')
    const items = new Map([['Claude Code-credentials', 'live']])
    const { run, calls } = fakeSecurity(items)
    const signIn = createIsolatedLogin({ run, configDir, spawn: async () => 0 })

    await signIn()
    expect(items.get('Claude Code-credentials')).toBe('live')
    expect(calls.every(argv => argv[argv.indexOf('-s') + 1] !== 'Claude Code-credentials')).toBe(true)
  })

  test('returns null when the login is abandoned', async () => {
    const configDir = join(await mkdtemp(join(tmpdir(), 'cuw-iso-')), 'login')
    const { run } = fakeSecurity(new Map())
    const signIn = createIsolatedLogin({ run, configDir, spawn: async () => 1 })
    expect(await signIn()).toBeNull()
  })

  test('falls back to the plaintext credentials file', async () => {
    const configDir = join(await mkdtemp(join(tmpdir(), 'cuw-iso-')), 'login')
    const { run } = fakeSecurity(new Map())
    const signIn = createIsolatedLogin({
      run,
      configDir,
      spawn: async () => {
        await writeFile(join(configDir, '.credentials.json'), '{"claudeAiOauth":{"x":1}}')
        return 0
      },
    })
    expect(await signIn()).toBe('{"claudeAiOauth":{"x":1}}')
    expect(existsSync(configDir)).toBe(false)
  })

  test('drops an inherited token so the child really signs in', async () => {
    const configDir = join(await mkdtemp(join(tmpdir(), 'cuw-iso-')), 'login')
    const { run } = fakeSecurity(new Map())
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'inherited'
    let env: Record<string, string> = {}
    try {
      await createIsolatedLogin({ run, configDir, spawn: async (_, e) => { env = e; return 1 } })()
    } finally {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    }
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })
})
