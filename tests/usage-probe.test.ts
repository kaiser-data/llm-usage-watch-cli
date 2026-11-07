import { describe, expect, test } from 'bun:test'
import { parseRateLimitHeaders, probeUsage, ProbeError, type ProbeDeps } from '../src/usage-probe'
import { HEADER_KEYS, PROBE_MODEL } from '../src/constants'
import { AuthError } from '../src/usage-api'

/** Shaped after a real 200, captured 2026-08-08. */
const ALLOWED = new Headers({
  [HEADER_KEYS.fiveHourStatus]: 'allowed',
  [HEADER_KEYS.fiveHourUtilization]: '0.19',
  [HEADER_KEYS.fiveHourReset]: '1786155000',
  [HEADER_KEYS.weeklyStatus]: 'allowed',
  [HEADER_KEYS.weeklyUtilization]: '0.33',
  [HEADER_KEYS.weeklyReset]: '1786514400',
})

/** Shaped after a real 429 on a spent account, captured 2026-08-08. */
const REJECTED = new Headers({
  [HEADER_KEYS.fiveHourStatus]: 'rejected',
  [HEADER_KEYS.fiveHourUtilization]: '1.11',
  [HEADER_KEYS.fiveHourReset]: '1786155000',
  [HEADER_KEYS.weeklyStatus]: 'allowed',
  [HEADER_KEYS.weeklyUtilization]: '0.4',
  [HEADER_KEYS.weeklyReset]: '1786442400',
})

describe('parseRateLimitHeaders', () => {
  test('reads utilization as the fraction already spent', () => {
    // 0.19 spent is a nearly-untouched window, not a nearly-exhausted one.
    expect(parseRateLimitHeaders(ALLOWED).fiveHourPct).toBe(19)
    expect(parseRateLimitHeaders(ALLOWED).weeklyPct).toBe(33)
  })

  test('parses epoch-second reset values into dates', () => {
    expect(parseRateLimitHeaders(ALLOWED).fiveHourResetsAt?.getTime())
      .toBe(1786155000 * 1000)
    expect(parseRateLimitHeaders(ALLOWED).weeklyResetsAt?.getTime())
      .toBe(1786514400 * 1000)
  })

  test('is case-insensitive about header names', () => {
    const upper = new Headers({
      [HEADER_KEYS.fiveHourUtilization.toUpperCase()]: '0.19',
    })
    expect(parseRateLimitHeaders(upper).fiveHourPct).toBe(19)
  })

  test('clamps an over-limit window to 100 rather than reporting 111%', () => {
    expect(parseRateLimitHeaders(REJECTED).fiveHourPct).toBe(100)
  })

  test('yields null opus percentage when that header is absent', () => {
    expect(parseRateLimitHeaders(ALLOWED).opusWeeklyPct).toBeNull()
  })

  test('yields nulls when no rate-limit headers are present', () => {
    const windows = parseRateLimitHeaders(new Headers({ 'content-type': 'application/json' }))
    expect(windows.fiveHourPct).toBeNull()
    expect(windows.weeklyPct).toBeNull()
    expect(windows.fiveHourResetsAt).toBeNull()
  })
})

describe('probeUsage', () => {
  function harness(response: Response) {
    const calls: { url: string; init: RequestInit }[] = []
    const deps: ProbeDeps = {
      fetcher: (async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), init })
        return response
      }) as unknown as typeof fetch,
      endpoint: 'https://example.test/v1/messages',
      model: PROBE_MODEL,
      timeoutMs: 1_000,
    }
    return { calls, deps }
  }

  test('returns parsed windows from a successful response', async () => {
    const { deps } = harness(new Response('{}', { status: 200, headers: ALLOWED }))
    const windows = await probeUsage('tok', deps)
    expect(windows.fiveHourPct).toBe(19)
    expect(windows.weeklyPct).toBe(33)
  })

  test('reads a spent account from a 429 instead of failing', async () => {
    // The whole point of the rewrite: an exhausted account is the case the
    // tool most needs to report, and it is the case that returns 429.
    const { deps } = harness(new Response('{}', { status: 429, headers: REJECTED }))
    const windows = await probeUsage('tok', deps)
    expect(windows.fiveHourPct).toBe(100)
    expect(windows.weeklyPct).toBe(40)
  })

  test('sends the token as a bearer header, never in the body', async () => {
    const { calls, deps } = harness(new Response('{}', { status: 200, headers: ALLOWED }))
    await probeUsage('sk-secret', deps)
    const { init } = calls[0]!
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer sk-secret')
    expect(String(init.body)).not.toContain('sk-secret')
  })

  test('asks for the smallest possible completion', async () => {
    const { calls, deps } = harness(new Response('{}', { status: 200, headers: ALLOWED }))
    await probeUsage('tok', deps)
    const body = JSON.parse(String(calls[0]!.init.body))
    expect(body.max_tokens).toBe(1)
    expect(body.model).toBe(PROBE_MODEL)
  })

  test('raises AuthError on a rejected token, so no retry is attempted', async () => {
    const { deps } = harness(new Response('{}', { status: 401 }))
    expect(probeUsage('tok', deps)).rejects.toBeInstanceOf(AuthError)
  })

  test('throws when the response carries no rate-limit headers', async () => {
    // A silent all-null reading is what let a dead probe masquerade as 0% used.
    const { deps } = harness(new Response('{}', { status: 200 }))
    expect(probeUsage('tok', deps)).rejects.toBeInstanceOf(ProbeError)
  })

  test('failure message never contains the token', async () => {
    const { deps } = harness(new Response('bad token sk-secret', { status: 500 }))
    let message = ''
    try {
      await probeUsage('sk-secret', deps)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).not.toContain('sk-secret')
  })
})
