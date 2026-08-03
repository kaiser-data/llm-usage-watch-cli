# Active Codex Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add account-wide usage reporting for the currently logged-in Codex account to `cuw status`, without requiring a running Codex conversation or app session.

**Architecture:** A focused JSONL client starts a short-lived `codex app-server`, performs the documented initialization handshake, reads `account/rateLimits/read`, and converts the response into a Codex-specific domain model. Status collection runs Claude and Codex concurrently, renders separate provider sections, and emits a combined JSON envelope while preserving Claude recommendation and exit-code behavior.

**Tech Stack:** Bun, TypeScript with strict mode, Bun test, Codex app-server JSONL protocol

## Global Constraints

- Support exactly one Codex account: the account currently logged into the locally installed Codex CLI.
- Do not require a running Codex CLI, desktop app, or conversation session.
- Do not read, copy, persist, render, or log Codex tokens, email addresses, conversation data, or session files.
- Spawn `codex app-server` directly without a shell and use only `initialize`, `initialized`, and `account/rateLimits/read`.
- Preserve arbitrary Codex buckets and primary/secondary window durations; do not coerce them into Claude's five-hour/weekly model.
- A Codex failure must never suppress Claude output or change the existing exit code.
- `cuw status --json` intentionally changes to `{ "claude": [...], "codex": {...} }`.
- Leave Claude classification, recommendation, priming, account management, and doctor behavior unchanged.
- Keep the implementation dependency-free and macOS-compatible.
- Run `bun test`, `bunx tsc --noEmit`, and `bun run build` before completion.

---

## File Structure

- Create `src/codex-usage.ts`: validate and normalize raw Codex rate-limit responses; construct safe failure values.
- Create `src/codex-app-server.ts`: own the JSONL process protocol, timeout, cleanup, and real Bun child-process adapter.
- Create `tests/codex-usage.test.ts`: cover pure multi-bucket and fallback normalization.
- Create `tests/codex-app-server.test.ts`: cover protocol sequencing, streaming, errors, timeout, and cleanup.
- Modify `src/types.ts`: define the normalized Codex domain and safe error types.
- Modify `src/constants.ts`: define the Codex status timeout.
- Modify `src/render.ts`: render a separate Codex section without changing Claude rendering.
- Modify `tests/render.test.ts`: cover successful and failed Codex rendering.
- Modify `src/commands/status.ts`: collect both providers concurrently and produce text/JSON output.
- Modify `tests/status.test.ts`: cover the combined envelope, isolation, and unchanged exit codes.
- Modify `src/cli.ts`: wire the real Codex app-server collector into `status` only.
- Modify `tests/integration.test.ts`: provide a fake `codex` executable and verify the full CLI path.
- Modify `README.md`: describe combined Claude/Codex usage and prerequisites.
- Modify `docs/HOW-IT-WORKS.md`: document the Codex data path and security invariants.

---

### Task 1: Codex domain model and response normalization

**Files:**
- Modify: `src/types.ts:19-38`
- Create: `src/codex-usage.ts`
- Create: `tests/codex-usage.test.ts`

**Interfaces:**
- Consumes: the `result` object returned by `account/rateLimits/read` as `unknown`.
- Produces: `normalizeCodexRateLimits(raw: unknown): CodexUsage` and `failedCodexUsage(cause: CodexErrorCause, message: string): CodexUsage`.
- Produces types: `CodexErrorCause`, `CodexUsageWindow`, `CodexUsageLimit`, and `CodexUsage` in `src/types.ts`.

- [ ] **Step 1: Add failing multi-bucket normalization tests**

Create `tests/codex-usage.test.ts` with a realistic synthetic response. Assert that provider, plan, bucket identity, primary/secondary roles, duration, percentage, and epoch-second reset conversion are all preserved.

```ts
import { describe, expect, test } from 'bun:test'
import { normalizeCodexRateLimits } from '../src/codex-usage'

const MULTI_BUCKET = {
  rateLimits: {
    limitId: 'codex',
    planType: 'plus',
    primary: { usedPercent: 73, windowDurationMins: 10080, resetsAt: 1786175144 },
    secondary: null,
  },
  rateLimitsByLimitId: {
    codex: {
      limitId: 'codex',
      limitName: null,
      planType: 'plus',
      primary: { usedPercent: 73, windowDurationMins: 10080, resetsAt: 1786175144 },
      secondary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1785800000 },
    },
    codex_other: {
      limitId: 'codex_other',
      limitName: 'Other models',
      planType: 'plus',
      primary: { usedPercent: 42, windowDurationMins: 60, resetsAt: null },
      secondary: null,
    },
  },
}

describe('normalizeCodexRateLimits', () => {
  test('preserves every returned bucket and window', () => {
    const usage = normalizeCodexRateLimits(MULTI_BUCKET)
    expect(usage.provider).toBe('codex')
    expect(usage.plan).toBe('plus')
    expect(usage.error).toBeNull()
    expect(usage.limits.map(limit => limit.id)).toEqual(['codex', 'codex_other'])
    expect(usage.limits[0]!.windows.map(window => window.role)).toEqual([
      'primary',
      'secondary',
    ])
    expect(usage.limits[0]!.windows[0]).toEqual({
      role: 'primary',
      usedPct: 73,
      durationMinutes: 10080,
      resetsAt: new Date(1786175144 * 1000),
    })
    expect(usage.limits[1]!.name).toBe('Other models')
  })
})
```

- [ ] **Step 2: Run the new test and verify the missing module failure**

Run: `bun test tests/codex-usage.test.ts`

Expected: FAIL because `../src/codex-usage` does not exist.

- [ ] **Step 3: Add the normalized Codex types**

Append these exact public types after `UsageError` in `src/types.ts`:

```ts
export type CodexErrorCause =
  | 'not-installed'
  | 'not-logged-in'
  | 'timeout'
  | 'protocol'
  | 'process'

export type CodexUsageWindow = {
  role: 'primary' | 'secondary'
  usedPct: number
  durationMinutes: number | null
  resetsAt: Date | null
}

export type CodexUsageLimit = {
  id: string
  name: string | null
  windows: CodexUsageWindow[]
}

export type CodexUsage = {
  provider: 'codex'
  plan: string | null
  limits: CodexUsageLimit[]
  error: { cause: CodexErrorCause; message: string } | null
}
```

- [ ] **Step 4: Implement strict normalization and safe failure construction**

Create `src/codex-usage.ts`. Use small record, string, window, and snapshot helpers. Prefer a non-empty `rateLimitsByLimitId`; otherwise normalize the backward-compatible `rateLimits` snapshot under the `codex` key. Throw `CodexSchemaError` for an absent snapshot, an invalid percentage, or an invalid numeric field.

```ts
import type {
  CodexErrorCause,
  CodexUsage,
  CodexUsageLimit,
  CodexUsageWindow,
} from './types'

export class CodexSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexSchemaError'
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : null
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function nullableInteger(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new CodexSchemaError(`invalid ${field}`)
  }
  return value as number
}

function windowValue(value: unknown, role: CodexUsageWindow['role']): CodexUsageWindow | null {
  if (value === null || value === undefined) return null
  const source = record(value)
  if (source === null) throw new CodexSchemaError(`invalid ${role} window`)
  const usedPct = source.usedPercent
  if (!Number.isInteger(usedPct) || (usedPct as number) < 0 || (usedPct as number) > 100) {
    throw new CodexSchemaError(`invalid ${role} usedPercent`)
  }
  const durationMinutes = nullableInteger(source.windowDurationMins, `${role} duration`)
  const resetsAtSeconds = nullableInteger(source.resetsAt, `${role} reset`)
  return {
    role,
    usedPct: usedPct as number,
    durationMinutes,
    resetsAt: resetsAtSeconds === null ? null : new Date(resetsAtSeconds * 1000),
  }
}

function limitValue(key: string, value: unknown): { limit: CodexUsageLimit; plan: string | null } {
  const source = record(value)
  if (source === null) throw new CodexSchemaError(`invalid Codex limit ${key}`)
  const primary = windowValue(source.primary, 'primary')
  const secondary = windowValue(source.secondary, 'secondary')
  return {
    limit: {
      id: nullableString(source.limitId) ?? key,
      name: nullableString(source.limitName),
      windows: [primary, secondary].filter((item): item is CodexUsageWindow => item !== null),
    },
    plan: nullableString(source.planType),
  }
}

export function failedCodexUsage(cause: CodexErrorCause, message: string): CodexUsage {
  return { provider: 'codex', plan: null, limits: [], error: { cause, message } }
}

export function normalizeCodexRateLimits(raw: unknown): CodexUsage {
  const source = record(raw)
  if (source === null) throw new CodexSchemaError('Codex rate-limit result was not an object')
  const multi = record(source.rateLimitsByLimitId)
  const entries = multi !== null && Object.keys(multi).length > 0
    ? Object.entries(multi)
    : source.rateLimits === null || source.rateLimits === undefined
      ? []
      : [['codex', source.rateLimits] as [string, unknown]]
  if (entries.length === 0) throw new CodexSchemaError('Codex returned no rate-limit buckets')
  const parsed = entries.map(([key, value]) => limitValue(key || 'codex', value))
  return {
    provider: 'codex',
    plan: parsed.map(item => item.plan).find((plan): plan is string => plan !== null) ?? null,
    limits: parsed.map(item => item.limit),
    error: null,
  }
}
```

- [ ] **Step 5: Add fallback and validation tests**

Add tests that prove the single-bucket fallback works, a missing `limitId` uses `codex`, nullable duration/reset values remain null, and malformed percentages are rejected without embedding the raw payload in the error.

```ts
test('falls back to the backward-compatible single bucket', () => {
  const usage = normalizeCodexRateLimits({
    rateLimits: {
      limitId: null,
      planType: 'pro',
      primary: { usedPercent: 5, windowDurationMins: null, resetsAt: null },
      secondary: null,
    },
  })
  expect(usage.plan).toBe('pro')
  expect(usage.limits[0]!.id).toBe('codex')
  expect(usage.limits[0]!.windows[0]!.durationMinutes).toBeNull()
})

test('rejects invalid percentages', () => {
  expect(() => normalizeCodexRateLimits({
    rateLimits: { primary: { usedPercent: 101 } },
  })).toThrow(/usedPercent/)
})

test('rejects a response with no buckets', () => {
  expect(() => normalizeCodexRateLimits({ rateLimitsByLimitId: {} })).toThrow(/no rate-limit/)
})
```

- [ ] **Step 6: Run focused tests and type checking**

Run: `bun test tests/codex-usage.test.ts && bunx tsc --noEmit`

Expected: all Codex normalization tests PASS and TypeScript reports no errors.

- [ ] **Step 7: Commit the domain boundary**

```bash
git add src/types.ts src/codex-usage.ts tests/codex-usage.test.ts
git commit -m "feat: normalize Codex usage limits"
```

---

### Task 2: Short-lived Codex app-server client

**Files:**
- Modify: `src/constants.ts:10-14`
- Create: `src/codex-app-server.ts`
- Create: `tests/codex-app-server.test.ts`

**Interfaces:**
- Consumes: `normalizeCodexRateLimits(raw)` and `failedCodexUsage(cause, message)` from Task 1.
- Produces: `CodexAppServerProcess`, `CodexAppServerSpawner`, `CodexUsageDeps`, `collectCodexUsage(deps): Promise<CodexUsage>`, and `realCodexAppServerSpawner`.
- The process abstraction exposes `stdout`, structured `write(message)`, `exited`, and `kill()`; it never exposes stderr text to consumers.

- [ ] **Step 1: Write failing protocol-sequencing tests**

Create a fake process whose stdout contains an initialization response, an unrelated notification, and a rate-limit response. Record structured writes so the test can assert the exact handshake order.

```ts
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
})
```

- [ ] **Step 2: Run the protocol test and verify the missing module failure**

Run: `bun test tests/codex-app-server.test.ts`

Expected: FAIL because `../src/codex-app-server` does not exist.

- [ ] **Step 3: Define the timeout and process interfaces**

Add `CODEX_USAGE_TIMEOUT_MS = 8_000` beside `REQUEST_TIMEOUT_MS` in `src/constants.ts`. Start `src/codex-app-server.ts` with these public interfaces:

```ts
import { failedCodexUsage, normalizeCodexRateLimits } from './codex-usage'
import type { CodexErrorCause, CodexUsage } from './types'

export type CodexAppServerProcess = {
  stdout: ReadableStream<Uint8Array>
  write: (message: unknown) => void
  exited: Promise<number>
  kill: () => void
}

export type CodexAppServerSpawner = () => CodexAppServerProcess

export type CodexUsageDeps = {
  spawn: CodexAppServerSpawner
  timeoutMs: number
}
```

- [ ] **Step 4: Implement JSONL response matching, timeout, and cleanup**

Implement an internal `waitForResponse` that decodes arbitrary stdout chunks, parses complete newline-delimited messages, ignores notifications, and returns only the requested ID. Never put a raw line or server error message into a thrown or displayed error. Use one overall timer and kill the child in `finally`.

```ts
class CodexClientError extends Error {
  constructor(override readonly cause: CodexErrorCause, message: string) {
    super(message)
    this.name = 'CodexClientError'
  }
}

type RpcRecord = Record<string, unknown>

function rpcRecord(value: unknown): RpcRecord | null {
  return typeof value === 'object' && value !== null ? value as RpcRecord : null
}

async function runProtocol(process: CodexAppServerProcess): Promise<CodexUsage> {
  const reader = process.stdout.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const pending: RpcRecord[] = []

  async function response(id: number): Promise<RpcRecord> {
    for (;;) {
      const existing = pending.findIndex(message => message.id === id)
      if (existing >= 0) return pending.splice(existing, 1)[0]!
      const chunk = await reader.read()
      if (chunk.done) throw new CodexClientError('process', 'Codex app-server exited early')
      buffer += decoder.decode(chunk.value, { stream: true })
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          throw new CodexClientError('protocol', 'Codex app-server returned invalid JSON')
        }
        const message = rpcRecord(parsed)
        if (message === null) throw new CodexClientError('protocol', 'Codex returned an invalid message')
        if ('id' in message) pending.push(message)
      }
    }
  }

  process.write({
    method: 'initialize',
    id: 0,
    params: { clientInfo: { name: 'cuw', title: 'LLM Usage Watch', version: '0.1.0' } },
  })
  const initialized = await response(0)
  if (initialized.error !== undefined) {
    throw new CodexClientError('protocol', 'Codex app-server initialization failed')
  }
  process.write({ method: 'initialized', params: {} })
  process.write({ method: 'account/rateLimits/read', id: 1 })
  const limits = await response(1)
  if (limits.error !== undefined) {
    throw new CodexClientError('not-logged-in', 'Codex is not logged into a ChatGPT account — run `codex login`')
  }
  return normalizeCodexRateLimits(limits.result)
}

export async function collectCodexUsage(deps: CodexUsageDeps): Promise<CodexUsage> {
  let process: CodexAppServerProcess | null = null
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    process = deps.spawn()
    const timedOut = new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new CodexClientError('timeout', 'Codex usage check timed out')),
        deps.timeoutMs,
      )
    })
    return await Promise.race([runProtocol(process), timedOut])
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return failedCodexUsage('not-installed', 'Codex CLI is not installed or not on PATH')
    }
    if (error instanceof CodexClientError) return failedCodexUsage(error.cause, error.message)
    return failedCodexUsage('process', 'Codex usage could not be read')
  } finally {
    if (timeout !== null) clearTimeout(timeout)
    process?.kill()
  }
}
```

- [ ] **Step 5: Add the real shell-free Bun process adapter**

The adapter must ignore stderr because Codex startup warnings are not safe or useful status output. Serialize exactly one JSON object per line.

```ts
export const realCodexAppServerSpawner: CodexAppServerSpawner = () => {
  const child = Bun.spawn(['codex', 'app-server'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
  })
  return {
    stdout: child.stdout,
    write(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`)
    },
    exited: child.exited,
    kill() {
      child.kill()
    },
  }
}
```

- [ ] **Step 6: Add failure and lifecycle tests**

Add separate tests for fragmented chunks, a JSON-RPC error, invalid JSON, synchronous `ENOENT`, nonzero/early process termination, and a never-ending stream that times out. Assert the returned cause/message and that `kill()` runs in every case. Include a sentinel secret in a raw error message and assert it is absent from `JSON.stringify(result)`.

```ts
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
})

test('does not expose a raw server error', async () => {
  const fake = processWithChunks([
    '{"id":0,"result":{}}\n',
    '{"id":1,"error":{"code":401,"message":"secret-account-value"}}\n',
  ])
  const result = await collectCodexUsage({ spawn: () => fake.process, timeoutMs: 100 })
  expect(result.error?.cause).toBe('not-logged-in')
  expect(JSON.stringify(result)).not.toContain('secret-account-value')
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
```

- [ ] **Step 7: Run focused tests and type checking**

Run: `bun test tests/codex-usage.test.ts tests/codex-app-server.test.ts && bunx tsc --noEmit`

Expected: all Codex domain/client tests PASS and TypeScript reports no errors.

- [ ] **Step 8: Commit the process client**

```bash
git add src/constants.ts src/codex-app-server.ts tests/codex-app-server.test.ts
git commit -m "feat: read active Codex rate limits"
```

---

### Task 3: Codex terminal rendering

**Files:**
- Modify: `src/render.ts:1-153`
- Modify: `tests/render.test.ts`

**Interfaces:**
- Consumes: `CodexUsage` from Task 1 and the existing `RenderOptions`, `bar`, and `formatDuration` helpers.
- Produces: `renderCodexUsage(usage: CodexUsage, opts: RenderOptions): string`.
- Does not modify `renderTable`, `classify`, or `recommend` semantics.

- [ ] **Step 1: Write failing successful-render tests**

Add a `codexUsage` fixture and assert that the separate section identifies the active account and plan, renders every window, converts 10080 minutes to `7d`, uses the shared bar, and shows reset countdowns relative to `opts.now`.

```ts
import type { AccountUsage, CodexUsage } from '../src/types'
import { bar, formatDuration, renderCodexUsage, renderTable } from '../src/render'

const CODEX: CodexUsage = {
  provider: 'codex',
  plan: 'plus',
  limits: [{
    id: 'codex',
    name: null,
    windows: [
      {
        role: 'primary',
        usedPct: 73,
        durationMinutes: 10080,
        resetsAt: new Date('2026-08-07T08:00:00Z'),
      },
      {
        role: 'secondary',
        usedPct: 20,
        durationMinutes: 300,
        resetsAt: new Date('2026-08-03T10:00:00Z'),
      },
    ],
  }],
  error: null,
}

test('renders active Codex plan and every returned window', () => {
  const output = renderCodexUsage(CODEX, OPTS)
  expect(output).toContain('CODEX')
  expect(output).toContain('active')
  expect(output).toContain('plus')
  expect(output).toContain('primary 7d')
  expect(output).toContain('secondary 5h00m')
  expect(output).toContain('73%')
  expect(output).toContain('4d')
  expect(output).not.toMatch(ANSI_PATTERN)
})
```

- [ ] **Step 2: Run the render test and verify the missing export failure**

Run: `bun test tests/render.test.ts`

Expected: FAIL because `renderCodexUsage` is not exported.

- [ ] **Step 3: Implement the compact Codex section**

Import `CodexUsage`, flatten the buckets into rows, format supplied window durations with the existing duration helper, and use the server name only when it is non-null. Keep all rendering pure by using `opts.now`.

```ts
import type { AccountUsage, CodexUsage } from './types'

function codexDuration(minutes: number | null): string {
  return minutes === null ? '—' : formatDuration(minutes * MS_PER_MINUTE)
}

export function renderCodexUsage(usage: CodexUsage, opts: RenderOptions): string {
  const heading = `CODEX  active  PLAN ${usage.plan ?? '—'}`
  if (usage.error !== null) {
    const mark = paint('✗ error', ANSI.red, opts.color)
    return `${heading}\n${mark}  ${usage.error.message}\n`
  }
  const rows = usage.limits.flatMap(limit => limit.windows.map(window => ({ limit, window })))
  if (rows.length === 0) return `${heading}\nNo limit windows reported.\n`
  const labelWidth = Math.max(5, ...rows.map(row => (row.limit.name ?? row.limit.id).length))
  const header = paint(
    ['LIMIT'.padEnd(labelWidth), 'WINDOW'.padEnd(13), `USED${' '.repeat(BAR_CELLS + 2)}`, 'RESETS']
      .join('  '),
    ANSI.dim,
    opts.color,
  )
  const rule = paint('─'.repeat(Math.min(opts.width, labelWidth + BAR_CELLS + 39)), ANSI.dim, opts.color)
  const body = rows.map(({ limit, window }) => [
    (limit.name ?? limit.id).padEnd(labelWidth),
    `${window.role} ${codexDuration(window.durationMinutes)}`.padEnd(13),
    `${String(window.usedPct).padStart(3)}%  ${bar(window.usedPct)}`,
    countdown(window.resetsAt, opts.now).padStart(6),
  ].join('  '))
  return [heading, header, rule, ...body, ''].join('\n')
}
```

- [ ] **Step 4: Add error, empty-window, and color tests**

Assert that safe error text appears, no raw fields can be introduced by the renderer, a successful response with no windows is explicit, and color is only emitted when requested.

```ts
test('renders a safe Codex error without a table', () => {
  const failed: CodexUsage = {
    provider: 'codex',
    plan: null,
    limits: [],
    error: { cause: 'not-logged-in', message: 'Codex is not logged in — run `codex login`' },
  }
  const output = renderCodexUsage(failed, OPTS)
  expect(output).toContain('codex login')
  expect(output).toContain('✗ error')
})

test('renders an explicit message when Codex returns no windows', () => {
  expect(renderCodexUsage({ ...CODEX, limits: [] }, OPTS)).toContain('No limit windows')
})
```

- [ ] **Step 5: Run render and regression tests**

Run: `bun test tests/render.test.ts tests/classify.test.ts`

Expected: all rendering and unchanged Claude recommendation tests PASS.

- [ ] **Step 6: Commit the renderer**

```bash
git add src/render.ts tests/render.test.ts
git commit -m "feat: render active Codex usage"
```

---

### Task 4: Status orchestration, JSON envelope, and real CLI wiring

**Files:**
- Modify: `src/commands/status.ts:1-38`
- Modify: `src/cli.ts:5-35,123-136`
- Modify: `tests/status.test.ts:1-78`
- Modify: `tests/integration.test.ts:1-84`

**Interfaces:**
- Consumes: `collectCodexUsage`, `realCodexAppServerSpawner`, `CODEX_USAGE_TIMEOUT_MS`, and `renderCodexUsage` from Tasks 2-3.
- Adds to `StatusDeps`: `collectCodex: () => Promise<CodexUsage>`.
- Produces text containing Claude output followed by the Codex section.
- Produces JSON `{ claude: Array<AccountUsage & { state: State }>, codex: CodexUsage }`.

- [ ] **Step 1: Update status tests first for the new dependency and output contract**

Add a successful `CodexUsage` fixture to the `deps()` helper. Change JSON assertions to use `parsed.claude[0]` and `parsed.codex`. Extend the table test to require the Codex section.

```ts
import type { Account, CodexUsage, UsageWindows } from '../src/types'

const CODEX: CodexUsage = {
  provider: 'codex',
  plan: 'plus',
  limits: [{
    id: 'codex',
    name: null,
    windows: [{
      role: 'primary',
      usedPct: 73,
      durationMinutes: 10080,
      resetsAt: new Date('2026-08-07T08:00:00Z'),
    }],
  }],
  error: null,
}

function deps(overrides: Partial<StatusDeps> = {}): StatusDeps {
  return {
    accounts,
    color: false,
    width: 80,
    now: NOW,
    collectCodex: async () => CODEX,
    usage: {
      keychain: { get: async () => 'tok', set: async () => {}, remove: async () => {} },
      fetchWindows: async () => WINDOWS,
      probeWindows: async () => WINDOWS,
    },
    ...overrides,
  }
}

test('emits the combined JSON envelope', async () => {
  const { io, out } = captureIo()
  await runStatus({ json: true }, deps(), io)
  const parsed = JSON.parse(out.join(''))
  expect(parsed.claude[0].id).toBe('main')
  expect(parsed.claude[0].state).toBe('warm')
  expect(parsed.codex.plan).toBe('plus')
  expect(parsed.codex.limits[0].windows[0].usedPct).toBe(73)
})
```

- [ ] **Step 2: Add isolation, concurrency, and exit-code tests**

Prove that no Claude accounts still permits Codex output, Codex failure leaves exit `0`, Claude auth failure remains exit `2`, and both collectors start before either is allowed to finish.

```ts
test('shows Codex even when no Claude accounts exist', async () => {
  const { io, out } = captureIo()
  expect(await runStatus({ json: false }, deps({ accounts: [] }), io)).toBe(0)
  expect(out.join('')).toContain('cuw add')
  expect(out.join('')).toContain('CODEX')
  expect(out.join('')).toContain('73%')
})

test('a Codex error does not affect the exit code', async () => {
  const failed: CodexUsage = {
    provider: 'codex',
    plan: null,
    limits: [],
    error: { cause: 'timeout', message: 'Codex usage check timed out' },
  }
  const { io, out } = captureIo()
  expect(await runStatus({ json: false }, deps({ collectCodex: async () => failed }), io)).toBe(0)
  expect(out.join('')).toContain('timed out')
})
```

For concurrency, block Claude in `keychain.get`, set a flag in `collectCodex`, start `runStatus`, await one microtask, assert the flag, then release Claude and await the command.

```ts
test('starts Claude and Codex collection concurrently', async () => {
  let releaseClaude: (() => void) | null = null
  let codexStarted = false
  const claudeGate = new Promise<void>(resolve => { releaseClaude = resolve })
  const configured = deps({
    collectCodex: async () => { codexStarted = true; return CODEX },
    usage: {
      keychain: {
        get: async () => { await claudeGate; return 'tok' },
        set: async () => {},
        remove: async () => {},
      },
      fetchWindows: async () => WINDOWS,
      probeWindows: async () => WINDOWS,
    },
  })
  const { io } = captureIo()
  const running = runStatus({ json: false }, configured, io)
  await Promise.resolve()
  expect(codexStarted).toBe(true)
  releaseClaude?.()
  await running
})
```

- [ ] **Step 3: Run status tests and verify contract failures**

Run: `bun test tests/status.test.ts`

Expected: FAIL because `StatusDeps` lacks `collectCodex` and output is still Claude-only.

- [ ] **Step 4: Collect both providers concurrently and render the combined outputs**

Modify `src/commands/status.ts` so an unexpected rejected Codex dependency is converted to a safe process error. Preserve the current Claude auth calculation exactly.

```ts
import { failedCodexUsage } from '../codex-usage'
import { renderCodexUsage, renderTable } from '../render'
import type { Account, CodexUsage } from '../types'

export type StatusDeps = {
  accounts: Account[]
  usage: UsageDeps
  collectCodex: () => Promise<CodexUsage>
  color: boolean
  width: number
  now: Date
}

const [rows, codex] = await Promise.all([
  collectUsage(deps.accounts, deps.usage),
  deps.collectCodex().catch(() =>
    failedCodexUsage('process', 'Codex usage could not be read')),
])
const rec = recommend(rows)
const options = { color: deps.color, width: deps.width, now: deps.now }

if (args.json) {
  io.out(JSON.stringify({
    claude: rows.map(row => ({ ...row, state: classify(row) })),
    codex,
  }, null, 2))
} else {
  const claude = renderTable(rows, rec, options).trimEnd()
  const codexText = renderCodexUsage(codex, options).trimEnd()
  io.out(`${claude}\n\n${codexText}\n`)
}
```

- [ ] **Step 5: Wire the real collector into `status` only**

Import `CODEX_USAGE_TIMEOUT_MS`, `collectCodexUsage`, and `realCodexAppServerSpawner` in `src/cli.ts`. Update help copy to say that status covers configured Claude subscriptions and the active Codex account. Add this dependency in the `status` case only:

```ts
collectCodex: () => collectCodexUsage({
  spawn: realCodexAppServerSpawner,
  timeoutMs: CODEX_USAGE_TIMEOUT_MS,
}),
```

Do not add Codex work to `add`, `rm`, `prime`, or `doctor`.

- [ ] **Step 6: Add a fake Codex executable to the end-to-end harness**

In `tests/integration.test.ts`, create `home/bin/codex`, make it executable, and prepend that directory to `PATH`. The fixture responds only to the three documented protocol messages and contains no credentials.

```ts
import { chmod, mkdtemp, mkdir, writeFile } from 'node:fs/promises'

let fakeBin: string

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
        limitId: 'codex', planType: 'plus',
        primary: { usedPercent: 73, windowDurationMins: 10080, resetsAt: 4070995200 },
        secondary: null,
      },
    } }))
  }
})
`
```

Inside `beforeAll`, write the fixture and call `chmod(path, 0o755)`. Add `PATH: `${fakeBin}:${process.env.PATH ?? ''}`` to `runCli`'s environment. Update end-to-end assertions:

```ts
test('renders Claude and active Codex usage', async () => {
  mode = 'ok'
  const { code, stdout } = await runCli([])
  expect(code).toBe(0)
  expect(stdout).toContain('main')
  expect(stdout).toContain('CODEX')
  expect(stdout).toContain('73%')
})

test('emits combined JSON with --json', async () => {
  mode = 'ok'
  const { stdout } = await runCli(['status', '--json'])
  const parsed = JSON.parse(stdout)
  expect(parsed.claude[0].fiveHourPct).toBe(12)
  expect(parsed.codex.limits[0].windows[0].usedPct).toBe(73)
})
```

- [ ] **Step 7: Run status, integration, and type tests**

Run: `bun test tests/status.test.ts tests/integration.test.ts && bunx tsc --noEmit`

Expected: combined text/JSON tests PASS, Claude auth still exits `2`, and TypeScript reports no errors.

- [ ] **Step 8: Commit the complete status path**

```bash
git add src/commands/status.ts src/cli.ts tests/status.test.ts tests/integration.test.ts
git commit -m "feat: include Codex in usage status"
```

---

### Task 5: User documentation and release verification

**Files:**
- Modify: `README.md:1-95`
- Modify: `docs/HOW-IT-WORKS.md:5-235`

**Interfaces:**
- Consumes: the shipped terminal layout, JSON envelope, prerequisites, and failure behavior from Tasks 1-4.
- Produces: user-facing setup/usage guidance and maintainer-facing architecture/security documentation.

- [ ] **Step 1: Update README positioning, prerequisites, examples, and JSON warning**

Change the opening to say `cuw` shows configured Claude subscriptions plus the active Codex account. Keep Claude account setup accurate: `claude auth login` followed by `cuw add <id>`; remove the stale `claude setup-token` instruction because the existing implementation explicitly rejects inference-only setup tokens.

Add a Codex prerequisite block:

```markdown
## Codex usage

Install the Codex CLI and log in once:

    codex login

`cuw` reads the account-wide limits of that active Codex account. No Codex app,
CLI conversation, or agent session needs to be running. `cuw` starts a
short-lived local app-server for the read and never accesses Codex tokens or
session files directly.
```

Update the example with a separate `CODEX` section. State explicitly that JSON is now an object with `claude` and `codex` fields and that only Claude credential problems produce exit code `2`.

- [ ] **Step 2: Extend HOW-IT-WORKS with the Codex path and invariants**

Add a provider subsection under “Where the numbers come from” documenting:

```markdown
### Codex: short-lived app-server read

For the active Codex login, `cuw` starts `codex app-server`, completes its JSONL
initialization handshake, calls `account/rateLimits/read`, normalizes every
returned bucket/window, and terminates the child. This is account-wide data;
it does not depend on a running Codex conversation or desktop session.
```

Update the module map with `codex-usage.ts` and `codex-app-server.ts`. Add invariants that Codex credentials/session files are never read directly, stderr/raw protocol errors never reach output, and Codex failures cannot change Claude recommendation or exit status. Add the combined JSON shape to the known interface notes.

- [ ] **Step 3: Run documentation and placeholder checks**

Run: `rg -n 'setup-token|top-level.*array|Claude subscription usage across accounts' README.md docs/HOW-IT-WORKS.md`

Expected: any remaining `setup-token` occurrence only explains why it does not work; no text claims status is Claude-only or JSON is a top-level array.

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 4: Run the complete automated verification suite**

Run: `bun test`

Expected: all tests PASS.

Run: `bunx tsc --noEmit`

Expected: no TypeScript errors.

Run: `bun run build`

Expected: `dist/cuw` builds successfully.

- [ ] **Step 5: Perform a read-only live smoke test**

Run: `./dist/cuw status --json`

Expected: valid JSON with top-level `claude` and `codex`; `codex.provider` is `codex`; the active logged-in account returns either normalized limits or a safe actionable error; no email address, token, raw protocol message, or stderr warning appears.

Run: `./dist/cuw status`

Expected: the Claude table/recommendation and a separate `CODEX  active` section render; the command does not require another Codex process or conversation to be running.

- [ ] **Step 6: Commit documentation**

```bash
git add README.md docs/HOW-IT-WORKS.md
git commit -m "docs: explain Codex usage reporting"
```

- [ ] **Step 7: Review the final diff and commits**

Run: `git status --short && git log --oneline -6 && git diff HEAD~5..HEAD --check`

Expected: the working tree is clean, the five feature commits are present, and the aggregate diff has no whitespace errors.
