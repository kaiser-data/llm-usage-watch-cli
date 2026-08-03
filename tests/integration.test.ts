import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let server: ReturnType<typeof Bun.serve>
let home: string
let mode: 'ok' | 'unauthorized' | 'garbage' = 'ok'

const FIXTURE = {
  five_hour: { utilization: 12.0, resets_at: '2099-01-01T00:00:00Z' },
  seven_day: { utilization: 34.0, resets_at: '2099-01-05T00:00:00Z' },
}

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      if (request.headers.get('authorization') !== 'Bearer test-token') {
        return new Response('{}', { status: 401 })
      }
      if (mode === 'unauthorized') return new Response('{}', { status: 401 })
      if (mode === 'garbage') return new Response('{"nothing":"useful"}', { status: 200 })
      return Response.json(FIXTURE)
    },
  })

  home = await mkdtemp(join(tmpdir(), 'cuw-home-'))
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
      CUW_FAKE_TOKEN: 'test-token',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return { code, stdout }
}

describe('cuw end to end', () => {
  test('renders a table against a healthy endpoint', async () => {
    mode = 'ok'
    const { code, stdout } = await runCli([])
    expect(code).toBe(0)
    expect(stdout).toContain('main')
    expect(stdout).toContain('12%')
  })

  test('emits JSON with --json', async () => {
    mode = 'ok'
    const { stdout } = await runCli(['status', '--json'])
    expect(JSON.parse(stdout)[0].fiveHourPct).toBe(12)
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
})
