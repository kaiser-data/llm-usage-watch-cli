import { describe, expect, test } from 'bun:test'
import { AuthError, SchemaError, fetchUsage, normalizeApiResponse } from '../src/usage-api'
import { USAGE_ENDPOINTS } from '../src/constants'
import fixture from './fixtures/usage-api.json'

const ENDPOINT = USAGE_ENDPOINTS[0]

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('normalizeApiResponse', () => {
  test('maps the recorded fixture into UsageWindows', () => {
    const windows = normalizeApiResponse(fixture)
    expect(windows.fiveHourPct).toBe(23)
    expect(windows.weeklyPct).toBe(60)
  })

  test('parses ISO 8601 reset timestamps', () => {
    const windows = normalizeApiResponse(fixture)
    expect(windows.fiveHourResetsAt?.toISOString()).toBe('2099-01-01T13:40:00.000Z')
  })

  test('yields null for a plan with no separate Opus limit', () => {
    expect(normalizeApiResponse(fixture).opusWeeklyPct).toBeNull()
  })

  test('treats utilization above 1 as an already-percentage value', () => {
    const windows = normalizeApiResponse({ five_hour: { utilization: 23.0 }, seven_day: null })
    expect(windows.fiveHourPct).toBe(23)
  })

  test('tolerates a null per-model limit object', () => {
    const windows = normalizeApiResponse({ five_hour: { utilization: 5 }, seven_day_opus: null })
    expect(windows.opusWeeklyPct).toBeNull()
  })

  test('throws SchemaError when the payload is not an object', () => {
    expect(() => normalizeApiResponse('nope')).toThrow(SchemaError)
  })

  test('throws SchemaError when no recognized limit fields are present', () => {
    expect(() => normalizeApiResponse({ unrelated: true })).toThrow(SchemaError)
  })
})

describe('fetchUsage', () => {
  test('sends a bearer token and the oauth beta header', async () => {
    let seen: Request | undefined
    const fetcher = (async (input: Request | string, init?: RequestInit) => {
      seen = new Request(input as string, init)
      return jsonResponse(fixture)
    }) as unknown as typeof fetch

    await fetchUsage('tok-abc', { fetcher, endpoint: ENDPOINT, timeoutMs: 1000 })
    expect(seen?.headers.get('authorization')).toBe('Bearer tok-abc')
    expect(seen?.headers.get('anthropic-beta')).toContain('oauth')
  })

  test('throws AuthError on 401', async () => {
    const fetcher = (async () => jsonResponse({ error: 'unauthorized' }, 401)) as unknown as typeof fetch
    expect(fetchUsage('tok', { fetcher, endpoint: ENDPOINT, timeoutMs: 1000 })).rejects.toThrow(AuthError)
  })

  test('throws AuthError on 403', async () => {
    const fetcher = (async () => jsonResponse({}, 403)) as unknown as typeof fetch
    expect(fetchUsage('tok', { fetcher, endpoint: ENDPOINT, timeoutMs: 1000 })).rejects.toThrow(AuthError)
  })

  test('throws SchemaError on an unexpected 200 body', async () => {
    const fetcher = (async () => jsonResponse({ nothing: 'useful' })) as unknown as typeof fetch
    expect(fetchUsage('tok', { fetcher, endpoint: ENDPOINT, timeoutMs: 1000 })).rejects.toThrow(SchemaError)
  })

  test('throws SchemaError on a non-JSON 200 body', async () => {
    const fetcher = (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch
    expect(fetchUsage('tok', { fetcher, endpoint: ENDPOINT, timeoutMs: 1000 })).rejects.toThrow(SchemaError)
  })

  test('error messages never contain the token', async () => {
    const fetcher = (async () => jsonResponse({}, 401)) as unknown as typeof fetch
    let message = ''
    try {
      await fetchUsage('tok-secret', { fetcher, endpoint: ENDPOINT, timeoutMs: 1000 })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).not.toContain('tok-secret')
  })
})
