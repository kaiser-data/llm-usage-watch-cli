import { describe, expect, test } from 'bun:test'
import { parseRateLimitHeaders, probeUsage } from '../src/usage-probe'
import { HEADER_KEYS } from '../src/constants'
import type { SpawnResult, Spawner } from '../src/spawn'

function logLine(key: string, value: string): string {
  return `[api] response header ${key}: ${value}\n`
}

const SAMPLE =
  logLine(HEADER_KEYS.fiveHourRemaining, '0.88') +
  logLine(HEADER_KEYS.fiveHourReset, '1785700000') +
  logLine(HEADER_KEYS.weeklyRemaining, '0.66') +
  logLine(HEADER_KEYS.weeklyReset, '1786100000')

describe('parseRateLimitHeaders', () => {
  test('converts remaining fraction into a used percentage', () => {
    expect(parseRateLimitHeaders(SAMPLE).fiveHourPct).toBe(12)
    expect(parseRateLimitHeaders(SAMPLE).weeklyPct).toBe(34)
  })

  test('parses epoch-second reset values into dates', () => {
    expect(parseRateLimitHeaders(SAMPLE).fiveHourResetsAt?.getTime()).toBe(1785700000 * 1000)
  })

  test('is case-insensitive about header names', () => {
    const upper = SAMPLE.toUpperCase()
    expect(parseRateLimitHeaders(upper).fiveHourPct).toBe(12)
  })

  test('returns nulls when no rate-limit headers are present', () => {
    const windows = parseRateLimitHeaders('[api] request sent\n')
    expect(windows.fiveHourPct).toBeNull()
    expect(windows.weeklyPct).toBeNull()
  })

  test('yields null opus percentage when that header is absent', () => {
    expect(parseRateLimitHeaders(SAMPLE).opusWeeklyPct).toBeNull()
  })

  test('parses the recorded fixture', async () => {
    const fixture = await Bun.file(`${import.meta.dir}/fixtures/probe-debug.log`).text()
    const windows = parseRateLimitHeaders(fixture)
    expect(windows.fiveHourPct).toBe(12)
    expect(windows.weeklyPct).toBe(34)
  })
})

describe('probeUsage', () => {
  function harness(result: SpawnResult, log: string) {
    const calls: { argv: string[]; env: Record<string, string>; cwd: string }[] = []
    const spawn: Spawner = async (argv, env, cwd) => {
      calls.push({ argv, env, cwd })
      return result
    }
    return {
      calls,
      deps: {
        spawn,
        scratchDir: '/tmp/cuw-empty',
        configDir: '/tmp/cuw-profile',
        logPath: '/tmp/cuw-debug.log',
        readLog: async () => log,
      },
    }
  }

  test('invokes claude with the minimal isolated flag set', async () => {
    const { calls, deps } = harness({ code: 0, stderrTail: '' }, SAMPLE)
    await probeUsage('tok', deps)
    const argv = calls[0].argv.join(' ')
    expect(argv).toContain('--safe-mode')
    expect(argv).toContain('--no-session-persistence')
    expect(argv).toContain('--debug api')
  })

  test('passes the token by environment, never by argv', async () => {
    const { calls, deps } = harness({ code: 0, stderrTail: '' }, SAMPLE)
    await probeUsage('sk-secret', deps)
    expect(calls[0].argv.join(' ')).not.toContain('sk-secret')
    expect(calls[0].env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-secret')
    expect(calls[0].env.CLAUDE_CONFIG_DIR).toBe('/tmp/cuw-profile')
    expect(calls[0].cwd).toBe('/tmp/cuw-empty')
  })

  test('throws when the claude invocation fails', async () => {
    const { deps } = harness({ code: 1, stderrTail: 'nope' }, '')
    expect(probeUsage('tok', deps)).rejects.toThrow(/probe failed/i)
  })

  test('failure message never contains the token', async () => {
    const { deps } = harness({ code: 1, stderrTail: 'bad token sk-secret here' }, '')
    let message = ''
    try {
      await probeUsage('sk-secret', deps)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).not.toContain('sk-secret')
  })

  test('returns parsed windows on success', async () => {
    const { deps } = harness({ code: 0, stderrTail: '' }, SAMPLE)
    expect((await probeUsage('tok', deps)).fiveHourPct).toBe(12)
  })
})
