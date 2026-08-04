import { describe, expect, test } from 'bun:test'
import {
  collectCodexUsage,
  type CodexAppServerProcess,
} from '../src/codex-app-server'

const encoder = new TextEncoder()

function processWithChunks(chunks: string[], exitCode = 0) {
  const writes: unknown[] = []
  let killed = false
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  const process: CodexAppServerProcess = {
    stdout,
    write(message) { writes.push(message) },
    exited: Promise.resolve(exitCode),
    kill() { killed = true },
  }
  return { process, writes, wasKilled: () => killed }
}

describe('collectCodexUsage', () => {
  test('performs the handshake and ignores unrelated notifications', async () => {
    const fake = processWithChunks([
      '{"id":0,"result":{"userAgent":"codex"}}\n',
      '{"method":"account/updated","params":{"planType":"plus"}}\n',
      '{"id":1,"result":{"rateLimits":{"limitId":"codex","planType":"plus",',
      '"primary":{"usedPercent":73,"windowDurationMins":10080,"resetsAt":1786175144},',
      '"secondary":null}}}\n',
    ])

    const result = await collectCodexUsage({ spawn: () => fake.process, timeoutMs: 100 })

    expect(result.limits[0]!.windows[0]!.usedPct).toBe(73)
    expect(fake.writes).toEqual([
      {
        method: 'initialize',
        id: 0,
        params: { clientInfo: { name: 'cuw', title: 'LLM Usage Watch', version: '0.1.0' } },
      },
      { method: 'initialized', params: {} },
      { method: 'account/rateLimits/read', id: 1 },
    ])
    expect(fake.wasKilled()).toBe(true)
  })

  test('times out and kills a silent app-server', async () => {
    let killed = false
    const process: CodexAppServerProcess = {
      stdout: new ReadableStream<Uint8Array>(),
      write() {},
      exited: new Promise<number>(() => {}),
      kill() { killed = true },
    }

    const result = await collectCodexUsage({ spawn: () => process, timeoutMs: 5 })

    expect(result.error?.cause).toBe('timeout')
    expect(killed).toBe(true)
  })

  test('reports a missing executable safely', async () => {
    const result = await collectCodexUsage({
      spawn() {
        const error = new Error('spawn codex') as NodeJS.ErrnoException
        error.code = 'ENOENT'
        throw error
      },
      timeoutMs: 100,
    })

    expect(result.error?.cause).toBe('not-installed')
    expect(result.error?.message).toContain('PATH')
  })

  test('does not expose a raw server error', async () => {
    const fake = processWithChunks([
      '{"id":0,"result":{}}\n',
      '{"id":1,"error":{"code":401,"message":"secret-account-value"}}\n',
    ])

    const result = await collectCodexUsage({ spawn: () => fake.process, timeoutMs: 100 })

    expect(result.error?.cause).toBe('not-logged-in')
    expect(JSON.stringify(result)).not.toContain('secret-account-value')
    expect(fake.wasKilled()).toBe(true)
  })

  test('classifies invalid JSON as a protocol error', async () => {
    const fake = processWithChunks(['not-json\n'])

    const result = await collectCodexUsage({ spawn: () => fake.process, timeoutMs: 100 })

    expect(result.error).toEqual({
      cause: 'protocol',
      message: 'Codex app-server returned invalid JSON',
    })
    expect(fake.wasKilled()).toBe(true)
  })

  test('classifies an early child exit as a process failure', async () => {
    const fake = processWithChunks([
      '{"id":0,"result":{}}\n',
    ], 9)

    const result = await collectCodexUsage({ spawn: () => fake.process, timeoutMs: 100 })

    expect(result.error?.cause).toBe('process')
    expect(result.error?.message).toBe('Codex app-server exited early')
    expect(fake.wasKilled()).toBe(true)
  })

  test('maps a malformed rate-limit result to a safe protocol error', async () => {
    const fake = processWithChunks([
      '{"id":0,"result":{}}\n',
      '{"id":1,"result":{"unexpected":"secret-payload-value"}}\n',
    ])

    const result = await collectCodexUsage({ spawn: () => fake.process, timeoutMs: 100 })

    expect(result.error?.cause).toBe('protocol')
    expect(JSON.stringify(result)).not.toContain('secret-payload-value')
  })

  test('does not reject when cleanup of an exited child throws', async () => {
    const fake = processWithChunks([
      '{"id":0,"result":{}}\n',
      '{"id":1,"result":{"rateLimits":{"limitId":"codex","planType":"plus",',
      '"primary":{"usedPercent":7,"windowDurationMins":60,"resetsAt":null},',
      '"secondary":null}}}\n',
    ])
    fake.process.kill = () => { throw new Error('already gone') }

    const result = await collectCodexUsage({ spawn: () => fake.process, timeoutMs: 100 })

    expect(result.error).toBeNull()
    expect(result.limits[0]!.windows[0]!.usedPct).toBe(7)
  })
})
