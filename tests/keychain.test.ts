import { describe, expect, test } from 'bun:test'
import { createKeychain, type RunResult, type Runner } from '../src/keychain'
import { KEYCHAIN_SERVICE } from '../src/constants'

function fakeRunner(results: RunResult[]): { run: Runner; calls: string[][] } {
  const calls: string[][] = []
  const queue = [...results]
  const run: Runner = async argv => {
    calls.push(argv)
    return queue.shift() ?? { code: 0, stdout: '', stderr: '' }
  }
  return { run, calls }
}

describe('keychain.get', () => {
  test('returns the trimmed token on success', async () => {
    const { run } = fakeRunner([{ code: 0, stdout: 'tok-123\n', stderr: '' }])
    expect(await createKeychain(run).get('main')).toBe('tok-123')
  })

  test('queries the right service and account', async () => {
    const { run, calls } = fakeRunner([{ code: 0, stdout: 'tok\n', stderr: '' }])
    await createKeychain(run).get('main')
    expect(calls[0]).toEqual([
      'security', 'find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', 'main', '-w',
    ])
  })

  test('returns null when the item does not exist', async () => {
    const { run } = fakeRunner([
      { code: 44, stdout: '', stderr: 'SecKeychainSearchCopyNext: The specified item could not be found.' },
    ])
    expect(await createKeychain(run).get('missing')).toBeNull()
  })

  test('throws on an unexpected failure', async () => {
    const { run } = fakeRunner([{ code: 1, stdout: '', stderr: 'boom' }])
    expect(createKeychain(run).get('main')).rejects.toThrow(/keychain read failed/i)
  })
})

describe('keychain.set', () => {
  test('upserts with -U and does not leak the token into the error', async () => {
    const { run, calls } = fakeRunner([{ code: 0, stdout: '', stderr: '' }])
    await createKeychain(run).set('main', 'super-secret')
    expect(calls[0]).toContain('-U')
    expect(calls[0]).toContain(KEYCHAIN_SERVICE)
  })

  test('error message never contains the token', async () => {
    const { run } = fakeRunner([{ code: 1, stdout: '', stderr: 'failed for super-secret' }])
    let message = ''
    try {
      await createKeychain(run).set('main', 'super-secret')
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).not.toContain('super-secret')
    expect(message).toMatch(/keychain write failed/i)
  })
})

describe('keychain.remove', () => {
  test('succeeds when the item is already absent', async () => {
    const { run } = fakeRunner([{ code: 44, stdout: '', stderr: 'not found' }])
    await createKeychain(run).remove('gone')
  })
})
