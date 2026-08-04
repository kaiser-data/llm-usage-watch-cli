import { describe, expect, test } from 'bun:test'
import { LoginError, createLoginStore, mergeLogin } from '../src/login'
import { CLAUDE_CREDENTIAL_SERVICE } from '../src/constants'
import type { RunResult, Runner } from '../src/keychain'
import type { Credential } from '../src/types'

const CREDENTIAL: Credential = {
  accessToken: 'access-new',
  refreshToken: 'refresh-new',
  expiresAt: 42,
  scopes: ['user:profile'],
  raw: { accessToken: 'access-new', refreshToken: 'refresh-new', subscriptionType: 'pro' },
}

const LIVE = {
  mcpOAuth: { 'notion|abc': { accessToken: 'mcp-secret' } },
  claudeAiOauth: { accessToken: 'access-old', subscriptionType: 'max' },
  somethingAnthropicAddedLater: { keep: true },
}

function ok(stdout: string): RunResult {
  return { code: 0, stdout, stderr: '' }
}

describe('mergeLogin', () => {
  test('preserves the MCP server tokens', () => {
    expect(mergeLogin(LIVE, CREDENTIAL).mcpOAuth).toEqual(LIVE.mcpOAuth)
  })

  test('preserves unknown top-level keys', () => {
    expect(mergeLogin(LIVE, CREDENTIAL).somethingAnthropicAddedLater).toEqual({ keep: true })
  })

  test('replaces only the login branch, verbatim', () => {
    expect(mergeLogin(LIVE, CREDENTIAL).claudeAiOauth).toEqual(CREDENTIAL.raw)
  })

  test('does not mutate the live blob', () => {
    mergeLogin(LIVE, CREDENTIAL)
    expect(LIVE.claudeAiOauth.accessToken).toBe('access-old')
  })

  test('refuses a legacy credential', () => {
    expect(() => mergeLogin(LIVE, { ...CREDENTIAL, raw: {} })).toThrow(LoginError)
  })
})

describe('createLoginStore', () => {
  test('reads and parses the login item', async () => {
    const run: Runner = async () => ok(JSON.stringify(LIVE))
    expect(await createLoginStore(run).read()).toEqual(LIVE)
  })

  test('returns null when no login item exists', async () => {
    const run: Runner = async () => ({ code: 44, stdout: '', stderr: '' })
    expect(await createLoginStore(run).read()).toBeNull()
  })

  test('throws when the item is not valid JSON', async () => {
    const run: Runner = async () => ok('not json')
    await expect(createLoginStore(run).read()).rejects.toThrow(LoginError)
  })

  test('throws when the item is a JSON array rather than an object', async () => {
    const run: Runner = async () => ok('[1,2]')
    await expect(createLoginStore(run).read()).rejects.toThrow(LoginError)
  })

  test('writes under the account name read from the item attributes', async () => {
    const calls: string[][] = []
    const run: Runner = async argv => {
      calls.push(argv)
      if (argv[1] === 'find-generic-password') return ok('    "acct"<blob>="marty"\n')
      return ok('')
    }

    await createLoginStore(run).write({ a: 1 })
    const write = calls.find(argv => argv[1] === 'add-generic-password')
    expect(write?.[write.indexOf('-a') + 1]).toBe('marty')
    expect(write?.[write.indexOf('-s') + 1]).toBe(CLAUDE_CREDENTIAL_SERVICE)
    expect(write).toContain('-U')
    expect(write?.[write.indexOf('-w') + 1]).toBe('{"a":1}')
  })

  test('throws when the write fails', async () => {
    const run: Runner = async argv =>
      argv[1] === 'add-generic-password'
        ? { code: 1, stdout: '', stderr: 'secret material' }
        : ok('    "acct"<blob>="marty"\n')

    await expect(createLoginStore(run).write({ a: 1 })).rejects.toThrow(LoginError)
  })

  test('does not leak security stderr into the error message', async () => {
    const run: Runner = async argv =>
      argv[1] === 'add-generic-password'
        ? { code: 1, stdout: '', stderr: 'secret material' }
        : ok('    "acct"<blob>="marty"\n')

    let message = ''
    try {
      await createLoginStore(run).write({ a: 1 })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).not.toContain('secret material')
  })
})
