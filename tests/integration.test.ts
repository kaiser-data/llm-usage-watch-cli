import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let server: ReturnType<typeof Bun.serve>
let home: string
let fakeBin: string
let mode: 'ok' | 'unauthorized' | 'garbage' = 'ok'
let probeMode: 'headers' | 'bare' = 'headers'

/** The live probe reads these off a real inference response. */
const PROBE_HEADERS = {
  'anthropic-ratelimit-unified-5h-utilization': '0.19',
  'anthropic-ratelimit-unified-5h-reset': '4070995200',
  'anthropic-ratelimit-unified-7d-utilization': '0.33',
  'anthropic-ratelimit-unified-7d-reset': '4070995200',
}

const FIXTURE = {
  five_hour: { utilization: 12.0, resets_at: '2099-01-01T00:00:00Z' },
  seven_day: { utilization: 34.0, resets_at: '2099-01-05T00:00:00Z' },
}

const FAKE_CODEX = `#!/usr/bin/env bun
import readline from 'node:readline'
const input = readline.createInterface({ input: process.stdin })
input.on('line', line => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    console.log(JSON.stringify({ id: message.id, result: { userAgent: 'fake-codex' } }))
  }
  if (message.method === 'account/rateLimits/read') {
    console.log(JSON.stringify({ id: message.id, result: {
      rateLimits: {
        limitId: 'codex',
        planType: 'plus',
        primary: { usedPercent: 73, windowDurationMins: 10080, resetsAt: 4070995200 },
        secondary: null,
      },
    } }))
  }
})
`

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      if (request.headers.get('authorization') !== 'Bearer test-token') {
        return new Response('{}', { status: 401 })
      }
      if (new URL(request.url).pathname === '/probe') {
        return new Response('{}', {
          status: 200,
          headers: probeMode === 'headers' ? PROBE_HEADERS : {},
        })
      }
      if (mode === 'unauthorized') return new Response('{}', { status: 401 })
      if (mode === 'garbage') return new Response('{"nothing":"useful"}', { status: 200 })
      return Response.json(FIXTURE)
    },
  })

  home = await mkdtemp(join(tmpdir(), 'cuw-home-'))
  fakeBin = join(home, 'bin')
  await mkdir(fakeBin, { recursive: true })
  const fakeCodexPath = join(fakeBin, 'codex')
  await writeFile(fakeCodexPath, FAKE_CODEX)
  await chmod(fakeCodexPath, 0o755)
  await mkdir(join(home, '.config', 'cuw'), { recursive: true })
  await writeFile(
    join(home, '.config', 'cuw', 'accounts.json'),
    JSON.stringify([{ id: 'main', label: 'main', email: 'm@x.com', order: 1 }]),
  )
})

afterAll(() => server.stop(true))

async function runCli(args: string[]): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', ...args], {
    env: {
      ...process.env,
      HOME: home,
      CUW_ENDPOINT: `http://localhost:${server.port}/usage`,
      CUW_PROBE_ENDPOINT: `http://localhost:${server.port}/probe`,
      CUW_FAKE_TOKEN: 'test-token',
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return { code, stdout }
}

describe('cuw end to end', () => {
  test('renders Claude, Codex, Cursor, and Grok sections', async () => {
    mode = 'ok'
    const { code, stdout } = await runCli([])
    expect(code).toBe(0)
    expect(stdout).toContain('main')
    expect(stdout).toContain('12%')
    expect(stdout).toContain('CODEX')
    expect(stdout).toContain('73%')
    expect(stdout).toContain('CURSOR')
    expect(stdout).toContain('GROK')
  })

  test('emits combined JSON with --json', async () => {
    mode = 'ok'
    const { stdout } = await runCli(['status', '--json'])
    const parsed = JSON.parse(stdout)
    expect(parsed.claude[0].fiveHourPct).toBe(12)
    expect(parsed.codex.limits[0].windows[0].usedPct).toBe(73)
    expect(parsed.cursor.provider).toBe('cursor')
    expect(parsed.cursor.error?.cause).toBe('not-installed')
    expect(parsed.grok.provider).toBe('grok')
    expect(parsed.grok.error?.cause).toBe('not-installed')
  })

  test('falls back to the probe when the usage API returns nothing usable', async () => {
    mode = 'garbage'
    probeMode = 'headers'
    const { stdout } = await runCli(['status', '--json'])
    const parsed = JSON.parse(stdout)
    expect(parsed.claude[0].source).toBe('probe')
    expect(parsed.claude[0].fiveHourPct).toBe(19)
    expect(parsed.claude[0].error).toBeNull()
  })

  test('reports an error when the probe response carries no rate-limit headers', async () => {
    // The failure that shipped silently: a probe that parsed nothing was
    // reported as a healthy account sitting at 0%, which then won the
    // recommendation. It must surface as an error instead.
    mode = 'garbage'
    probeMode = 'bare'
    const { stdout } = await runCli(['status', '--json'])
    const parsed = JSON.parse(stdout)
    expect(parsed.claude[0].error?.cause).toBe('probe-failed')
    expect(parsed.claude[0].fiveHourPct).toBeNull()
    expect(parsed.claude[0].state).toBe('unknown')
  })

  test('never recommends an account it could not read', async () => {
    mode = 'garbage'
    probeMode = 'bare'
    const { stdout } = await runCli([])
    expect(stdout).not.toMatch(/→ use: main/)
  })

  test('exits 2 on an unauthorized token', async () => {
    mode = 'unauthorized'
    const { code } = await runCli([])
    expect(code).toBe(2)
  })

  test('prints help and exits 0', async () => {
    const { code, stdout } = await runCli(['--help'])
    expect(code).toBe(0)
    expect(stdout).toContain('cuw prime')
  })

  test('rejects an unknown command', async () => {
    const { code } = await runCli(['bogus'])
    expect(code).toBe(1)
  })

  test('lists the use command in help', async () => {
    const { stdout } = await runCli(['--help'])
    expect(stdout).toContain('cuw use')
  })

  test('rejects `use` with an unknown account id', async () => {
    // The suite's registry holds only `main`, so this is rejected before any
    // real Keychain access happens.
    const { code } = await runCli(['use', 'nope'])
    expect(code).toBe(2)
  })
})
