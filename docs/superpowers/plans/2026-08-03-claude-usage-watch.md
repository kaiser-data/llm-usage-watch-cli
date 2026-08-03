# claude-usage-watch (`cuw`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single `cuw` command that shows five-hour and weekly usage across four Claude subscriptions without switching logins, and starts the five-hour window on any idle subscription for a negligible cost.

**Architecture:** Three layers — a credential layer (Keychain + a secret-free registry), a usage layer (API path with per-account fallback to a header probe, both producing one normalized record), and a pure presentation layer (classification + rendering). All I/O sits behind narrow injected interfaces so command logic is tested with fakes.

**Tech Stack:** Bun 1.3.13, TypeScript, zero runtime dependencies. `bun test` for tests, `bun build --compile` for the binary. macOS `security(1)` for Keychain access, `claude` CLI for priming.

**Spec:** `docs/superpowers/specs/2026-08-03-claude-usage-watch-design.md`

## Global Constraints

- Bun ≥ 1.3.13. TypeScript. **Zero runtime dependencies** — no package may be added to `dependencies`.
- macOS only. `security(1)` and the `claude` CLI must be on `PATH`.
- **No token may ever be written to disk by `cuw`, printed to stdout/stderr, or included in an error message.** Every error carries a structured cause, never a raw response body that could echo a credential.
- No magic numbers. Thresholds, timeouts, service names, and header keys live in `src/constants.ts`.
- Files stay under 400 lines. One responsibility per file.
- Test coverage target 80%+, verified with `bun test --coverage`.
- Subscription accounts only. No API-key, Bedrock, or Vertex support.
- Non-goals from the spec are binding: no account pooling, no sharing, no automatic routing of real work between accounts, no background scheduler.

## A note on git

This directory is not yet a git repository. Task 1 initializes it, and every task
ends with a commit — that is the plan's TDD hygiene, scoped entirely to this new
local repo. Nothing is ever pushed anywhere. Starting execution is your
authorization for those local commits; say so if you'd rather I strip them.

## File Structure

| File | Responsibility |
|---|---|
| `src/types.ts` | Shared record types (`Account`, `UsageWindows`, `AccountUsage`, `UsageError`). Types only, no logic. |
| `src/constants.ts` | Thresholds, timeouts, service names, endpoint candidates, header keys, prime flags. |
| `src/registry.ts` | `~/.config/cuw/accounts.json` load/save/validate. Secret-free. |
| `src/keychain.ts` | `security(1)` wrapper behind an injected process runner. |
| `src/usage-api.ts` | Usage endpoint client + response normalization. |
| `src/usage-probe.ts` | Fallback path: minimal request with `--debug api`, rate-limit header parse. |
| `src/usage.ts` | Per-account orchestration and the API→probe fallback policy. |
| `src/classify.ts` | State classification + recommendation. Pure. |
| `src/render.ts` | Table, bars, colour, duration formatting. Pure. |
| `src/prime.ts` | Isolated `claude -p` invocation and post-prime confirmation. |
| `src/commands/status.ts` | `cuw` / `cuw status` / `--json`. |
| `src/commands/add.ts` | `cuw add <id>`. |
| `src/commands/rm.ts` | `cuw rm <id>`. |
| `src/commands/prime.ts` | `cuw prime <id>` / `--cold`. |
| `src/commands/doctor.ts` | `cuw doctor`. |
| `src/cli.ts` | Argument parsing and dispatch. Entry point. |

`src/types.ts` is a refinement over the spec's file list: the spec defined
`AccountUsage` inline, and a shared types module keeps every consumer importing
one definition rather than re-declaring it.

---

### Task 1: Project scaffold and registry

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`
- Create: `src/types.ts`, `src/constants.ts`, `src/registry.ts`
- Test: `tests/registry.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Account = { id: string; label: string; email: string; order: number }`
  - `registryPath(home: string): string`
  - `loadRegistry(path: string): Promise<Account[]>`
  - `saveRegistry(path: string, accounts: Account[]): Promise<void>`
  - `class RegistryError extends Error { constructor(message: string, readonly cause: 'malformed' | 'duplicate-id' | 'invalid-id') }`

- [ ] **Step 1: Initialize the project**

```bash
cd <repo-root>
git init
bun init -y
mkdir -p src/commands tests/fixtures
```

- [ ] **Step 2: Replace `package.json`**

```json
{
  "name": "claude-usage-watch",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "module": "src/cli.ts",
  "scripts": {
    "test": "bun test",
    "coverage": "bun test --coverage",
    "build": "bun build --compile --minify src/cli.ts --outfile dist/cuw"
  },
  "devDependencies": {
    "@types/bun": "latest"
  }
}
```

- [ ] **Step 3: Write `.gitignore`**

```
node_modules/
dist/
*.log
.DS_Store
```

- [ ] **Step 4: Write the failing test**

Create `tests/registry.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRegistry, saveRegistry, registryPath, RegistryError } from '../src/registry'

const scratch = () => mkdtemp(join(tmpdir(), 'cuw-test-'))

describe('registryPath', () => {
  test('resolves under the XDG config directory', () => {
    expect(registryPath('/Users/x')).toBe('/Users/x/.config/cuw/accounts.json')
  })
})

describe('loadRegistry', () => {
  test('returns an empty list when the file does not exist', async () => {
    const dir = await scratch()
    expect(await loadRegistry(join(dir, 'accounts.json'))).toEqual([])
  })

  test('returns accounts sorted by order', async () => {
    const dir = await scratch()
    const path = join(dir, 'accounts.json')
    await writeFile(path, JSON.stringify([
      { id: 'b', label: 'B', email: 'b@x.com', order: 2 },
      { id: 'a', label: 'A', email: 'a@x.com', order: 1 },
    ]))
    const accounts = await loadRegistry(path)
    expect(accounts.map(a => a.id)).toEqual(['a', 'b'])
  })

  test('throws a malformed RegistryError on invalid JSON', async () => {
    const dir = await scratch()
    const path = join(dir, 'accounts.json')
    await writeFile(path, '{ not json')
    expect(loadRegistry(path)).rejects.toThrow(RegistryError)
  })

  test('throws when an entry is missing a required field', async () => {
    const dir = await scratch()
    const path = join(dir, 'accounts.json')
    await writeFile(path, JSON.stringify([{ id: 'a', label: 'A' }]))
    expect(loadRegistry(path)).rejects.toThrow(/missing/i)
  })

  test('throws on duplicate ids', async () => {
    const dir = await scratch()
    const path = join(dir, 'accounts.json')
    await writeFile(path, JSON.stringify([
      { id: 'a', label: 'A', email: 'a@x.com', order: 1 },
      { id: 'a', label: 'A2', email: 'a2@x.com', order: 2 },
    ]))
    expect(loadRegistry(path)).rejects.toThrow(/duplicate/i)
  })
})

describe('saveRegistry', () => {
  test('creates the parent directory and round-trips', async () => {
    const dir = await scratch()
    const path = join(dir, 'nested', 'accounts.json')
    const accounts = [{ id: 'a', label: 'A', email: 'a@x.com', order: 1 }]
    await saveRegistry(path, accounts)
    expect(await loadRegistry(path)).toEqual(accounts)
  })

  test('rejects ids that are not slug-safe', async () => {
    const dir = await scratch()
    const path = join(dir, 'accounts.json')
    expect(saveRegistry(path, [{ id: 'bad id!', label: 'X', email: 'x@x.com', order: 1 }]))
      .rejects.toThrow(/invalid id/i)
  })
})
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `bun test tests/registry.test.ts`
Expected: FAIL — `Cannot find module '../src/registry'`

- [ ] **Step 6: Write `src/types.ts`**

```ts
export type Account = {
  id: string
  label: string
  email: string
  order: number
}

/** Usage figures for one account, independent of which path produced them. */
export type UsageWindows = {
  /** null means no active five-hour window. */
  fiveHourPct: number | null
  fiveHourResetsAt: Date | null
  weeklyPct: number | null
  weeklyResetsAt: Date | null
  /** null when the plan exposes no separate Opus limit. */
  opusWeeklyPct: number | null
}

export type UsageErrorCause =
  | 'no-token'
  | 'auth'
  | 'network'
  | 'schema'
  | 'probe-failed'

export type UsageError = {
  cause: UsageErrorCause
  /** Safe for display. Never contains a token or a raw response body. */
  message: string
}

export type AccountUsage = UsageWindows & {
  id: string
  label: string
  source: 'api' | 'probe' | 'none'
  error: UsageError | null
}
```

- [ ] **Step 7: Write `src/constants.ts`**

```ts
/** Keychain generic-password service holding one long-lived token per account. */
export const KEYCHAIN_SERVICE = 'cuw-token'

/** At or above this five-hour percentage an account is 'hot'. */
export const HOT_THRESHOLD_PCT = 70

/** An account at or above this percentage is 'spent'. */
export const SPENT_THRESHOLD_PCT = 100

/** Per-account timeout for a usage request. */
export const REQUEST_TIMEOUT_MS = 8_000

/** Timeout for one priming session. */
export const PRIME_TIMEOUT_MS = 60_000

/** Cheapest model; the five-hour window is per account, so any model opens it. */
export const PRIME_MODEL = 'haiku'

/** The entire priming prompt. */
export const PRIME_PROMPT = 'hi'

/** Width of the usage bar, in cells. */
export const BAR_CELLS = 9

/** Fallback terminal width when stdout reports none. */
export const DEFAULT_TERM_WIDTH = 80

/**
 * Candidate usage endpoints, tried in order. Confirmed and pruned to the single
 * working entry during Task 3's spike.
 */
export const USAGE_ENDPOINTS = [
  'https://api.anthropic.com/api/oauth/usage',
  'https://api.anthropic.com/api/oauth/profile',
] as const

/**
 * Rate-limit response headers read by the probe path. Values are confirmed
 * against a real debug log in Task 5; the parser and its tests reference these
 * constants, so a correction here needs no test changes.
 */
export const HEADER_KEYS = {
  fiveHourStatus: 'anthropic-ratelimit-unified-5h-status',
  fiveHourReset: 'anthropic-ratelimit-unified-5h-reset',
  fiveHourRemaining: 'anthropic-ratelimit-unified-5h-remaining',
  weeklyStatus: 'anthropic-ratelimit-unified-7d-status',
  weeklyReset: 'anthropic-ratelimit-unified-7d-reset',
  weeklyRemaining: 'anthropic-ratelimit-unified-7d-remaining',
  opusWeeklyRemaining: 'anthropic-ratelimit-unified-7d-opus-remaining',
} as const
```

- [ ] **Step 8: Write `src/registry.ts`**

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Account } from './types'

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/

export type RegistryErrorCause = 'malformed' | 'duplicate-id' | 'invalid-id'

export class RegistryError extends Error {
  constructor(message: string, readonly cause: RegistryErrorCause) {
    super(message)
    this.name = 'RegistryError'
  }
}

export function registryPath(home: string): string {
  return join(home, '.config', 'cuw', 'accounts.json')
}

function assertAccount(raw: unknown, index: number): Account {
  if (typeof raw !== 'object' || raw === null) {
    throw new RegistryError(`entry ${index} is not an object`, 'malformed')
  }
  const entry = raw as Record<string, unknown>
  for (const field of ['id', 'label', 'email'] as const) {
    if (typeof entry[field] !== 'string' || entry[field] === '') {
      throw new RegistryError(`entry ${index} is missing "${field}"`, 'malformed')
    }
  }
  if (typeof entry.order !== 'number') {
    throw new RegistryError(`entry ${index} is missing "order"`, 'malformed')
  }
  const id = entry.id as string
  if (!ID_PATTERN.test(id)) {
    throw new RegistryError(`invalid id "${id}": use lowercase letters, digits, - and _`, 'invalid-id')
  }
  return { id, label: entry.label as string, email: entry.email as string, order: entry.order }
}

function assertUniqueIds(accounts: Account[]): void {
  const seen = new Set<string>()
  for (const account of accounts) {
    if (seen.has(account.id)) {
      throw new RegistryError(`duplicate id "${account.id}"`, 'duplicate-id')
    }
    seen.add(account.id)
  }
}

export async function loadRegistry(path: string): Promise<Account[]> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new RegistryError(`${path} is not valid JSON`, 'malformed')
  }
  if (!Array.isArray(parsed)) {
    throw new RegistryError(`${path} must contain a JSON array`, 'malformed')
  }
  const accounts = parsed.map(assertAccount)
  assertUniqueIds(accounts)
  return [...accounts].sort((a, b) => a.order - b.order)
}

export async function saveRegistry(path: string, accounts: Account[]): Promise<void> {
  const validated = accounts.map(assertAccount)
  assertUniqueIds(validated)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(validated, null, 2)}\n`, 'utf8')
}
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `bun test tests/registry.test.ts`
Expected: PASS — 8 tests

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: project scaffold, shared types, constants, and account registry"
```

---

### Task 2: Keychain wrapper

**Files:**
- Create: `src/keychain.ts`
- Test: `tests/keychain.test.ts`

**Interfaces:**
- Consumes: `KEYCHAIN_SERVICE` from `src/constants.ts`.
- Produces:
  - `type RunResult = { code: number; stdout: string; stderr: string }`
  - `type Runner = (argv: string[]) => Promise<RunResult>`
  - `const realRunner: Runner`
  - `type Keychain = { get(id: string): Promise<string | null>; set(id: string, token: string): Promise<void>; remove(id: string): Promise<void> }`
  - `createKeychain(run: Runner): Keychain`

**Known limitation to document in the code:** `security add-generic-password`
takes the secret as an argv value, so the token is briefly visible to other
processes running as the same user. There is no stdin mode for that subcommand.
This is accepted for a single-user local Mac and noted in a comment; the token
still never reaches disk, shell history, or a log.

- [ ] **Step 1: Write the failing test**

Create `tests/keychain.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/keychain.test.ts`
Expected: FAIL — `Cannot find module '../src/keychain'`

- [ ] **Step 3: Write `src/keychain.ts`**

```ts
import { KEYCHAIN_SERVICE } from './constants'

export type RunResult = { code: number; stdout: string; stderr: string }
export type Runner = (argv: string[]) => Promise<RunResult>

/** `security` exit code for "the specified item could not be found". */
const NOT_FOUND_CODE = 44

export const realRunner: Runner = async argv => {
  const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

export type Keychain = {
  get(id: string): Promise<string | null>
  set(id: string, token: string): Promise<void>
  remove(id: string): Promise<void>
}

export function createKeychain(run: Runner): Keychain {
  return {
    async get(id) {
      const result = await run([
        'security', 'find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', id, '-w',
      ])
      if (result.code === 0) return result.stdout.trim()
      if (result.code === NOT_FOUND_CODE) return null
      // Deliberately does not include stderr: it can echo the queried item.
      throw new Error(`keychain read failed for "${id}" (exit ${result.code})`)
    },

    async set(id, token) {
      // `security add-generic-password` has no stdin mode, so the token is passed
      // as an argv value and is briefly visible to same-user processes. Accepted
      // for a single-user local Mac; the token still never touches disk or history.
      const result = await run([
        'security', 'add-generic-password', '-U',
        '-s', KEYCHAIN_SERVICE, '-a', id, '-w', token,
        '-D', 'claude-usage-watch token',
      ])
      if (result.code !== 0) {
        // stderr is discarded: it may echo the argv containing the token.
        throw new Error(`keychain write failed for "${id}" (exit ${result.code})`)
      }
    },

    async remove(id) {
      const result = await run([
        'security', 'delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', id,
      ])
      if (result.code === 0 || result.code === NOT_FOUND_CODE) return
      throw new Error(`keychain delete failed for "${id}" (exit ${result.code})`)
    },
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/keychain.test.ts`
Expected: PASS — 7 tests

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: secret-safe keychain wrapper behind an injected runner"
```

---

### Task 3: Endpoint spike (investigation)

This task writes no production code. It resolves the design's one unknown and
produces a recorded fixture that Tasks 4 and 5 are built against.

**Files:**
- Create: `tests/fixtures/usage-api.json` *or* `tests/fixtures/probe-debug.log`
- Create: `docs/superpowers/notes/2026-08-03-endpoint-spike.md`
- Modify: `src/constants.ts` (prune `USAGE_ENDPOINTS`, correct `HEADER_KEYS`)

**Interfaces:**
- Consumes: `createKeychain`, `realRunner` from Task 2.
- Produces: a recorded fixture plus a decision recorded in the note — either
  `usage-api.ts` is viable (Task 4 proceeds) or it is dropped from v1 (Task 4
  is skipped and `usage-probe.ts` becomes the only path).

- [ ] **Step 1: Discover the endpoint from the installed CLI**

The `claude` binary is a JS bundle and contains the URLs it calls. Read them out
of the installed copy:

```bash
grep -oE 'https://api\.anthropic\.com/api/[a-zA-Z0-9_/.-]+' "$(readlink -f "$(which claude)")" | sort -u
```

Expected: a short list of API paths. Any path containing `usage`, `profile`, or
`rate_limit` is a candidate. Record the full list in the spike note.

- [ ] **Step 2: Ask the operator for permission to read the live token**

The Keychain read requires explicit approval — earlier attempts in this project
were blocked by the permission classifier. Ask before running Step 3, in these
terms: *"I need to read the token for your currently logged-in account from the
Keychain to probe the usage endpoint. It stays in memory, is never printed, and
is used for one GET request."*

- [ ] **Step 3: Probe each candidate**

For each candidate URL from Step 1, run a request that prints only the status
code and the response shape — never the token, never a raw body containing one:

```bash
TOKEN="$(security find-generic-password -s 'Claude Code-credentials' -w | bun -e 'const d=JSON.parse(await Bun.stdin.text()); console.log(d.claudeAiOauth?.accessToken ?? "")')"
for url in <candidates from step 1>; do
  echo "=== $url"
  curl -s -o /tmp/cuw-probe.json -w '%{http_code}\n' \
    -H "Authorization: Bearer $TOKEN" \
    -H "anthropic-beta: oauth-2025-04-20" \
    -H "User-Agent: claude-cli/$(claude --version | awk '{print $1}')" \
    "$url"
  bun -e 'console.log(JSON.stringify(Object.keys(JSON.parse(await Bun.file("/tmp/cuw-probe.json").text())), null, 0))' 2>/dev/null
done
unset TOKEN
```

Expected: one candidate returns HTTP 200 with a JSON body containing five-hour
and seven-day limit figures.

- [ ] **Step 4: Record the outcome**

**If a candidate returned 200 with usage figures:**

```bash
cp /tmp/cuw-probe.json tests/fixtures/usage-api.json
rm -f /tmp/cuw-probe.json
```

Inspect the fixture and confirm it contains no token, no refresh token, and no
email beyond what the registry already stores. Redact anything else. Prune
`USAGE_ENDPOINTS` in `src/constants.ts` to the single working URL.

**If no candidate worked:** capture the probe path's raw material instead —

```bash
mkdir -p /tmp/cuw-scratch && cd /tmp/cuw-scratch
claude -p "hi" --model haiku --tools "" --safe-mode --no-session-persistence \
  --debug api --debug-file /tmp/cuw-debug.log
grep -i 'anthropic-ratelimit' /tmp/cuw-debug.log > tests/fixtures/probe-debug.log
```

Correct `HEADER_KEYS` in `src/constants.ts` to the header names actually
observed, then delete `/tmp/cuw-debug.log` (it may contain request bodies).

- [ ] **Step 5: Write the spike note**

Create `docs/superpowers/notes/2026-08-03-endpoint-spike.md` recording: the
candidate URLs found, which returned 200, the response field names mapped to
`UsageWindows` fields (or the header names observed), and the decision — *API
path viable* or *probe path only*. Task 4 reads this note for its field mapping.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: record usage endpoint spike results and fixture"
```

---

### Task 4: Usage API client

**Skip this task entirely if Task 3 concluded "probe path only."** In that case
`collectUsage` in Task 6 calls only the probe path, and its fallback test is
dropped.

**Files:**
- Create: `src/usage-api.ts`
- Test: `tests/usage-api.test.ts`

**Interfaces:**
- Consumes: `USAGE_ENDPOINTS`, `REQUEST_TIMEOUT_MS` from `src/constants.ts`; `UsageWindows` from `src/types.ts`; `tests/fixtures/usage-api.json` from Task 3.
- Produces:
  - `class SchemaError extends Error`
  - `class AuthError extends Error`
  - `normalizeApiResponse(raw: unknown): UsageWindows`
  - `fetchUsage(token: string, deps: { fetcher: typeof fetch; endpoint: string; timeoutMs: number }): Promise<UsageWindows>`

- [ ] **Step 1: Write the failing test**

Create `tests/usage-api.test.ts`. Replace the field names in `buildResponse`
with the ones recorded in the Task 3 spike note if they differ:

```ts
import { describe, expect, test } from 'bun:test'
import { AuthError, SchemaError, fetchUsage, normalizeApiResponse } from '../src/usage-api'
import fixture from './fixtures/usage-api.json'

const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('normalizeApiResponse', () => {
  test('maps the recorded fixture into UsageWindows', () => {
    const windows = normalizeApiResponse(fixture)
    expect(typeof windows.fiveHourPct === 'number' || windows.fiveHourPct === null).toBe(true)
    expect(typeof windows.weeklyPct === 'number' || windows.weeklyPct === null).toBe(true)
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/usage-api.test.ts`
Expected: FAIL — `Cannot find module '../src/usage-api'`

- [ ] **Step 3: Write `src/usage-api.ts`**

Adjust `FIELD_PATHS` to the field names recorded in the Task 3 spike note.

```ts
import type { UsageWindows } from './types'

export class SchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SchemaError'
  }
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

/**
 * Candidate field paths per window, in priority order. Populated from the
 * spike note; more than one is listed where the payload varies by plan.
 */
const FIELD_PATHS = {
  fiveHourPct: ['five_hour.utilization', 'five_hour.percent_used'],
  fiveHourResetsAt: ['five_hour.resets_at'],
  weeklyPct: ['seven_day.utilization', 'seven_day.percent_used'],
  weeklyResetsAt: ['seven_day.resets_at'],
  opusWeeklyPct: ['seven_day_opus.utilization', 'seven_day_opus.percent_used'],
} as const

function pick(source: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => {
    if (typeof value !== 'object' || value === null) return undefined
    return (value as Record<string, unknown>)[key]
  }, source)
}

function firstNumber(source: Record<string, unknown>, paths: readonly string[]): number | null {
  for (const path of paths) {
    const value = pick(source, path)
    if (typeof value === 'number' && Number.isFinite(value)) {
      // Payloads express utilization either as 0-1 or as 0-100.
      return value <= 1 ? Math.round(value * 100) : Math.round(value)
    }
  }
  return null
}

function firstDate(source: Record<string, unknown>, paths: readonly string[]): Date | null {
  for (const path of paths) {
    const value = pick(source, path)
    if (typeof value === 'string') {
      const parsed = new Date(value)
      if (!Number.isNaN(parsed.getTime())) return parsed
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      // Epoch seconds.
      return new Date(value * 1000)
    }
  }
  return null
}

export function normalizeApiResponse(raw: unknown): UsageWindows {
  if (typeof raw !== 'object' || raw === null) {
    throw new SchemaError('usage response was not a JSON object')
  }
  const source = raw as Record<string, unknown>
  const windows: UsageWindows = {
    fiveHourPct: firstNumber(source, FIELD_PATHS.fiveHourPct),
    fiveHourResetsAt: firstDate(source, FIELD_PATHS.fiveHourResetsAt),
    weeklyPct: firstNumber(source, FIELD_PATHS.weeklyPct),
    weeklyResetsAt: firstDate(source, FIELD_PATHS.weeklyResetsAt),
    opusWeeklyPct: firstNumber(source, FIELD_PATHS.opusWeeklyPct),
  }
  const recognized =
    windows.fiveHourPct !== null ||
    windows.weeklyPct !== null ||
    windows.fiveHourResetsAt !== null
  if (!recognized) {
    throw new SchemaError('usage response contained no recognized limit fields')
  }
  return windows
}

export async function fetchUsage(
  token: string,
  deps: { fetcher: typeof fetch; endpoint: string; timeoutMs: number },
): Promise<UsageWindows> {
  const response = await deps.fetcher(deps.endpoint, {
    headers: {
      authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(deps.timeoutMs),
  })

  if (response.status === 401 || response.status === 403) {
    // The body is discarded: it can echo credential material.
    throw new AuthError(`token rejected (HTTP ${response.status})`)
  }
  if (!response.ok) {
    throw new SchemaError(`usage request failed (HTTP ${response.status})`)
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new SchemaError('usage response was not valid JSON')
  }
  return normalizeApiResponse(payload)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/usage-api.test.ts`
Expected: PASS — 8 tests. If `normalizeApiResponse` throws on the recorded
fixture, correct `FIELD_PATHS` to match the fixture's actual field names; do not
weaken the test.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: usage API client with schema-validated normalization"
```

---

### Task 5: Probe fallback path

**Files:**
- Create: `src/usage-probe.ts`
- Test: `tests/usage-probe.test.ts`
- Create: `tests/fixtures/probe-debug.log` (if Task 3 did not already create it)

**Interfaces:**
- Consumes: `HEADER_KEYS`, `PRIME_MODEL`, `PRIME_PROMPT`, `PRIME_TIMEOUT_MS` from `src/constants.ts`; `Runner` from `src/keychain.ts`; `UsageWindows` from `src/types.ts`.
- Produces:
  - `parseRateLimitHeaders(debugLog: string): UsageWindows`
  - `probeUsage(token: string, deps: { run: Runner; configDir: string; logPath: string; readLog: (path: string) => Promise<string> }): Promise<UsageWindows>`

`ProbeDeps` has no `scratchDir`: `Runner` takes argv only and cannot set a working
directory, and macOS `env` has no `-C` flag. Isolation for the probe comes from
`CLAUDE_CONFIG_DIR` plus `--safe-mode` alone. `prime.ts` (Task 11) uses a richer
`Spawner` that *does* set `cwd`.

**Note:** a probe both measures and primes, because it sends a real request.
Callers must surface that. `collectUsage` marks such rows `source: 'probe'` and
`render` flags them.

- [ ] **Step 1: Create the fixture if Task 3 did not**

If `tests/fixtures/probe-debug.log` does not exist, create it with header lines
using the exact names in `HEADER_KEYS`:

```
[api] response header anthropic-ratelimit-unified-5h-status: allowed
[api] response header anthropic-ratelimit-unified-5h-remaining: 0.88
[api] response header anthropic-ratelimit-unified-5h-reset: 1785700000
[api] response header anthropic-ratelimit-unified-7d-status: allowed
[api] response header anthropic-ratelimit-unified-7d-remaining: 0.66
[api] response header anthropic-ratelimit-unified-7d-reset: 1786100000
```

- [ ] **Step 2: Write the failing test**

Create `tests/usage-probe.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { parseRateLimitHeaders, probeUsage } from '../src/usage-probe'
import { HEADER_KEYS } from '../src/constants'
import type { RunResult, Runner } from '../src/keychain'

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
})

describe('probeUsage', () => {
  const deps = (result: RunResult, log: string) => {
    const calls: string[][] = []
    const run: Runner = async argv => {
      calls.push(argv)
      return result
    }
    return {
      calls,
      deps: {
        run,
        configDir: '/tmp/cuw-profile',
        logPath: '/tmp/cuw-debug.log',
        readLog: async () => log,
      },
    }
  }

  test('invokes claude with the minimal isolated flag set', async () => {
    const { calls, deps: d } = deps({ code: 0, stdout: '', stderr: '' }, SAMPLE)
    await probeUsage('tok', d)
    const argv = calls[0].join(' ')
    expect(argv).toContain('--safe-mode')
    expect(argv).toContain('--no-session-persistence')
    expect(argv).toContain('--debug api')
    expect(argv).not.toContain('tok')
  })

  test('throws when the claude invocation fails', async () => {
    const { deps: d } = deps({ code: 1, stdout: '', stderr: 'nope' }, '')
    expect(probeUsage('tok', d)).rejects.toThrow(/probe failed/i)
  })

  test('returns parsed windows on success', async () => {
    const { deps: d } = deps({ code: 0, stdout: '', stderr: '' }, SAMPLE)
    expect((await probeUsage('tok', d)).fiveHourPct).toBe(12)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test tests/usage-probe.test.ts`
Expected: FAIL — `Cannot find module '../src/usage-probe'`

- [ ] **Step 4: Write `src/usage-probe.ts`**

```ts
import { HEADER_KEYS, PRIME_MODEL, PRIME_PROMPT } from './constants'
import type { Runner } from './keychain'
import type { UsageWindows } from './types'

/** Matches `... <header-name>: <value>` anywhere in a debug log line. */
function headerMap(debugLog: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of debugLog.split('\n')) {
    const match = line.match(/([A-Za-z0-9-]*ratelimit[A-Za-z0-9-]*)\s*:\s*(\S+)/i)
    if (match) map.set(match[1].toLowerCase(), match[2])
  }
  return map
}

/** Remaining is a 0-1 fraction of budget left; we report percentage used. */
function usedPct(map: Map<string, string>, key: string): number | null {
  const raw = map.get(key.toLowerCase())
  if (raw === undefined) return null
  const remaining = Number(raw)
  if (!Number.isFinite(remaining)) return null
  const fraction = remaining <= 1 ? remaining : remaining / 100
  return Math.round((1 - fraction) * 100)
}

function resetDate(map: Map<string, string>, key: string): Date | null {
  const raw = map.get(key.toLowerCase())
  if (raw === undefined) return null
  const epochSeconds = Number(raw)
  if (Number.isFinite(epochSeconds)) return new Date(epochSeconds * 1000)
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export function parseRateLimitHeaders(debugLog: string): UsageWindows {
  const map = headerMap(debugLog)
  return {
    fiveHourPct: usedPct(map, HEADER_KEYS.fiveHourRemaining),
    fiveHourResetsAt: resetDate(map, HEADER_KEYS.fiveHourReset),
    weeklyPct: usedPct(map, HEADER_KEYS.weeklyRemaining),
    weeklyResetsAt: resetDate(map, HEADER_KEYS.weeklyReset),
    opusWeeklyPct: usedPct(map, HEADER_KEYS.opusWeeklyRemaining),
  }
}

export type ProbeDeps = {
  run: Runner
  configDir: string
  logPath: string
  readLog: (path: string) => Promise<string>
}

export async function probeUsage(token: string, deps: ProbeDeps): Promise<UsageWindows> {
  const result = await deps.run([
    'env',
    `CLAUDE_CODE_OAUTH_TOKEN=${token}`,
    `CLAUDE_CONFIG_DIR=${deps.configDir}`,
    'claude', '-p', PRIME_PROMPT,
    '--model', PRIME_MODEL,
    '--tools', '',
    '--safe-mode',
    '--no-session-persistence',
    '--debug', 'api',
    '--debug-file', deps.logPath,
  ])
  if (result.code !== 0) {
    // stderr is discarded: the debug stream can contain request material.
    throw new Error(`probe failed (exit ${result.code})`)
  }
  return parseRateLimitHeaders(await deps.readLog(deps.logPath))
}
```

Note the token is passed through `env` argv, which the test asserts is not part
of the `claude` flag string. Task 11 replaces this with a real environment map
for the production spawn; the `Runner` interface keeps the unit test honest.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/usage-probe.test.ts`
Expected: PASS — 8 tests

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: probe fallback that reads rate-limit headers from a debug log"
```

---

### Task 6: Usage orchestration and fallback policy

**Files:**
- Create: `src/usage.ts`
- Test: `tests/usage.test.ts`

**Interfaces:**
- Consumes: `Account`, `AccountUsage`, `UsageWindows`, `UsageError` from `src/types.ts`; `Keychain` from `src/keychain.ts`; `AuthError`, `SchemaError` from `src/usage-api.ts`.
- Produces:
  - `type UsageDeps = { keychain: Keychain; fetchWindows: (token: string) => Promise<UsageWindows>; probeWindows: (token: string) => Promise<UsageWindows> }`
  - `collectUsage(accounts: Account[], deps: UsageDeps): Promise<AccountUsage[]>`

- [ ] **Step 1: Write the failing test**

Create `tests/usage.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { collectUsage, type UsageDeps } from '../src/usage'
import { AuthError, SchemaError } from '../src/usage-api'
import type { Account, UsageWindows } from '../src/types'

const WINDOWS: UsageWindows = {
  fiveHourPct: 20,
  fiveHourResetsAt: new Date('2026-08-03T12:00:00Z'),
  weeklyPct: 30,
  weeklyResetsAt: new Date('2026-08-08T12:00:00Z'),
  opusWeeklyPct: null,
}

const accounts: Account[] = [
  { id: 'a', label: 'A', email: 'a@x.com', order: 1 },
  { id: 'b', label: 'B', email: 'b@x.com', order: 2 },
]

function deps(overrides: Partial<UsageDeps> = {}): UsageDeps {
  return {
    keychain: {
      get: async () => 'tok',
      set: async () => {},
      remove: async () => {},
    },
    fetchWindows: async () => WINDOWS,
    probeWindows: async () => WINDOWS,
    ...overrides,
  }
}

describe('collectUsage', () => {
  test('returns one row per account, in order', async () => {
    const rows = await collectUsage(accounts, deps())
    expect(rows.map(r => r.id)).toEqual(['a', 'b'])
    expect(rows.every(r => r.source === 'api')).toBe(true)
  })

  test('marks an account with no stored token', async () => {
    const rows = await collectUsage(accounts, deps({ keychain: {
      get: async (id: string) => (id === 'a' ? null : 'tok'),
      set: async () => {}, remove: async () => {},
    } }))
    expect(rows[0].error?.cause).toBe('no-token')
    expect(rows[0].source).toBe('none')
    expect(rows[1].error).toBeNull()
  })

  test('does not fall back to probe on an auth failure', async () => {
    let probed = false
    const rows = await collectUsage(accounts, deps({
      fetchWindows: async () => { throw new AuthError('token rejected (HTTP 401)') },
      probeWindows: async () => { probed = true; return WINDOWS },
    }))
    expect(probed).toBe(false)
    expect(rows[0].error?.cause).toBe('auth')
  })

  test('falls back to probe on a schema failure', async () => {
    const rows = await collectUsage(accounts, deps({
      fetchWindows: async () => { throw new SchemaError('unrecognized') },
    }))
    expect(rows[0].source).toBe('probe')
    expect(rows[0].error).toBeNull()
    expect(rows[0].fiveHourPct).toBe(20)
  })

  test('falls back to probe on a network failure', async () => {
    const rows = await collectUsage(accounts, deps({
      fetchWindows: async () => { throw new TypeError('fetch failed') },
    }))
    expect(rows[0].source).toBe('probe')
  })

  test('reports probe-failed when both paths fail', async () => {
    const rows = await collectUsage(accounts, deps({
      fetchWindows: async () => { throw new SchemaError('unrecognized') },
      probeWindows: async () => { throw new Error('probe failed (exit 1)') },
    }))
    expect(rows[0].error?.cause).toBe('probe-failed')
    expect(rows[0].source).toBe('none')
    expect(rows[0].fiveHourPct).toBeNull()
  })

  test('one failing account does not affect the others', async () => {
    const rows = await collectUsage(accounts, deps({
      fetchWindows: async (token: string) => {
        if (token === 'bad') throw new AuthError('token rejected (HTTP 401)')
        return WINDOWS
      },
      keychain: {
        get: async (id: string) => (id === 'a' ? 'bad' : 'tok'),
        set: async () => {}, remove: async () => {},
      },
    }))
    expect(rows[0].error?.cause).toBe('auth')
    expect(rows[1].error).toBeNull()
    expect(rows[1].fiveHourPct).toBe(20)
  })

  test('runs accounts concurrently', async () => {
    let inFlight = 0
    let peak = 0
    await collectUsage(accounts, deps({
      fetchWindows: async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await Bun.sleep(10)
        inFlight -= 1
        return WINDOWS
      },
    }))
    expect(peak).toBe(2)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/usage.test.ts`
Expected: FAIL — `Cannot find module '../src/usage'`

- [ ] **Step 3: Write `src/usage.ts`**

```ts
import type { Keychain } from './keychain'
import type { Account, AccountUsage, UsageError, UsageWindows } from './types'
import { AuthError } from './usage-api'

export type UsageDeps = {
  keychain: Keychain
  fetchWindows: (token: string) => Promise<UsageWindows>
  probeWindows: (token: string) => Promise<UsageWindows>
}

const EMPTY_WINDOWS: UsageWindows = {
  fiveHourPct: null,
  fiveHourResetsAt: null,
  weeklyPct: null,
  weeklyResetsAt: null,
  opusWeeklyPct: null,
}

function failed(account: Account, error: UsageError): AccountUsage {
  return { ...EMPTY_WINDOWS, id: account.id, label: account.label, source: 'none', error }
}

async function collectOne(account: Account, deps: UsageDeps): Promise<AccountUsage> {
  const token = await deps.keychain.get(account.id)
  if (token === null) {
    return failed(account, {
      cause: 'no-token',
      message: `no token stored — run \`cuw add ${account.id}\``,
    })
  }

  try {
    const windows = await deps.fetchWindows(token)
    return { ...windows, id: account.id, label: account.label, source: 'api', error: null }
  } catch (error) {
    // A rejected token will be rejected by the probe too — do not spend a
    // request, and do not hide an expired credential behind a slower path.
    if (error instanceof AuthError) {
      return failed(account, {
        cause: 'auth',
        message: `token rejected — re-mint with \`cuw add ${account.id}\``,
      })
    }
  }

  try {
    const windows = await deps.probeWindows(token)
    return { ...windows, id: account.id, label: account.label, source: 'probe', error: null }
  } catch {
    return failed(account, {
      cause: 'probe-failed',
      message: 'both the usage API and the probe failed — run `cuw doctor`',
    })
  }
}

export async function collectUsage(accounts: Account[], deps: UsageDeps): Promise<AccountUsage[]> {
  return Promise.all(accounts.map(account => collectOne(account, deps)))
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/usage.test.ts`
Expected: PASS — 8 tests

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: per-account usage orchestration with API to probe fallback"
```

---

### Task 7: Classification and recommendation

**Files:**
- Create: `src/classify.ts`
- Test: `tests/classify.test.ts`

**Interfaces:**
- Consumes: `HOT_THRESHOLD_PCT`, `SPENT_THRESHOLD_PCT` from `src/constants.ts`; `AccountUsage` from `src/types.ts`.
- Produces:
  - `type State = 'cold' | 'warm' | 'hot' | 'spent' | 'unknown'`
  - `classify(row: AccountUsage): State`
  - `type Recommendation = { useId: string | null; reason: string; coldIds: string[]; earliestResetAt: Date | null }`
  - `recommend(rows: AccountUsage[]): Recommendation`

- [ ] **Step 1: Write the failing test**

Create `tests/classify.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { classify, recommend } from '../src/classify'
import type { AccountUsage } from '../src/types'

function row(partial: Partial<AccountUsage> & { id: string }): AccountUsage {
  return {
    label: partial.id.toUpperCase(),
    fiveHourPct: null,
    fiveHourResetsAt: null,
    weeklyPct: 0,
    weeklyResetsAt: null,
    opusWeeklyPct: null,
    source: 'api',
    error: null,
    ...partial,
  }
}

describe('classify', () => {
  test('no active window is cold', () => {
    expect(classify(row({ id: 'a', fiveHourPct: null }))).toBe('cold')
  })

  test('below the hot threshold is warm', () => {
    expect(classify(row({ id: 'a', fiveHourPct: 69 }))).toBe('warm')
  })

  test('at the hot threshold is hot', () => {
    expect(classify(row({ id: 'a', fiveHourPct: 70 }))).toBe('hot')
  })

  test('at the limit is spent', () => {
    expect(classify(row({ id: 'a', fiveHourPct: 100 }))).toBe('spent')
  })

  test('an errored row is unknown', () => {
    expect(classify(row({ id: 'a', fiveHourPct: 10, error: { cause: 'auth', message: 'x' } })))
      .toBe('unknown')
  })

  test('zero percent with an active window is warm, not cold', () => {
    expect(classify(row({ id: 'a', fiveHourPct: 0, fiveHourResetsAt: new Date() }))).toBe('warm')
  })
})

describe('recommend', () => {
  test('picks the account with the most five-hour headroom', () => {
    const result = recommend([
      row({ id: 'a', fiveHourPct: 80, fiveHourResetsAt: new Date() }),
      row({ id: 'b', fiveHourPct: 20, fiveHourResetsAt: new Date() }),
    ])
    expect(result.useId).toBe('b')
  })

  test('treats a cold account as maximum headroom', () => {
    const result = recommend([
      row({ id: 'a', fiveHourPct: 20, fiveHourResetsAt: new Date() }),
      row({ id: 'b', fiveHourPct: null }),
    ])
    expect(result.useId).toBe('b')
  })

  test('breaks a five-hour tie on weekly headroom', () => {
    const result = recommend([
      row({ id: 'a', fiveHourPct: 20, fiveHourResetsAt: new Date(), weeklyPct: 80 }),
      row({ id: 'b', fiveHourPct: 20, fiveHourResetsAt: new Date(), weeklyPct: 10 }),
    ])
    expect(result.useId).toBe('b')
  })

  test('excludes spent accounts', () => {
    const result = recommend([
      row({ id: 'a', fiveHourPct: 100, fiveHourResetsAt: new Date() }),
      row({ id: 'b', fiveHourPct: 90, fiveHourResetsAt: new Date() }),
    ])
    expect(result.useId).toBe('b')
  })

  test('excludes errored accounts', () => {
    const result = recommend([
      row({ id: 'a', fiveHourPct: null, error: { cause: 'auth', message: 'x' } }),
      row({ id: 'b', fiveHourPct: 90, fiveHourResetsAt: new Date() }),
    ])
    expect(result.useId).toBe('b')
  })

  test('lists cold accounts so the caller can nudge priming', () => {
    const result = recommend([
      row({ id: 'a', fiveHourPct: 20, fiveHourResetsAt: new Date() }),
      row({ id: 'b', fiveHourPct: null }),
      row({ id: 'c', fiveHourPct: null }),
    ])
    expect(result.coldIds).toEqual(['b', 'c'])
  })

  test('reports no usable account and the earliest reset when all are spent', () => {
    const early = new Date('2026-08-03T10:00:00Z')
    const late = new Date('2026-08-03T14:00:00Z')
    const result = recommend([
      row({ id: 'a', fiveHourPct: 100, fiveHourResetsAt: late }),
      row({ id: 'b', fiveHourPct: 100, fiveHourResetsAt: early }),
    ])
    expect(result.useId).toBeNull()
    expect(result.earliestResetAt).toEqual(early)
    expect(result.reason).toMatch(/all accounts/i)
  })

  test('handles an empty account list', () => {
    const result = recommend([])
    expect(result.useId).toBeNull()
    expect(result.coldIds).toEqual([])
    expect(result.earliestResetAt).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/classify.test.ts`
Expected: FAIL — `Cannot find module '../src/classify'`

- [ ] **Step 3: Write `src/classify.ts`**

```ts
import { HOT_THRESHOLD_PCT, SPENT_THRESHOLD_PCT } from './constants'
import type { AccountUsage } from './types'

export type State = 'cold' | 'warm' | 'hot' | 'spent' | 'unknown'

export function classify(row: AccountUsage): State {
  if (row.error !== null) return 'unknown'
  if (row.fiveHourPct === null) return 'cold'
  if (row.fiveHourPct >= SPENT_THRESHOLD_PCT) return 'spent'
  if (row.fiveHourPct >= HOT_THRESHOLD_PCT) return 'hot'
  return 'warm'
}

export type Recommendation = {
  useId: string | null
  reason: string
  coldIds: string[]
  earliestResetAt: Date | null
}

/** A cold account has its whole window available. */
function fiveHourHeadroom(row: AccountUsage): number {
  return row.fiveHourPct === null ? 100 : 100 - row.fiveHourPct
}

function weeklyHeadroom(row: AccountUsage): number {
  return row.weeklyPct === null ? 100 : 100 - row.weeklyPct
}

function earliestReset(rows: AccountUsage[]): Date | null {
  const resets = rows
    .map(row => row.fiveHourResetsAt)
    .filter((date): date is Date => date !== null)
  if (resets.length === 0) return null
  return resets.reduce((earliest, date) => (date < earliest ? date : earliest))
}

export function recommend(rows: AccountUsage[]): Recommendation {
  const coldIds = rows.filter(row => classify(row) === 'cold').map(row => row.id)
  const usable = rows.filter(row => {
    const state = classify(row)
    return state !== 'spent' && state !== 'unknown'
  })

  if (usable.length === 0) {
    return {
      useId: null,
      reason: rows.length === 0
        ? 'no accounts configured — run `cuw add <id>`'
        : 'all accounts are spent or unreachable',
      coldIds,
      earliestResetAt: earliestReset(rows),
    }
  }

  const best = [...usable].sort((a, b) => {
    const byFiveHour = fiveHourHeadroom(b) - fiveHourHeadroom(a)
    if (byFiveHour !== 0) return byFiveHour
    return weeklyHeadroom(b) - weeklyHeadroom(a)
  })[0]

  const state = classify(best)
  const reason = state === 'cold'
    ? `cold — run \`cuw prime ${best.id}\` to start its clock`
    : `${fiveHourHeadroom(best)}% of the five-hour window left`

  return { useId: best.id, reason, coldIds, earliestResetAt: earliestReset(rows) }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/classify.test.ts`
Expected: PASS — 15 tests

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: usage state classification and account recommendation"
```

---

### Task 8: Rendering

**Files:**
- Create: `src/render.ts`
- Test: `tests/render.test.ts`

**Interfaces:**
- Consumes: `BAR_CELLS`, `DEFAULT_TERM_WIDTH` from `src/constants.ts`; `AccountUsage` from `src/types.ts`; `classify`, `recommend`, `Recommendation`, `State` from `src/classify.ts`.
- Produces:
  - `formatDuration(ms: number): string`
  - `bar(pct: number | null): string`
  - `type RenderOptions = { color: boolean; width: number; now: Date }`
  - `renderTable(rows: AccountUsage[], rec: Recommendation, opts: RenderOptions): string`

`render.ts` performs no I/O and reads no environment. TTY-ness, terminal width,
and the current time are supplied by the caller — this is what keeps it testable.

- [ ] **Step 1: Write the failing test**

Create `tests/render.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { bar, formatDuration, renderTable } from '../src/render'
import { recommend } from '../src/classify'
import { BAR_CELLS } from '../src/constants'
import type { AccountUsage } from '../src/types'

const NOW = new Date('2026-08-03T08:00:00Z')
const OPTS = { color: false, width: 80, now: NOW }

function row(partial: Partial<AccountUsage> & { id: string }): AccountUsage {
  return {
    label: partial.id,
    fiveHourPct: null,
    fiveHourResetsAt: null,
    weeklyPct: 0,
    weeklyResetsAt: null,
    opusWeeklyPct: null,
    source: 'api',
    error: null,
    ...partial,
  }
}

describe('formatDuration', () => {
  test('renders hours and minutes', () => {
    expect(formatDuration(3 * 3_600_000 + 41 * 60_000)).toBe('3h41m')
  })

  test('renders minutes alone under an hour', () => {
    expect(formatDuration(47 * 60_000)).toBe('47m')
  })

  test('renders a dash for non-positive durations', () => {
    expect(formatDuration(0)).toBe('—')
    expect(formatDuration(-5)).toBe('—')
  })
})

describe('bar', () => {
  test('is fully empty at zero', () => {
    expect(bar(0)).toBe('░'.repeat(BAR_CELLS))
  })

  test('is fully filled at one hundred', () => {
    expect(bar(100)).toBe('▓'.repeat(BAR_CELLS))
  })

  test('renders an empty bar for a null percentage', () => {
    expect(bar(null)).toBe('░'.repeat(BAR_CELLS))
  })

  test('always has the configured width', () => {
    for (const pct of [1, 12, 50, 88, 99]) {
      expect(bar(pct)).toHaveLength(BAR_CELLS)
    }
  })
})

describe('renderTable', () => {
  const rows = [
    row({ id: 'main', fiveHourPct: 12, fiveHourResetsAt: new Date('2026-08-03T11:41:00Z'), weeklyPct: 34 }),
    row({ id: 'secondary', fiveHourPct: null, weeklyPct: 18 }),
  ]

  test('includes a line per account plus a header', () => {
    const output = renderTable(rows, recommend(rows), OPTS)
    expect(output).toContain('main')
    expect(output).toContain('secondary')
    expect(output).toContain('ACCOUNT')
  })

  test('shows the countdown to reset, not the absolute time', () => {
    expect(renderTable(rows, recommend(rows), OPTS)).toContain('3h41m')
  })

  test('shows a dash where there is no active window', () => {
    expect(renderTable(rows, recommend(rows), OPTS)).toContain('—')
  })

  test('emits no ANSI escapes when color is disabled', () => {
    // eslint-disable-next-line no-control-regex
    expect(renderTable(rows, recommend(rows), OPTS)).not.toMatch(/\[/)
  })

  test('emits ANSI escapes when color is enabled', () => {
    const output = renderTable(rows, recommend(rows), { ...OPTS, color: true })
    // eslint-disable-next-line no-control-regex
    expect(output).toMatch(/\[/)
  })

  test('renders the recommendation line', () => {
    const output = renderTable(rows, recommend(rows), OPTS)
    expect(output).toContain('→ use: secondary')
  })

  test('flags rows served by the probe path', () => {
    const probed = [row({ id: 'main', fiveHourPct: 10, source: 'probe' })]
    expect(renderTable(probed, recommend(probed), OPTS)).toContain('probe')
  })

  test('renders an error row without crashing', () => {
    const broken = [row({ id: 'main', error: { cause: 'auth', message: 'token rejected' } })]
    const output = renderTable(broken, recommend(broken), OPTS)
    expect(output).toContain('token rejected')
  })

  test('renders a first-run message for an empty list', () => {
    expect(renderTable([], recommend([]), OPTS)).toMatch(/cuw add/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/render.test.ts`
Expected: FAIL — `Cannot find module '../src/render'`

- [ ] **Step 3: Write `src/render.ts`**

```ts
import { BAR_CELLS } from './constants'
import { classify, type Recommendation, type State } from './classify'
import type { AccountUsage } from './types'

const MS_PER_MINUTE = 60_000
const MS_PER_HOUR = 3_600_000

const ANSI = {
  reset: '[0m',
  dim: '[2m',
  green: '[32m',
  yellow: '[33m',
  red: '[31m',
  cyan: '[36m',
} as const

const STATE_MARK: Record<State, string> = {
  cold: '○ cold',
  warm: '● warm',
  hot: '▲ hot',
  spent: '■ spent',
  unknown: '✗ error',
}

const STATE_COLOR: Record<State, string> = {
  cold: ANSI.cyan,
  warm: ANSI.green,
  hot: ANSI.yellow,
  spent: ANSI.red,
  unknown: ANSI.red,
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return '—'
  const hours = Math.floor(ms / MS_PER_HOUR)
  const minutes = Math.floor((ms % MS_PER_HOUR) / MS_PER_MINUTE)
  return hours > 0 ? `${hours}h${String(minutes).padStart(2, '0')}m` : `${minutes}m`
}

export function bar(pct: number | null): string {
  const filled = pct === null ? 0 : Math.round((Math.min(100, Math.max(0, pct)) / 100) * BAR_CELLS)
  return '▓'.repeat(filled) + '░'.repeat(BAR_CELLS - filled)
}

export type RenderOptions = { color: boolean; width: number; now: Date }

function paint(text: string, color: string, enabled: boolean): string {
  return enabled ? `${color}${text}${ANSI.reset}` : text
}

function pctText(pct: number | null): string {
  return pct === null ? '0%' : `${pct}%`
}

function resetText(row: AccountUsage, now: Date): string {
  if (row.fiveHourResetsAt === null) return '—'
  return formatDuration(row.fiveHourResetsAt.getTime() - now.getTime())
}

function renderRow(row: AccountUsage, opts: RenderOptions, labelWidth: number): string {
  const state = classify(row)
  const label = row.label.padEnd(labelWidth)

  if (row.error !== null) {
    const mark = paint(STATE_MARK.unknown, STATE_COLOR.unknown, opts.color)
    return `${label}  ${mark}  ${row.error.message}`
  }

  const cells = [
    label,
    pctText(row.fiveHourPct).padStart(4),
    bar(row.fiveHourPct),
    resetText(row, opts.now).padStart(6),
    pctText(row.weeklyPct).padStart(6),
    paint(STATE_MARK[state], STATE_COLOR[state], opts.color),
  ]
  const line = cells.join('  ')
  return row.source === 'probe' ? `${line}  ${paint('(probe)', ANSI.dim, opts.color)}` : line
}

export function renderTable(
  rows: AccountUsage[],
  rec: Recommendation,
  opts: RenderOptions,
): string {
  if (rows.length === 0) {
    return 'No subscriptions configured yet.\nAdd one with: cuw add <id>\n'
  }

  const labelWidth = Math.max(7, ...rows.map(row => row.label.length))
  const header = paint(
    `${'ACCOUNT'.padEnd(labelWidth)}  5H WINDOW${' '.repeat(BAR_CELLS - 3)}  RESETS  WEEKLY  STATE`,
    ANSI.dim,
    opts.color,
  )
  const rule = paint('─'.repeat(Math.min(opts.width, labelWidth + BAR_CELLS + 34)), ANSI.dim, opts.color)
  const body = rows.map(row => renderRow(row, opts, labelWidth))

  const footer = rec.useId === null
    ? `\n✗ ${rec.reason}${rec.earliestResetAt === null ? '' : ` (earliest reset in ${formatDuration(rec.earliestResetAt.getTime() - opts.now.getTime())})`}`
    : `\n→ use: ${rec.useId}  (${rec.reason})`

  return [header, rule, ...body, footer, ''].join('\n')
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/render.test.ts`
Expected: PASS — 17 tests

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: pure table renderer with bars, countdowns, and colour"
```

---

### Task 9: CLI entry point and `status` command

**Files:**
- Create: `src/commands/status.ts`, `src/cli.ts`
- Test: `tests/status.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–8.
- Produces:
  - `type Io = { out: (text: string) => void; err: (text: string) => void }`
  - `runStatus(args: { json: boolean }, deps: StatusDeps, io: Io): Promise<number>` — returns the process exit code
  - `type StatusDeps = { accounts: Account[]; usage: UsageDeps; color: boolean; width: number; now: Date }`
  - `main(argv: string[]): Promise<number>` in `src/cli.ts`

**Exit codes:** `0` success · `1` usage error (bad arguments) · `2` at least one
account has an auth error.

- [ ] **Step 1: Write the failing test**

Create `tests/status.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { runStatus, type StatusDeps } from '../src/commands/status'
import type { Account, UsageWindows } from '../src/types'

const NOW = new Date('2026-08-03T08:00:00Z')

const WINDOWS: UsageWindows = {
  fiveHourPct: 12,
  fiveHourResetsAt: new Date('2026-08-03T11:41:00Z'),
  weeklyPct: 34,
  weeklyResetsAt: null,
  opusWeeklyPct: null,
}

const accounts: Account[] = [{ id: 'main', label: 'main', email: 'm@x.com', order: 1 }]

function deps(overrides: Partial<StatusDeps> = {}): StatusDeps {
  return {
    accounts,
    color: false,
    width: 80,
    now: NOW,
    usage: {
      keychain: { get: async () => 'tok', set: async () => {}, remove: async () => {} },
      fetchWindows: async () => WINDOWS,
      probeWindows: async () => WINDOWS,
    },
    ...overrides,
  }
}

function captureIo() {
  const out: string[] = []
  const err: string[] = []
  return { io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) }, out, err }
}

describe('runStatus', () => {
  test('prints the table and exits 0', async () => {
    const { io, out } = captureIo()
    expect(await runStatus({ json: false }, deps(), io)).toBe(0)
    expect(out.join('')).toContain('main')
    expect(out.join('')).toContain('3h41m')
  })

  test('emits parseable JSON with --json', async () => {
    const { io, out } = captureIo()
    await runStatus({ json: true }, deps(), io)
    const parsed = JSON.parse(out.join(''))
    expect(parsed[0].id).toBe('main')
    expect(parsed[0].fiveHourPct).toBe(12)
    expect(parsed[0].state).toBe('warm')
  })

  test('JSON output never contains a token', async () => {
    const { io, out } = captureIo()
    await runStatus({ json: true }, deps(), io)
    expect(out.join('')).not.toContain('tok')
  })

  test('exits 2 when an account has an auth error', async () => {
    const { io } = captureIo()
    const code = await runStatus({ json: false }, deps({
      usage: {
        keychain: { get: async () => null, set: async () => {}, remove: async () => {} },
        fetchWindows: async () => WINDOWS,
        probeWindows: async () => WINDOWS,
      },
    }), io)
    expect(code).toBe(2)
  })

  test('exits 0 with the first-run message when no accounts exist', async () => {
    const { io, out } = captureIo()
    expect(await runStatus({ json: false }, deps({ accounts: [] }), io)).toBe(0)
    expect(out.join('')).toMatch(/cuw add/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/status.test.ts`
Expected: FAIL — `Cannot find module '../src/commands/status'`

- [ ] **Step 3: Write `src/commands/status.ts`**

```ts
import { classify, recommend } from '../classify'
import { renderTable } from '../render'
import type { Account } from '../types'
import { collectUsage, type UsageDeps } from '../usage'

export type Io = { out: (text: string) => void; err: (text: string) => void }

export type StatusDeps = {
  accounts: Account[]
  usage: UsageDeps
  color: boolean
  width: number
  now: Date
}

export const EXIT_OK = 0
export const EXIT_USAGE = 1
export const EXIT_AUTH = 2

export async function runStatus(
  args: { json: boolean },
  deps: StatusDeps,
  io: Io,
): Promise<number> {
  const rows = await collectUsage(deps.accounts, deps.usage)
  const rec = recommend(rows)

  if (args.json) {
    io.out(JSON.stringify(rows.map(row => ({ ...row, state: classify(row) })), null, 2))
  } else {
    io.out(renderTable(rows, rec, { color: deps.color, width: deps.width, now: deps.now }))
  }

  const hasAuthProblem = rows.some(
    row => row.error?.cause === 'auth' || row.error?.cause === 'no-token',
  )
  return hasAuthProblem ? EXIT_AUTH : EXIT_OK
}
```

- [ ] **Step 4: Write `src/cli.ts`**

```ts
#!/usr/bin/env bun
import { REQUEST_TIMEOUT_MS, USAGE_ENDPOINTS } from './constants'
import { createKeychain, realRunner } from './keychain'
import { loadRegistry, registryPath } from './registry'
import { fetchUsage } from './usage-api'
import { probeUsage } from './usage-probe'
import { EXIT_OK, EXIT_USAGE, runStatus, type Io } from './commands/status'
import { join } from 'node:path'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { UsageDeps } from './usage'

const HELP = `cuw — Claude subscription usage across accounts

Usage:
  cuw [status] [--json]     Show usage for every configured subscription
  cuw add <id>              Store a long-lived token for a subscription
  cuw rm <id>               Remove a subscription
  cuw prime <id>            Start the five-hour window on a subscription
  cuw prime --cold          Start the window on every idle subscription
  cuw doctor                Diagnose tokens and data paths
  cuw --help                Show this message
`

export function home(): string {
  const value = process.env.HOME
  if (!value) throw new Error('HOME is not set')
  return value
}

export function configHome(): string {
  return join(home(), '.config', 'cuw')
}

export async function buildUsageDeps(): Promise<UsageDeps> {
  const keychain = createKeychain(realRunner)
  const scratchDir = await mkdtemp(join(tmpdir(), 'cuw-scratch-'))
  return {
    keychain,
    fetchWindows: token =>
      fetchUsage(token, {
        fetcher: fetch,
        endpoint: USAGE_ENDPOINTS[0],
        timeoutMs: REQUEST_TIMEOUT_MS,
      }),
    probeWindows: token =>
      probeUsage(token, {
        run: realRunner,
        configDir: join(configHome(), 'profiles', 'probe'),
        logPath: join(scratchDir, 'debug.log'),
        readLog: path => readFile(path, 'utf8'),
      }),
  }
}

export async function main(argv: string[]): Promise<number> {
  const io: Io = {
    out: text => process.stdout.write(text.endsWith('\n') ? text : `${text}\n`),
    err: text => process.stderr.write(text.endsWith('\n') ? text : `${text}\n`),
  }

  if (argv.includes('--help') || argv.includes('-h')) {
    io.out(HELP)
    return EXIT_OK
  }

  const [command = 'status', ...rest] = argv
  const accounts = await loadRegistry(registryPath(home()))

  switch (command) {
    case 'status': {
      return runStatus(
        { json: rest.includes('--json') },
        {
          accounts,
          usage: await buildUsageDeps(),
          color: process.stdout.isTTY === true,
          width: process.stdout.columns ?? 80,
          now: new Date(),
        },
        io,
      )
    }
    default:
      io.err(`unknown command: ${command}\n`)
      io.err(HELP)
      return EXIT_USAGE
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2))
}
```

Tasks 10–12 add their cases to this `switch`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test`
Expected: PASS — all suites green.

- [ ] **Step 6: Verify the CLI runs end to end**

Run: `bun run src/cli.ts --help`
Expected: the help text, exit code 0.

Run: `bun run src/cli.ts`
Expected: with no registry yet, "No subscriptions configured yet."

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: cli entry point and status command with --json output"
```

---

### Task 10: `add` and `rm` commands

**Files:**
- Create: `src/commands/add.ts`, `src/commands/rm.ts`
- Modify: `src/cli.ts` (dispatch)
- Test: `tests/add.test.ts`, `tests/rm.test.ts`

**Interfaces:**
- Consumes: `Keychain`, `loadRegistry`, `saveRegistry`, `Io`, `UsageDeps`.
- Produces:
  - `runAdd(id: string, deps: AddDeps, io: Io): Promise<number>`
  - `type AddDeps = { registryFile: string; keychain: Keychain; readToken: () => Promise<string>; verify: (token: string) => Promise<void> }`
  - `runRm(id: string, deps: RmDeps, io: Io): Promise<number>`
  - `type RmDeps = { registryFile: string; keychain: Keychain; confirm: (prompt: string) => Promise<boolean> }`

The token is read from stdin, never from argv — an argv token would land in
shell history and in other users' `ps` output.

**On `label` and `email`:** `add` sets `label` to the id and leaves `email`
empty. The spec's registry reserves both fields, but the usage endpoint is not
guaranteed to return an email, and v1 has no need for one — the id is what every
command and the table use. Populating `email` is deliberately deferred rather
than guessed at.

- [ ] **Step 1: Write the failing tests**

Create `tests/add.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAdd, type AddDeps } from '../src/commands/add'
import { loadRegistry } from '../src/registry'

function captureIo() {
  const out: string[] = []
  return { io: { out: (t: string) => out.push(t), err: (t: string) => out.push(t) }, out }
}

async function deps(overrides: Partial<AddDeps> = {}): Promise<AddDeps> {
  const dir = await mkdtemp(join(tmpdir(), 'cuw-add-'))
  const stored = new Map<string, string>()
  return {
    registryFile: join(dir, 'accounts.json'),
    keychain: {
      get: async id => stored.get(id) ?? null,
      set: async (id, token) => { stored.set(id, token) },
      remove: async id => { stored.delete(id) },
    },
    readToken: async () => 'sk-ant-oat01-example',
    verify: async () => {},
    ...overrides,
  }
}

describe('runAdd', () => {
  test('stores the token and appends the account', async () => {
    const { io } = captureIo()
    const d = await deps()
    expect(await runAdd('main', d, io)).toBe(0)
    const accounts = await loadRegistry(d.registryFile)
    expect(accounts.map(a => a.id)).toEqual(['main'])
    expect(await d.keychain.get('main')).toBe('sk-ant-oat01-example')
  })

  test('never echoes the token', async () => {
    const { io, out } = captureIo()
    await runAdd('main', await deps(), io)
    expect(out.join('')).not.toContain('sk-ant-oat01-example')
  })

  test('rejects an empty token without writing anything', async () => {
    const { io } = captureIo()
    const d = await deps({ readToken: async () => '  ' })
    expect(await runAdd('main', d, io)).toBe(1)
    expect(await loadRegistry(d.registryFile)).toEqual([])
  })

  test('does not store a token that fails verification', async () => {
    const { io } = captureIo()
    const d = await deps({ verify: async () => { throw new Error('token rejected (HTTP 401)') } })
    expect(await runAdd('main', d, io)).toBe(2)
    expect(await d.keychain.get('main')).toBeNull()
    expect(await loadRegistry(d.registryFile)).toEqual([])
  })

  test('rejects a duplicate id', async () => {
    const { io } = captureIo()
    const d = await deps()
    await runAdd('main', d, io)
    expect(await runAdd('main', d, io)).toBe(1)
  })

  test('assigns increasing order values', async () => {
    const { io } = captureIo()
    const d = await deps()
    await runAdd('one', d, io)
    await runAdd('two', d, io)
    const accounts = await loadRegistry(d.registryFile)
    expect(accounts.map(a => a.order)).toEqual([1, 2])
  })
})
```

Create `tests/rm.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runRm, type RmDeps } from '../src/commands/rm'
import { loadRegistry, saveRegistry } from '../src/registry'

function captureIo() {
  const out: string[] = []
  return { io: { out: (t: string) => out.push(t), err: (t: string) => out.push(t) }, out }
}

async function deps(confirmValue = true): Promise<RmDeps & { stored: Map<string, string> }> {
  const dir = await mkdtemp(join(tmpdir(), 'cuw-rm-'))
  const registryFile = join(dir, 'accounts.json')
  await saveRegistry(registryFile, [{ id: 'main', label: 'main', email: 'm@x.com', order: 1 }])
  const stored = new Map([['main', 'tok']])
  return {
    registryFile,
    stored,
    keychain: {
      get: async id => stored.get(id) ?? null,
      set: async (id, token) => { stored.set(id, token) },
      remove: async id => { stored.delete(id) },
    },
    confirm: async () => confirmValue,
  }
}

describe('runRm', () => {
  test('removes the registry entry and the keychain item', async () => {
    const { io } = captureIo()
    const d = await deps()
    expect(await runRm('main', d, io)).toBe(0)
    expect(await loadRegistry(d.registryFile)).toEqual([])
    expect(d.stored.has('main')).toBe(false)
  })

  test('does nothing when the confirmation is declined', async () => {
    const { io } = captureIo()
    const d = await deps(false)
    expect(await runRm('main', d, io)).toBe(0)
    expect((await loadRegistry(d.registryFile)).length).toBe(1)
    expect(d.stored.has('main')).toBe(true)
  })

  test('reports an unknown id', async () => {
    const { io, out } = captureIo()
    const d = await deps()
    expect(await runRm('nope', d, io)).toBe(1)
    expect(out.join('')).toMatch(/not configured/i)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/add.test.ts tests/rm.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write `src/commands/add.ts`**

```ts
import type { Keychain } from '../keychain'
import { loadRegistry, saveRegistry } from '../registry'
import type { Io } from './status'

export type AddDeps = {
  registryFile: string
  keychain: Keychain
  readToken: () => Promise<string>
  verify: (token: string) => Promise<void>
}

const INSTRUCTIONS = `Log into this subscription in another terminal, then run:

  claude setup-token

Paste the token it prints below and press Enter. It is read from stdin, so it
never reaches your shell history.
`

export async function runAdd(id: string, deps: AddDeps, io: Io): Promise<number> {
  const accounts = await loadRegistry(deps.registryFile)
  if (accounts.some(account => account.id === id)) {
    io.err(`"${id}" is already configured — remove it first with \`cuw rm ${id}\``)
    return 1
  }

  io.out(INSTRUCTIONS)
  const token = (await deps.readToken()).trim()
  if (token === '') {
    io.err('no token entered; nothing was stored')
    return 1
  }

  try {
    await deps.verify(token)
  } catch (error) {
    // The verifier's message is already token-free by construction.
    io.err(`token verification failed: ${(error as Error).message}`)
    io.err('nothing was stored')
    return 2
  }

  await deps.keychain.set(id, token)
  const order = accounts.reduce((max, account) => Math.max(max, account.order), 0) + 1
  await saveRegistry(deps.registryFile, [
    ...accounts,
    { id, label: id, email: '', order },
  ])

  io.out(`stored "${id}" — run \`cuw\` to see it`)
  return 0
}
```

- [ ] **Step 4: Write `src/commands/rm.ts`**

```ts
import type { Keychain } from '../keychain'
import { loadRegistry, saveRegistry } from '../registry'
import type { Io } from './status'

export type RmDeps = {
  registryFile: string
  keychain: Keychain
  confirm: (prompt: string) => Promise<boolean>
}

export async function runRm(id: string, deps: RmDeps, io: Io): Promise<number> {
  const accounts = await loadRegistry(deps.registryFile)
  if (!accounts.some(account => account.id === id)) {
    io.err(`"${id}" is not configured`)
    return 1
  }

  const confirmed = await deps.confirm(`Remove "${id}" and delete its stored token? [y/N] `)
  if (!confirmed) {
    io.out('cancelled')
    return 0
  }

  await deps.keychain.remove(id)
  await saveRegistry(deps.registryFile, accounts.filter(account => account.id !== id))
  io.out(`removed "${id}"`)
  return 0
}
```

- [ ] **Step 5: Wire both into `src/cli.ts`**

Add these imports:

```ts
import { runAdd } from './commands/add'
import { runRm } from './commands/rm'
import { fetchUsage } from './usage-api'
```

Add these helpers above `main`:

```ts
async function readLine(): Promise<string> {
  const chunks: string[] = []
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(new TextDecoder().decode(chunk))
    if (chunks.join('').includes('\n')) break
  }
  return chunks.join('').split('\n')[0] ?? ''
}
```

Add these cases to the `switch` in `main`:

```ts
    case 'add': {
      const id = rest[0]
      if (!id) {
        io.err('usage: cuw add <id>')
        return EXIT_USAGE
      }
      return runAdd(id, {
        registryFile: registryPath(home()),
        keychain: createKeychain(realRunner),
        readToken: readLine,
        verify: async token => {
          await fetchUsage(token, {
            fetcher: fetch,
            endpoint: USAGE_ENDPOINTS[0],
            timeoutMs: REQUEST_TIMEOUT_MS,
          })
        },
      }, io)
    }

    case 'rm': {
      const id = rest[0]
      if (!id) {
        io.err('usage: cuw rm <id>')
        return EXIT_USAGE
      }
      return runRm(id, {
        registryFile: registryPath(home()),
        keychain: createKeychain(realRunner),
        confirm: async prompt => {
          io.out(prompt)
          return (await readLine()).trim().toLowerCase() === 'y'
        },
      }, io)
    }
```

**If Task 3 concluded "probe path only,"** replace the `verify` body with a
`probeUsage` call using the same deps shape as `buildUsageDeps`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test`
Expected: PASS — all suites green.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add and rm commands with stdin token entry and verification"
```

---

### Task 11: `prime` command

**Files:**
- Create: `src/prime.ts`, `src/commands/prime.ts`
- Modify: `src/cli.ts` (dispatch)
- Test: `tests/prime.test.ts`

**Interfaces:**
- Consumes: `PRIME_MODEL`, `PRIME_PROMPT`, `PRIME_TIMEOUT_MS` from `src/constants.ts`; `Account`, `UsageWindows` from `src/types.ts`; `classify` from `src/classify.ts`; `collectUsage` from `src/usage.ts`.
- Produces:
  - `type PrimeResult = { id: string; ok: boolean; resetsAt: Date | null; exitCode: number; detail: string }`
  - `type Spawner = (argv: string[], env: Record<string, string>, cwd: string) => Promise<{ code: number; stderrTail: string }>`
  - `primeAccount(account: Account, token: string, deps: PrimeDeps): Promise<PrimeResult>`
  - `runPrime(args: { ids: string[]; cold: boolean }, deps: PrimeCommandDeps, io: Io): Promise<number>`

- [ ] **Step 1: Write the failing test**

Create `tests/prime.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { primeAccount, type PrimeDeps, type Spawner } from '../src/prime'
import { PRIME_MODEL, PRIME_PROMPT } from '../src/constants'
import type { Account, UsageWindows } from '../src/types'

const account: Account = { id: 'main', label: 'main', email: 'm@x.com', order: 1 }

const ACTIVE: UsageWindows = {
  fiveHourPct: 1,
  fiveHourResetsAt: new Date('2026-08-03T13:00:00Z'),
  weeklyPct: 5,
  weeklyResetsAt: null,
  opusWeeklyPct: null,
}

const COLD: UsageWindows = {
  fiveHourPct: null,
  fiveHourResetsAt: null,
  weeklyPct: 5,
  weeklyResetsAt: null,
  opusWeeklyPct: null,
}

function deps(
  spawnResult = { code: 0, stderrTail: '' },
  after: UsageWindows = ACTIVE,
): PrimeDeps & { calls: { argv: string[]; env: Record<string, string>; cwd: string }[] } {
  const calls: { argv: string[]; env: Record<string, string>; cwd: string }[] = []
  const spawn: Spawner = async (argv, env, cwd) => {
    calls.push({ argv, env, cwd })
    return spawnResult
  }
  return {
    calls,
    spawn,
    scratchDir: '/tmp/cuw-empty',
    configDir: '/tmp/cuw-profile',
    readWindows: async () => after,
  }
}

describe('primeAccount', () => {
  test('sends the token by environment, never by argv', async () => {
    const d = deps()
    await primeAccount(account, 'sk-secret', d)
    expect(d.calls[0].argv.join(' ')).not.toContain('sk-secret')
    expect(d.calls[0].env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-secret')
  })

  test('uses the isolated, minimal flag set', async () => {
    const d = deps()
    await primeAccount(account, 'tok', d)
    const argv = d.calls[0].argv.join(' ')
    expect(argv).toContain(`--model ${PRIME_MODEL}`)
    expect(argv).toContain(`-p ${PRIME_PROMPT}`)
    expect(argv).toContain('--safe-mode')
    expect(argv).toContain('--no-session-persistence')
    expect(d.calls[0].env.CLAUDE_CONFIG_DIR).toBe('/tmp/cuw-profile')
    expect(d.calls[0].cwd).toBe('/tmp/cuw-empty')
  })

  test('reports success with the reset time once a window is open', async () => {
    const result = await primeAccount(account, 'tok', deps())
    expect(result.ok).toBe(true)
    expect(result.resetsAt).toEqual(ACTIVE.fiveHourResetsAt)
  })

  test('reports failure when the spawn exits non-zero', async () => {
    const result = await primeAccount(account, 'tok', deps({ code: 1, stderrTail: 'boom' }))
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.detail).toContain('boom')
  })

  test('does not claim success when no window opened', async () => {
    const result = await primeAccount(account, 'tok', deps({ code: 0, stderrTail: '' }, COLD))
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/no window/i)
  })

  test('failure detail never contains the token', async () => {
    const result = await primeAccount(account, 'sk-secret', deps({ code: 1, stderrTail: 'token sk-secret bad' }))
    expect(result.detail).not.toContain('sk-secret')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/prime.test.ts`
Expected: FAIL — `Cannot find module '../src/prime'`

- [ ] **Step 3: Write `src/prime.ts`**

```ts
import { PRIME_MODEL, PRIME_PROMPT } from './constants'
import type { Account, UsageWindows } from './types'

export type Spawner = (
  argv: string[],
  env: Record<string, string>,
  cwd: string,
) => Promise<{ code: number; stderrTail: string }>

export type PrimeDeps = {
  spawn: Spawner
  scratchDir: string
  configDir: string
  readWindows: (token: string) => Promise<UsageWindows>
}

export type PrimeResult = {
  id: string
  ok: boolean
  resetsAt: Date | null
  exitCode: number
  detail: string
}

/** Strips any occurrence of the token from text bound for a message. */
function redact(text: string, token: string): string {
  return token === '' ? text : text.split(token).join('[redacted]')
}

export async function primeAccount(
  account: Account,
  token: string,
  deps: PrimeDeps,
): Promise<PrimeResult> {
  const argv = [
    'claude',
    '-p', PRIME_PROMPT,
    '--model', PRIME_MODEL,
    '--tools', '',
    '--safe-mode',
    '--no-session-persistence',
  ]
  const env = {
    ...process.env as Record<string, string>,
    CLAUDE_CODE_OAUTH_TOKEN: token,
    CLAUDE_CONFIG_DIR: deps.configDir,
  }

  const spawned = await deps.spawn(argv, env, deps.scratchDir)
  if (spawned.code !== 0) {
    return {
      id: account.id,
      ok: false,
      resetsAt: null,
      exitCode: spawned.code,
      detail: redact(spawned.stderrTail.trim() || 'claude exited non-zero', token),
    }
  }

  const windows = await deps.readWindows(token)
  if (windows.fiveHourPct === null) {
    return {
      id: account.id,
      ok: false,
      resetsAt: null,
      exitCode: 0,
      detail: 'claude succeeded but no window is open yet',
    }
  }

  return {
    id: account.id,
    ok: true,
    resetsAt: windows.fiveHourResetsAt,
    exitCode: 0,
    detail: 'window started',
  }
}
```

- [ ] **Step 4: Write `src/commands/prime.ts`**

```ts
import { classify } from '../classify'
import { formatDuration } from '../render'
import type { Account } from '../types'
import { collectUsage, type UsageDeps } from '../usage'
import { primeAccount, type PrimeDeps, type PrimeResult } from '../prime'
import type { Io } from './status'

export type PrimeCommandDeps = {
  accounts: Account[]
  usage: UsageDeps
  prime: PrimeDeps
  now: Date
}

async function resolveTargets(
  args: { ids: string[]; cold: boolean },
  deps: PrimeCommandDeps,
  io: Io,
): Promise<Account[] | null> {
  if (args.cold) {
    const rows = await collectUsage(deps.accounts, deps.usage)
    const coldIds = new Set(rows.filter(row => classify(row) === 'cold').map(row => row.id))
    return deps.accounts.filter(account => coldIds.has(account.id))
  }

  const targets: Account[] = []
  for (const id of args.ids) {
    const account = deps.accounts.find(candidate => candidate.id === id)
    if (!account) {
      io.err(`"${id}" is not configured`)
      return null
    }
    targets.push(account)
  }
  return targets
}

function report(result: PrimeResult, now: Date, io: Io): void {
  if (!result.ok) {
    io.err(`✗ ${result.id}: ${result.detail}`)
    return
  }
  const countdown = result.resetsAt === null
    ? 'unknown'
    : formatDuration(result.resetsAt.getTime() - now.getTime())
  io.out(`✓ ${result.id}: window started, resets in ${countdown}`)
}

export async function runPrime(
  args: { ids: string[]; cold: boolean },
  deps: PrimeCommandDeps,
  io: Io,
): Promise<number> {
  const targets = await resolveTargets(args, deps, io)
  if (targets === null) return 1

  if (targets.length === 0) {
    io.out(args.cold ? 'every account already has an open window' : 'nothing to prime')
    return 0
  }

  const results = await Promise.all(targets.map(async account => {
    const token = await deps.usage.keychain.get(account.id)
    if (token === null) {
      return {
        id: account.id, ok: false, resetsAt: null, exitCode: 0,
        detail: `no token stored — run \`cuw add ${account.id}\``,
      } satisfies PrimeResult
    }
    return primeAccount(account, token, deps.prime)
  }))

  for (const result of results) report(result, deps.now, io)
  return results.every(result => result.ok) ? 0 : 2
}
```

- [ ] **Step 5: Wire it into `src/cli.ts`**

Add imports (`mkdir` is already in the `node:fs/promises` import from Task 9):

```ts
import { runPrime } from './commands/prime'
import type { Spawner } from './prime'
```

Add the real spawner above `main`:

```ts
const STDERR_TAIL_BYTES = 2_000

const realSpawner: Spawner = async (argv, env, cwd) => {
  const proc = Bun.spawn(argv, { env, cwd, stdout: 'ignore', stderr: 'pipe' })
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  return { code, stderrTail: stderr.slice(-STDERR_TAIL_BYTES) }
}
```

Add the case to the `switch`:

```ts
    case 'prime': {
      const cold = rest.includes('--cold')
      const ids = rest.filter(argument => !argument.startsWith('--'))
      if (!cold && ids.length === 0) {
        io.err('usage: cuw prime <id> | cuw prime --cold')
        return EXIT_USAGE
      }
      const usage = await buildUsageDeps()
      const scratchDir = join(configHome(), 'scratch')
      await mkdir(scratchDir, { recursive: true })
      return runPrime({ ids, cold }, {
        accounts,
        usage,
        prime: {
          spawn: realSpawner,
          scratchDir,
          configDir: join(configHome(), 'profiles', 'prime'),
          readWindows: usage.fetchWindows,
        },
        now: new Date(),
      }, io)
    }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test`
Expected: PASS — all suites green.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: prime command that opens a five-hour window in isolation"
```

---

### Task 12: `doctor` command

**Files:**
- Create: `src/commands/doctor.ts`
- Modify: `src/cli.ts` (dispatch)
- Test: `tests/doctor.test.ts`

**Interfaces:**
- Consumes: `Account`, `AccountUsage` from `src/types.ts`; `collectUsage`, `UsageDeps` from `src/usage.ts`; `Io` from `src/commands/status.ts`.
- Produces: `runDoctor(deps: DoctorDeps, io: Io): Promise<number>` and `type DoctorDeps = { accounts: Account[]; usage: UsageDeps; claudeOnPath: () => Promise<boolean> }`

- [ ] **Step 1: Write the failing test**

Create `tests/doctor.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { runDoctor, type DoctorDeps } from '../src/commands/doctor'
import type { Account, UsageWindows } from '../src/types'

const WINDOWS: UsageWindows = {
  fiveHourPct: 10,
  fiveHourResetsAt: new Date('2026-08-03T12:00:00Z'),
  weeklyPct: 20,
  weeklyResetsAt: null,
  opusWeeklyPct: null,
}

const accounts: Account[] = [{ id: 'main', label: 'main', email: 'm@x.com', order: 1 }]

function captureIo() {
  const out: string[] = []
  return { io: { out: (t: string) => out.push(t), err: (t: string) => out.push(t) }, out }
}

function deps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    accounts,
    claudeOnPath: async () => true,
    usage: {
      keychain: { get: async () => 'tok', set: async () => {}, remove: async () => {} },
      fetchWindows: async () => WINDOWS,
      probeWindows: async () => WINDOWS,
    },
    ...overrides,
  }
}

describe('runDoctor', () => {
  test('reports a healthy account and its data path', async () => {
    const { io, out } = captureIo()
    expect(await runDoctor(deps(), io)).toBe(0)
    expect(out.join('')).toContain('main')
    expect(out.join('')).toContain('api')
  })

  test('flags the probe downgrade', async () => {
    const { io, out } = captureIo()
    await runDoctor(deps({ usage: {
      keychain: { get: async () => 'tok', set: async () => {}, remove: async () => {} },
      fetchWindows: async () => { throw new Error('schema') },
      probeWindows: async () => WINDOWS,
    } }), io)
    expect(out.join('')).toContain('probe')
  })

  test('reports a missing claude binary and exits non-zero', async () => {
    const { io, out } = captureIo()
    expect(await runDoctor(deps({ claudeOnPath: async () => false }), io)).toBe(2)
    expect(out.join('')).toMatch(/claude.*not found/i)
  })

  test('exits 2 when an account has no token', async () => {
    const { io } = captureIo()
    expect(await runDoctor(deps({ usage: {
      keychain: { get: async () => null, set: async () => {}, remove: async () => {} },
      fetchWindows: async () => WINDOWS,
      probeWindows: async () => WINDOWS,
    } }), io)).toBe(2)
  })

  test('never prints a token', async () => {
    const { io, out } = captureIo()
    await runDoctor(deps(), io)
    expect(out.join('')).not.toContain('tok')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/doctor.test.ts`
Expected: FAIL — `Cannot find module '../src/commands/doctor'`

- [ ] **Step 3: Write `src/commands/doctor.ts`**

```ts
import type { Account } from '../types'
import { collectUsage, type UsageDeps } from '../usage'
import type { Io } from './status'

export type DoctorDeps = {
  accounts: Account[]
  usage: UsageDeps
  claudeOnPath: () => Promise<boolean>
}

export async function runDoctor(deps: DoctorDeps, io: Io): Promise<number> {
  let healthy = true

  const hasClaude = await deps.claudeOnPath()
  io.out(hasClaude ? '✓ claude: found on PATH' : '✗ claude: not found on PATH — priming and the probe path will fail')
  if (!hasClaude) healthy = false

  if (deps.accounts.length === 0) {
    io.out('✗ no accounts configured — run `cuw add <id>`')
    return 2
  }

  const rows = await collectUsage(deps.accounts, deps.usage)
  for (const row of rows) {
    if (row.error !== null) {
      io.out(`✗ ${row.id}: ${row.error.message}`)
      healthy = false
      continue
    }
    const note = row.source === 'probe'
      ? 'usage API unavailable, using the probe fallback (slower, and each check opens a window)'
      : 'usage API healthy'
    io.out(`✓ ${row.id}: ${row.source} — ${note}`)
  }

  return healthy ? 0 : 2
}
```

- [ ] **Step 4: Wire it into `src/cli.ts`**

Add the import:

```ts
import { runDoctor } from './commands/doctor'
```

Add the case to the `switch`:

```ts
    case 'doctor': {
      return runDoctor({
        accounts,
        usage: await buildUsageDeps(),
        claudeOnPath: async () => (await realRunner(['which', 'claude'])).code === 0,
      }, io)
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test`
Expected: PASS — all suites green.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: doctor command reporting token health and active data path"
```

---

### Task 13: Integration test, build, and install

**Files:**
- Create: `tests/integration.test.ts`, `README.md`
- Test: the whole suite plus a coverage check

**Interfaces:**
- Consumes: everything. Produces the installed `cuw` binary.

- [ ] **Step 1: Write the integration test**

Create `tests/integration.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let server: ReturnType<typeof Bun.serve>
let home: string
let mode: 'ok' | 'unauthorized' | 'garbage' = 'ok'

const FIXTURE = {
  five_hour: { utilization: 0.12, resets_at: '2099-01-01T00:00:00Z' },
  seven_day: { utilization: 0.34, resets_at: '2099-01-05T00:00:00Z' },
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
})
```

- [ ] **Step 2: Add the two test hooks to `src/cli.ts`**

The integration test needs to point the CLI at a stub server and supply a token
without a Keychain. Add to `buildUsageDeps`, immediately before the `return`:

```ts
  const endpoint = process.env.CUW_ENDPOINT ?? USAGE_ENDPOINTS[0]
  const fakeToken = process.env.CUW_FAKE_TOKEN
  const resolvedKeychain = fakeToken
    ? { get: async () => fakeToken, set: async () => {}, remove: async () => {} }
    : keychain
```

then use `resolvedKeychain` and `endpoint` in the returned object in place of
`keychain` and `USAGE_ENDPOINTS[0]`.

These two escape hatches are test-only, read-only, and cannot expose a real
credential: `CUW_FAKE_TOKEN` supplies a token, it never reveals one.

- [ ] **Step 3: Run the integration test**

Run: `bun test tests/integration.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 4: Run the full suite with coverage**

Run: `bun test --coverage`
Expected: all suites PASS, line coverage ≥ 80%. If a module is below target, add
tests for its untested branches — do not lower the threshold.

- [ ] **Step 5: Build the binary**

```bash
bun run build
./dist/cuw --help
```

Expected: the help text, exit code 0.

- [ ] **Step 6: Write `README.md`**

```markdown
# claude-usage-watch (`cuw`)

See five-hour and weekly usage across several Claude subscriptions without
logging in and out, and start the five-hour window on an idle one.

## Install

    bun install
    bun run build
    ln -sf "$PWD/dist/cuw" /usr/local/bin/cuw

## Set up each subscription

Log into a subscription in another terminal, mint a long-lived token, and hand it
to `cuw`:

    claude setup-token      # in a terminal logged into that account
    cuw add work            # paste the token when prompted

Repeat per subscription. Tokens live in the macOS Keychain under the service
`cuw-token`. `~/.config/cuw/accounts.json` holds no secrets.

## Use

    cuw                     # the table
    cuw status --json       # machine-readable
    cuw prime work          # start the five-hour window on one account
    cuw prime --cold        # start it on every idle account
    cuw doctor              # diagnose tokens and data paths
    cuw rm work             # forget an account and delete its token

## Notes

Priming sends one `hi` to Haiku with no tools, no memory, and no plugins — tens
of tokens. It runs in an isolated config directory and never touches your
logged-in session.

`cuw` reports and primes. It does not route work between accounts, and it is for
subscriptions you own.
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: integration test, compiled binary, and README"
```

---

## Verification

After Task 13, confirm against the spec's success criteria:

- [ ] `cuw` shows accurate figures for all configured subscriptions in under one second (`time cuw`).
- [ ] `cuw prime <id>` opens a window and the follow-up read confirms it.
- [ ] `cuw prime --cold` leaves every subscription with an open window.
- [ ] Revoking one token (`cuw rm` a test account, or letting one expire) degrades to one bad row, never a failed command.
- [ ] `grep -rn "CLAUDE_CODE_OAUTH_TOKEN\|find-generic-password" src/` shows tokens only in `keychain.ts`, `prime.ts`, `usage-probe.ts`, and `cli.ts` — never in a log, render, or JSON path.
- [ ] `bun test --coverage` reports ≥ 80%.
