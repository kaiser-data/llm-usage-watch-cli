# Account Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `cuw use [<id>]`, which repoints the machine's Claude Code login at a tracked subscription, defaulting to the account `recommend()` already names.

**Architecture:** The switch rewrites the `Claude Code-credentials` Keychain item. That item also holds the MCP servers' OAuth tokens, so the write merges into the live blob rather than replacing it, and the stored credential carries the `claudeAiOauth` branch verbatim so nothing is reconstructed from a lossy subset. A new `login.ts` owns the live item behind a pure `mergeLogin`; `commands/use.ts` orchestrates.

**Tech Stack:** TypeScript, Bun (`bun test`, `bun build --compile`), macOS `security` CLI, no runtime dependencies.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-04-account-switching-design.md`
- Side effects go behind injected dependencies; pure logic is tested directly. Follow `commands/add.ts` and `commands/prime.ts`.
- Never print a token, a raw response body, or `security` stderr — all can echo credential material.
- Immutable updates only: build new objects, never mutate inputs.
- Exit codes: `0` success, `1` bad state / write failure, `2` bad input or unsafe to proceed.
- Every task ends green: `bun test` passes and `bunx tsc --noEmit` is clean before the commit.
- Keychain service names are already in `src/constants.ts`: `KEYCHAIN_SERVICE` (`cuw-token`), `CLAUDE_CREDENTIAL_SERVICE` (`Claude Code-credentials`).
- Codex usage reporting is being built in parallel and has already touched `src/cli.ts`, `src/constants.ts`, and `src/types.ts`. Re-read those three files before editing them; the line references in this plan describe structure, not fixed line numbers.

---

### Task 1: Credential passthrough

Without this, a switch reconstructs `claudeAiOauth` from four fields and silently drops `subscriptionType`, `rateLimitTier`, and `refreshTokenExpiresAt`.

**Files:**
- Modify: `src/types.ts` (the `Credential` type)
- Modify: `src/credentials.ts`
- Test: `tests/credentials.test.ts`
- Modify (fixtures broken by the new required field): `tests/token-source.test.ts:10`

**Interfaces:**
- Consumes: nothing.
- Produces: `Credential.raw: Record<string, unknown>`; `isLegacyCredential(credential: Credential): boolean`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/credentials.test.ts`, inside the existing `describe('parseCredential', …)`:

```ts
  test('captures the login branch verbatim, including unmodelled fields', () => {
    const credential = parseCredential(loginBlob({ rateLimitTier: 'default_claude_ai' }))
    expect(credential.raw.subscriptionType).toBe('max')
    expect(credential.raw.rateLimitTier).toBe('default_claude_ai')
  })

  test('round-trips the passthrough through cuw\'s own stored form', () => {
    const stored = serializeCredential(parseCredential(loginBlob()))
    expect(parseCredential(stored).raw.subscriptionType).toBe('max')
  })

  test('reports a credential stored before the passthrough as legacy', () => {
    const old = JSON.stringify({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: NOW + 3_600_000,
      scopes: [REQUIRED_SCOPE],
    })
    expect(isLegacyCredential(parseCredential(old))).toBe(true)
    expect(isLegacyCredential(parseCredential(loginBlob()))).toBe(false)
  })
```

Add to the existing `describe('refreshCredential', …)`:

```ts
  test('projects refreshed values into the passthrough', async () => {
    const fetcher = (async () => new Response(JSON.stringify({
      access_token: 'access-2', expires_in: 3600, refresh_token: 'refresh-2',
    }), { status: 200 })) as unknown as typeof fetch

    const refreshed = await refreshCredential(parseCredential(loginBlob()), { fetcher, now: NOW })
    expect(refreshed.raw.accessToken).toBe('access-2')
    expect(refreshed.raw.refreshToken).toBe('refresh-2')
    expect(refreshed.raw.expiresAt).toBe(NOW + 3_600_000)
    // Untouched fields survive the refresh.
    expect(refreshed.raw.subscriptionType).toBe('max')
  })

  test('does not give a legacy credential a passthrough', async () => {
    const fetcher = (async () => new Response(JSON.stringify({
      access_token: 'access-2', expires_in: 3600,
    }), { status: 200 })) as unknown as typeof fetch

    const legacy = parseCredential(JSON.stringify({
      accessToken: 'a', refreshToken: 'r', expiresAt: NOW, scopes: [REQUIRED_SCOPE],
    }))
    const refreshed = await refreshCredential(legacy, { fetcher, now: NOW })
    expect(isLegacyCredential(refreshed)).toBe(true)
  })
```

Extend the import at the top of the file to include `isLegacyCredential`:

```ts
import {
  CredentialError,
  isExpired,
  isLegacyCredential,
  parseCredential,
  refreshCredential,
  serializeCredential,
} from '../src/credentials'
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/credentials.test.ts`
Expected: FAIL — `isLegacyCredential` is not exported, and `raw` is undefined.

- [ ] **Step 3: Add `raw` to the `Credential` type**

In `src/types.ts`, replace the `Credential` type:

```ts
/**
 * A full-scope Claude Code login credential. Setup-tokens are deliberately not
 * representable here: they carry `user:inference` only and cannot read usage.
 */
export type Credential = {
  accessToken: string
  refreshToken: string
  /** Epoch milliseconds. */
  expiresAt: number
  scopes: string[]
  /**
   * The `claudeAiOauth` branch verbatim, so a switch can restore fields cuw
   * does not model (`subscriptionType`, `rateLimitTier`,
   * `refreshTokenExpiresAt`, and anything Anthropic adds later). Empty for
   * credentials stored before this field existed — see `isLegacyCredential`.
   */
  raw: Record<string, unknown>
}
```

- [ ] **Step 4: Implement in `src/credentials.ts`**

In `parseCredential`, replace the line that computes `source`:

```ts
  const wrapped = asRecord(root.claudeAiOauth)
  const source = wrapped ?? root
```

and replace the `return` at the end of the function:

```ts
  return {
    accessToken,
    refreshToken,
    expiresAt,
    scopes: scopes as string[],
    // Wrapped form: the branch itself. cuw's own form: the persisted copy.
    raw: wrapped ?? asRecord(source.raw) ?? {},
  }
```

Add below `serializeCredential`:

```ts
/** True for a credential stored before cuw kept the full login branch. */
export function isLegacyCredential(credential: Credential): boolean {
  return Object.keys(credential.raw).length === 0
}
```

Add above `refreshCredential`:

```ts
/**
 * Projects refreshed values back into the passthrough. A legacy credential has
 * none and must not gain one: a half-populated branch would look restorable and
 * would be written over a working login. `refreshTokenExpiresAt` is left as it
 * was — the token endpoint does not report it.
 */
function refreshedRaw(
  raw: Record<string, unknown>,
  next: { accessToken: string; refreshToken: string; expiresAt: number },
): Record<string, unknown> {
  if (Object.keys(raw).length === 0) return {}
  return { ...raw, ...next }
}
```

Replace the `return` at the end of `refreshCredential`:

```ts
  const refreshToken = rotated ?? credential.refreshToken
  const expiresAt = deps.now + expiresIn * 1000

  return {
    accessToken,
    // The endpoint may rotate the refresh token or reuse the existing one.
    refreshToken,
    expiresAt,
    scopes: scope,
    raw: refreshedRaw(credential.raw, { accessToken, refreshToken, expiresAt }),
  }
```

- [ ] **Step 5: Fix the fixture the new required field breaks**

Run: `bunx tsc --noEmit`
Expected: an error at `tests/token-source.test.ts:10` — `raw` is missing.

In `tests/token-source.test.ts`, add `raw` to `FRESH`:

```ts
const FRESH: Credential = {
  accessToken: 'access-fresh',
  refreshToken: 'refresh-1',
  expiresAt: NOW + 3_600_000,
  scopes: ['user:inference', REQUIRED_SCOPE],
  raw: {},
}
```

Apply the same one-line addition to any other `Credential` literal `tsc` reports (`tests/credentials.test.ts` `FULL` is the expected second one).

- [ ] **Step 6: Run tests and typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: all tests PASS, tsc silent.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/credentials.ts tests/credentials.test.ts tests/token-source.test.ts
git commit -m "feat: keep the login branch verbatim on a stored credential"
```

---

### Task 2: Profile identity

`cuw use` must name the account it is replacing, and must recognise an untracked login. `/api/oauth/profile` returns `account.uuid` and `account.email`.

**Files:**
- Modify: `src/profile.ts`
- Test: `tests/profile.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Identity = { uuid: string; email: string }`; `normalizeIdentity(raw: unknown): Identity | null`; `fetchIdentity(token: string, deps: ProfileDeps): Promise<Identity | null>`. `fetchSubscription` keeps its existing signature.

- [ ] **Step 1: Write the failing tests**

Add to `tests/profile.test.ts`:

```ts
describe('normalizeIdentity', () => {
  test('extracts the account uuid and email', () => {
    const identity = normalizeIdentity({
      account: { uuid: 'acc-123', email: 'someone@example.com' },
    })
    expect(identity).toEqual({ uuid: 'acc-123', email: 'someone@example.com' })
  })

  test('returns null when the payload carries no account uuid', () => {
    expect(normalizeIdentity({ account: {} })).toBeNull()
    expect(normalizeIdentity('nope')).toBeNull()
  })

  test('tolerates a missing email', () => {
    expect(normalizeIdentity({ account: { uuid: 'acc-123' } })).toEqual({
      uuid: 'acc-123',
      email: '',
    })
  })
})

describe('fetchIdentity', () => {
  test('returns the identity on a successful response', async () => {
    const fetcher = (async () => new Response(
      JSON.stringify({ account: { uuid: 'acc-123', email: 'a@b.c' } }),
      { status: 200 },
    )) as unknown as typeof fetch

    const identity = await fetchIdentity('tok', {
      fetcher, endpoint: 'https://example.invalid', timeoutMs: 1000, now: new Date(),
    })
    expect(identity?.uuid).toBe('acc-123')
  })

  test('returns null when the endpoint rejects the token', async () => {
    const fetcher = (async () => new Response('{}', { status: 403 })) as unknown as typeof fetch
    const identity = await fetchIdentity('tok', {
      fetcher, endpoint: 'https://example.invalid', timeoutMs: 1000, now: new Date(),
    })
    expect(identity).toBeNull()
  })
})
```

Extend the file's existing import from `../src/profile` to include `normalizeIdentity` and `fetchIdentity`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/profile.test.ts`
Expected: FAIL — neither export exists.

- [ ] **Step 3: Implement in `src/profile.ts`**

Add after the `Subscription` import usage, near the top-level types:

```ts
/** Who a credential belongs to. Used to name and protect the outgoing login. */
export type Identity = { uuid: string; email: string }

export function normalizeIdentity(raw: unknown): Identity | null {
  const account = asRecord(asRecord(raw)?.account)
  const uuid = account?.uuid
  if (typeof uuid !== 'string' || uuid === '') return null
  const email = account?.email
  return { uuid, email: typeof email === 'string' ? email : '' }
}
```

Replace the body of `fetchSubscription` with a shared request helper plus two thin readers:

```ts
/** Returns the parsed profile payload, or null on any failure. */
async function requestProfile(token: string, deps: ProfileDeps): Promise<unknown | null> {
  try {
    const response = await deps.fetcher(deps.endpoint, {
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': OAUTH_BETA_HEADER,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(deps.timeoutMs),
    })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

/**
 * Returns null on any failure. Plan info is a nice-to-have decoration: it must
 * never turn a usable usage row into an error row.
 */
export async function fetchSubscription(
  token: string,
  deps: ProfileDeps,
): Promise<Subscription | null> {
  const payload = await requestProfile(token, deps)
  if (payload === null) return null
  try {
    return normalizeProfile(payload, deps.now)
  } catch {
    return null
  }
}

/** Null when the profile cannot be read or carries no account uuid. */
export async function fetchIdentity(
  token: string,
  deps: ProfileDeps,
): Promise<Identity | null> {
  const payload = await requestProfile(token, deps)
  return payload === null ? null : normalizeIdentity(payload)
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: all PASS, tsc silent.

- [ ] **Step 5: Commit**

```bash
git add src/profile.ts tests/profile.test.ts
git commit -m "feat: read account identity from the profile endpoint"
```

---

### Task 3: Registry records the account uuid

**Files:**
- Modify: `src/types.ts` (the `Account` type)
- Modify: `src/registry.ts:35-38` (the `assertAccount` return)
- Test: `tests/registry.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Account.uuid?: string`, preserved across `loadRegistry`/`saveRegistry`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/registry.test.ts`:

```ts
  test('preserves an account uuid across a save and load', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'cuw-reg-')), 'accounts.json')
    await saveRegistry(path, [
      { id: 'main', label: 'main', email: 'a@b.c', order: 1, uuid: 'acc-123' },
    ])
    expect((await loadRegistry(path))[0]?.uuid).toBe('acc-123')
  })

  test('accepts an account without a uuid', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'cuw-reg-')), 'accounts.json')
    await saveRegistry(path, [{ id: 'main', label: 'main', email: '', order: 1 }])
    expect((await loadRegistry(path))[0]?.uuid).toBeUndefined()
  })

  test('rejects a non-string uuid', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'cuw-reg-')), 'accounts.json')
    await writeFile(path, JSON.stringify([
      { id: 'main', label: 'main', email: '', order: 1, uuid: 7 },
    ]), 'utf8')
    await expect(loadRegistry(path)).rejects.toThrow(RegistryError)
  })
```

Make sure the file imports `mkdtemp` and `writeFile` from `node:fs/promises`, `join` from `node:path`, and `tmpdir` from `node:os` — match whatever the existing tests in this file already use, and add only what is missing.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/registry.test.ts`
Expected: FAIL — `uuid` is dropped by `assertAccount`, and the non-string case does not throw.

- [ ] **Step 3: Add the field to the type**

In `src/types.ts`, replace the `Account` type:

```ts
export type Account = {
  id: string
  label: string
  email: string
  order: number
  /** The profile endpoint's `account.uuid`. Absent on pre-switching entries. */
  uuid?: string
}
```

- [ ] **Step 4: Preserve and validate it in `src/registry.ts`**

Replace the tail of `assertAccount` (currently the `id` check and the `return`):

```ts
  const id = entry.id as string
  if (!ID_PATTERN.test(id)) {
    throw new RegistryError(`invalid id "${id}": use lowercase letters, digits, - and _`, 'invalid-id')
  }
  const uuid = entry.uuid
  if (uuid !== undefined && typeof uuid !== 'string') {
    throw new RegistryError(`entry ${index} has a non-string "uuid"`, 'malformed')
  }
  return {
    id,
    label: entry.label as string,
    email: entry.email as string,
    order: entry.order,
    // Spread, so an absent uuid stays absent rather than serializing as null.
    ...(uuid === undefined ? {} : { uuid }),
  }
```

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: all PASS, tsc silent.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/registry.ts tests/registry.test.ts
git commit -m "feat: record an account uuid in the registry"
```

---

### Task 4: The login store and `mergeLogin`

This is the task that decides whether the switch is a feature or a data-loss bug.

**Files:**
- Create: `src/login.ts`
- Test: `tests/login.test.ts`

**Interfaces:**
- Consumes: `Credential` (Task 1), `Runner` from `src/keychain.ts`.
- Produces: `LoginBlob = Record<string, unknown>`; `LoginError`; `mergeLogin(live: LoginBlob, credential: Credential): LoginBlob`; `LoginStore = { read(): Promise<LoginBlob | null>; write(blob: LoginBlob): Promise<void> }`; `createLoginStore(run: Runner): LoginStore`.

- [ ] **Step 1: Write the failing tests**

Create `tests/login.test.ts`:

```ts
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
    const merged = mergeLogin(LIVE, CREDENTIAL)
    expect(merged.mcpOAuth).toEqual(LIVE.mcpOAuth)
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

  test('writes under the account name read from the item attributes', async () => {
    const calls: string[][] = []
    const run: Runner = async argv => {
      calls.push(argv)
      if (argv.includes('-w') && argv[1] === 'find-generic-password') return ok('{}')
      if (argv[1] === 'find-generic-password') return ok('    "acct"<blob>="marty"\n')
      return ok('')
    }

    await createLoginStore(run).write({ a: 1 })
    const write = calls.find(argv => argv[1] === 'add-generic-password')
    expect(write).toContain('-a')
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

    await expect(createLoginStore(run).write({ a: 1 })).rejects.toThrow(/^(?!.*secret material).*$/s)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/login.test.ts`
Expected: FAIL — `src/login.ts` does not exist.

- [ ] **Step 3: Implement `src/login.ts`**

```ts
import { CLAUDE_CREDENTIAL_SERVICE } from './constants'
import type { Runner } from './keychain'
import type { Credential } from './types'

/** `security` exit code for "the specified item could not be found". */
const NOT_FOUND_CODE = 44

/** `security` prints item attributes on stdout, one `"key"<blob>="value"` per line. */
const ACCOUNT_ATTRIBUTE = /^\s*"acct"<blob>="(.*)"\s*$/m

/** The whole Keychain item: the login plus every MCP server's OAuth tokens. */
export type LoginBlob = Record<string, unknown>

export class LoginError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LoginError'
  }
}

/**
 * Replaces only the login branch. Every other top-level key — notably
 * `mcpOAuth`, which holds each MCP server's OAuth tokens — is carried across
 * untouched. Replacing the item wholesale would sign the user out of every
 * connected MCP server, silently and without a way back.
 */
export function mergeLogin(live: LoginBlob, credential: Credential): LoginBlob {
  if (Object.keys(credential.raw).length === 0) {
    throw new LoginError('credential predates the stored login branch and cannot be restored')
  }
  return { ...live, claudeAiOauth: credential.raw }
}

export type LoginStore = {
  /** Null when no login item exists. */
  read(): Promise<LoginBlob | null>
  write(blob: LoginBlob): Promise<void>
}

export function createLoginStore(run: Runner): LoginStore {
  /**
   * Read rather than assume: the item is created by `claude auth login` under
   * whatever account name that machine used.
   */
  async function accountName(): Promise<string> {
    const result = await run(['security', 'find-generic-password', '-s', CLAUDE_CREDENTIAL_SERVICE])
    const account = ACCOUNT_ATTRIBUTE.exec(result.stdout)?.[1]
    if (result.code !== 0 || account === undefined) {
      throw new LoginError('cannot read the Claude Code login item')
    }
    return account
  }

  return {
    async read() {
      const result = await run([
        'security', 'find-generic-password', '-s', CLAUDE_CREDENTIAL_SERVICE, '-w',
      ])
      if (result.code === NOT_FOUND_CODE) return null
      // stderr is not included: it can echo the queried item.
      if (result.code !== 0) throw new LoginError('cannot read the Claude Code login item')

      let parsed: unknown
      try {
        parsed = JSON.parse(result.stdout.trim())
      } catch {
        throw new LoginError('the Claude Code login item is not valid JSON')
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new LoginError('the Claude Code login item is not a JSON object')
      }
      return parsed as LoginBlob
    },

    async write(blob) {
      const account = await accountName()
      // As in `keychain.set`, the value travels as an argv element and is
      // briefly visible to same-user processes. Here it is wider than one
      // account's credential: this blob also carries the MCP server tokens.
      const result = await run([
        'security', 'add-generic-password', '-U',
        '-s', CLAUDE_CREDENTIAL_SERVICE, '-a', account,
        '-w', JSON.stringify(blob),
      ])
      // stderr is discarded: it may echo the argv containing the blob.
      if (result.code !== 0) {
        throw new LoginError(`writing the Claude Code login failed (exit ${result.code})`)
      }
    },
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: all PASS, tsc silent.

- [ ] **Step 5: Commit**

```bash
git add src/login.ts tests/login.test.ts
git commit -m "feat: merge into the live login item instead of replacing it"
```

---

### Task 5: `cuw add` records identity

An account without a `uuid` cannot be recognised later, so `add` fails loudly rather than storing one silently.

**Files:**
- Modify: `src/commands/add.ts`
- Modify: `src/cli.ts` (the `add` case)
- Test: `tests/add.test.ts`

**Interfaces:**
- Consumes: `Identity`, `fetchIdentity` (Task 2); `Account.uuid` (Task 3).
- Produces: `AddDeps.fetchIdentity: (token: string) => Promise<Identity | null>`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/add.test.ts`:

```ts
  test('records the account uuid and email from the profile', async () => {
    const { io, out } = captureIo()
    const registryFile = join(await mkdtemp(join(tmpdir(), 'cuw-add-')), 'accounts.json')
    const keychain = fakeKeychain()

    const code = await runAdd('main', {
      registryFile,
      keychain,
      readLoginCredential: async () => loginBlob(),
      fetchIdentity: async () => ({ uuid: 'acc-123', email: 'someone@example.com' }),
    }, io)

    expect(code).toBe(0)
    const stored = await loadRegistry(registryFile)
    expect(stored[0]?.uuid).toBe('acc-123')
    expect(stored[0]?.email).toBe('someone@example.com')
    expect(out.join('\n')).not.toContain('access-secret')
  })

  test('refuses to store an account whose identity cannot be read', async () => {
    const { io } = captureIo()
    const registryFile = join(await mkdtemp(join(tmpdir(), 'cuw-add-')), 'accounts.json')
    const keychain = fakeKeychain()

    const code = await runAdd('main', {
      registryFile,
      keychain,
      readLoginCredential: async () => loginBlob(),
      fetchIdentity: async () => null,
    }, io)

    expect(code).toBe(2)
    expect(await loadRegistry(registryFile)).toEqual([])
    expect(await keychain.get('main')).toBeNull()
  })
```

Every existing `runAdd` call in this file needs the new dependency. Add
`fetchIdentity: async () => ({ uuid: 'acc-existing', email: '' }),` to each of
them — `bunx tsc --noEmit` lists the exact lines.

Add `loadRegistry` to the imports from `../src/registry`, and `mkdtemp`/`tmpdir`/`join` if the file does not already import them. Reuse the file's existing `fakeKeychain` helper; if it has none, add:

```ts
function fakeKeychain(): Keychain {
  const store = new Map<string, string>()
  return {
    get: async id => store.get(id) ?? null,
    set: async (id, value) => { store.set(id, value) },
    remove: async id => { store.delete(id) },
  }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/add.test.ts`
Expected: FAIL — `fetchIdentity` is not part of `AddDeps`.

- [ ] **Step 3: Implement in `src/commands/add.ts`**

Extend `AddDeps`:

```ts
export type AddDeps = {
  registryFile: string
  keychain: Keychain
  /** Reads the blob `claude auth login` stored, or null if not logged in. */
  readLoginCredential: () => Promise<string | null>
  /** Names the account behind the credential, or null when unreadable. */
  fetchIdentity: (token: string) => Promise<Identity | null>
}
```

Add the import:

```ts
import type { Identity } from '../profile'
```

Replace the block that builds `order`/`updated` with:

```ts
  // Without an identity the account cannot be recognised during a switch, and a
  // registry that is missing one blocks `cuw use` from capturing an untracked
  // login. Refuse now rather than store a half-usable entry.
  const identity = await deps.fetchIdentity(credential.accessToken)
  if (identity === null) {
    io.err('cannot read the account profile for this login — check your connection and retry')
    io.err('nothing was stored')
    return 2
  }

  const order = accounts.reduce((max, account) => Math.max(max, account.order), 0) + 1
  const updated = [
    ...accounts,
    { id, label: id, email: identity.email, order, uuid: identity.uuid },
  ]
```

Update the doc comment above `runAdd`: the sentence saying `email` is left empty because the usage endpoint returns none is now wrong — the profile endpoint supplies it.

- [ ] **Step 4: Wire it in `src/cli.ts`**

In the `add` case, add the dependency:

```ts
      return runAdd(id, {
        registryFile: registryPath(home()),
        keychain: createKeychain(realRunner),
        readLoginCredential,
        fetchIdentity: token => fetchIdentity(token, {
          fetcher: fetch,
          endpoint: PROFILE_ENDPOINT,
          timeoutMs: REQUEST_TIMEOUT_MS,
          now: new Date(),
        }),
      }, io)
```

Extend the existing profile import:

```ts
import { fetchIdentity, fetchSubscription } from './profile'
```

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: all PASS, tsc silent.

- [ ] **Step 6: Commit**

```bash
git add src/commands/add.ts src/cli.ts tests/add.test.ts
git commit -m "feat: record account identity when adding a subscription"
```

---

### Task 6: `runUse`

**Files:**
- Create: `src/commands/use.ts`
- Test: `tests/use.test.ts`

**Interfaces:**
- Consumes: `isLegacyCredential`, `parseCredential`, `serializeCredential` (Task 1); `Identity` (Task 2); `Account.uuid` (Task 3); `mergeLogin`, `LoginStore` (Task 4); `recommend` from `src/classify.ts`; `collectUsage`/`UsageDeps` from `src/usage.ts`; `Io` from `src/commands/status.ts`.
- Produces: `UseDeps`; `runUse(id: string | undefined, deps: UseDeps, io: Io): Promise<number>`.

- [ ] **Step 1: Write the failing tests**

Create `tests/use.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runUse } from '../src/commands/use'
import { serializeCredential, parseCredential } from '../src/credentials'
import { createLoginStore } from '../src/login'
import { loadRegistry, saveRegistry } from '../src/registry'
import { REQUIRED_SCOPE } from '../src/constants'
import type { Keychain } from '../src/keychain'
import type { LoginBlob, LoginStore } from '../src/login'
import type { Account, UsageWindows } from '../src/types'

const FUTURE = new Date('2099-01-01T00:00:00Z')

function credentialBlob(accessToken: string): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken,
      refreshToken: `${accessToken}-refresh`,
      expiresAt: FUTURE.getTime(),
      scopes: [REQUIRED_SCOPE],
      subscriptionType: 'pro',
    },
  })
}

const ACCOUNTS: Account[] = [
  { id: 'main', label: 'main', email: 'main@x.c', order: 1, uuid: 'uuid-main' },
  { id: 'spare', label: 'spare', email: 'spare@x.c', order: 2, uuid: 'uuid-spare' },
]

function windows(fiveHourPct: number, weeklyPct: number): UsageWindows {
  return {
    fiveHourPct, fiveHourResetsAt: FUTURE, weeklyPct, weeklyResetsAt: FUTURE,
    opusWeeklyPct: null,
  }
}

function captureIo() {
  const lines: string[] = []
  return { io: { out: (t: string) => lines.push(t), err: (t: string) => lines.push(t) }, lines }
}

function fakeKeychain(initial: Record<string, string>): Keychain {
  const store = new Map(Object.entries(initial))
  return {
    get: async id => store.get(id) ?? null,
    set: async (id, value) => { store.set(id, value) },
    remove: async id => { store.delete(id) },
  }
}

/**
 * Assertions read the result back through `read()` rather than a extra
 * property: `baseDeps` spreads overrides, which widens the field to
 * `LoginStore` and would drop any test-only property from the type.
 */
function fakeLogin(initial: LoginBlob | null): LoginStore {
  let current = initial
  return {
    read: async () => current,
    write: async blob => { current = blob },
  }
}

/** The login branch currently installed, for assertions. */
async function activeToken(login: LoginStore): Promise<unknown> {
  const blob = await login.read()
  return (blob?.claudeAiOauth as Record<string, unknown> | undefined)?.accessToken
}

/** main is spent, spare is fresh — so `recommend()` picks spare. */
function baseDeps(overrides: Partial<Parameters<typeof runUse>[1]> = {}) {
  return {
    registryFile: '',
    accounts: ACCOUNTS,
    usage: {
      keychain: fakeKeychain({ main: credentialBlob('a-main'), spare: credentialBlob('a-spare') }),
      fetchWindows: async (token: string) =>
        token === 'a-main' ? windows(100, 90) : windows(0, 10),
      probeWindows: async () => windows(0, 0),
    },
    keychain: fakeKeychain({
      main: serializeCredential(parseCredential(credentialBlob('a-main'))),
      spare: serializeCredential(parseCredential(credentialBlob('a-spare'))),
    }),
    login: fakeLogin({
      mcpOAuth: { 'notion|abc': { accessToken: 'mcp-secret' } },
      claudeAiOauth: { accessToken: 'a-main', subscriptionType: 'pro' },
    }),
    fetchIdentity: async () => ({ uuid: 'uuid-main', email: 'main@x.c' }),
    ...overrides,
  }
}

describe('runUse', () => {
  test('switches to the recommended account when given no id', async () => {
    const { io, lines } = captureIo()
    const deps = baseDeps()

    expect(await runUse(undefined, deps, io)).toBe(0)
    expect(lines.join('\n')).toContain('main → spare')
    expect(await activeToken(deps.login)).toBe('a-spare')
  })

  test('preserves the MCP tokens through the switch', async () => {
    const { io } = captureIo()
    const deps = baseDeps()

    await runUse('spare', deps, io)
    expect((await deps.login.read())?.mcpOAuth)
      .toEqual({ 'notion|abc': { accessToken: 'mcp-secret' } })
  })

  test('does nothing when the target is already active', async () => {
    const { io, lines } = captureIo()
    const deps = baseDeps()

    expect(await runUse('main', deps, io)).toBe(0)
    expect(lines.join('\n')).toContain('already on')
    expect(await activeToken(deps.login)).toBe('a-main')
  })

  test('refuses a legacy credential without writing', async () => {
    const { io, lines } = captureIo()
    const deps = baseDeps({
      keychain: fakeKeychain({
        main: serializeCredential(parseCredential(credentialBlob('a-main'))),
        spare: JSON.stringify({
          accessToken: 'a-spare', refreshToken: 'r', expiresAt: FUTURE.getTime(),
          scopes: [REQUIRED_SCOPE],
        }),
      }),
    })

    expect(await runUse('spare', deps, io)).toBe(2)
    expect(lines.join('\n')).toContain('cuw add spare')
    expect(await activeToken(deps.login)).toBe('a-main')
  })

  test('aborts when the active login cannot be identified', async () => {
    const { io, lines } = captureIo()
    const deps = baseDeps({ fetchIdentity: async () => null })

    expect(await runUse('spare', deps, io)).toBe(2)
    expect(lines.join('\n')).toContain('cannot identify')
    expect(await activeToken(deps.login)).toBe('a-main')
  })

  test('aborts when no login exists', async () => {
    const { io, lines } = captureIo()
    expect(await runUse('spare', baseDeps({ login: fakeLogin(null) }), io)).toBe(2)
    expect(lines.join('\n')).toContain('claude auth login')
  })

  test('captures an untracked login before overwriting it', async () => {
    const { io, lines } = captureIo()
    const registryFile = join(await mkdtemp(join(tmpdir(), 'cuw-use-')), 'accounts.json')
    await saveRegistry(registryFile, ACCOUNTS)

    const keychain = fakeKeychain({
      main: serializeCredential(parseCredential(credentialBlob('a-main'))),
      spare: serializeCredential(parseCredential(credentialBlob('a-spare'))),
    })
    const deps = baseDeps({
      registryFile,
      keychain,
      login: fakeLogin({
        claudeAiOauth: { accessToken: 'a-other', subscriptionType: 'pro',
          refreshToken: 'r', expiresAt: FUTURE.getTime(), scopes: [REQUIRED_SCOPE] },
      }),
      fetchIdentity: async () => ({ uuid: 'uuid-other', email: 'work@example.com' }),
    })

    expect(await runUse('spare', deps, io)).toBe(0)
    expect(lines.join('\n')).toContain('work')
    const saved = await loadRegistry(registryFile)
    expect(saved.some(a => a.uuid === 'uuid-other')).toBe(true)
    expect(await keychain.get('work')).not.toBeNull()
  })

  test('refuses to capture while an account is missing a uuid', async () => {
    const { io, lines } = captureIo()
    const deps = baseDeps({
      accounts: [ACCOUNTS[0]!, { id: 'spare', label: 'spare', email: '', order: 2 }],
      login: fakeLogin({ claudeAiOauth: { accessToken: 'a-other', subscriptionType: 'pro' } }),
      fetchIdentity: async () => ({ uuid: 'uuid-other', email: 'work@example.com' }),
    })

    expect(await runUse('spare', deps, io)).toBe(2)
    expect(lines.join('\n')).toContain('spare')
  })

  test('reports a write failure as leaving nothing changed', async () => {
    const { io, lines } = captureIo()
    const deps = baseDeps({
      login: {
        read: async () => ({ claudeAiOauth: { accessToken: 'a-main' } }),
        write: async () => { throw new Error('keychain is locked') },
      },
    })

    expect(await runUse('spare', deps, io)).toBe(1)
    expect(lines.join('\n')).toContain('nothing was changed')
  })

  test('never prints a token', async () => {
    const { io, lines } = captureIo()
    await runUse('spare', baseDeps(), io)
    expect(lines.join('\n')).not.toContain('a-spare')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/use.test.ts`
Expected: FAIL — `src/commands/use.ts` does not exist.

- [ ] **Step 3: Implement `src/commands/use.ts`**

```ts
import { recommend } from '../classify'
import { isLegacyCredential, parseCredential, serializeCredential } from '../credentials'
import type { Keychain } from '../keychain'
import { mergeLogin, type LoginBlob, type LoginStore } from '../login'
import type { Identity } from '../profile'
import { loadRegistry, saveRegistry } from '../registry'
import type { Account } from '../types'
import { collectUsage, type UsageDeps } from '../usage'
import type { Io } from './status'

export type UseDeps = {
  registryFile: string
  accounts: Account[]
  usage: UsageDeps
  /** The raw credential store, not the refreshing wrapper: `use` needs blobs. */
  keychain: Keychain
  login: LoginStore
  fetchIdentity: (token: string) => Promise<Identity | null>
}

const ID_MAX = 32

/** An id derived from an email local part, kept within the registry's pattern. */
function deriveId(email: string, taken: Set<string>): string {
  const base = (email.split('@')[0] ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, ID_MAX)
  const seed = base === '' ? 'account' : base
  if (!taken.has(seed)) return seed
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${seed.slice(0, ID_MAX - 3)}-${suffix}`
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * Captures the login currently in the Keychain as a new account, so the switch
 * that is about to overwrite it does not strand the user outside an account
 * they may not be able to log back into.
 */
async function capture(
  live: LoginBlob,
  identity: Identity,
  deps: UseDeps,
  io: Io,
): Promise<string> {
  const id = deriveId(identity.email, new Set(deps.accounts.map(account => account.id)))
  const credential = parseCredential(JSON.stringify(live))
  const order = deps.accounts.reduce((max, account) => Math.max(max, account.order), 0) + 1

  await saveRegistry(deps.registryFile, [
    ...(await loadRegistry(deps.registryFile)),
    { id, label: id, email: identity.email, order, uuid: identity.uuid },
  ])
  await deps.keychain.set(id, serializeCredential(credential))

  io.out(`the active login was not tracked — captured it as "${id}" (${identity.email})`)
  return id
}

export async function runUse(
  id: string | undefined,
  deps: UseDeps,
  io: Io,
): Promise<number> {
  const rows = await collectUsage(deps.accounts, deps.usage)

  const targetId = id ?? recommend(rows).useId
  if (targetId === null || targetId === undefined) {
    io.err('no usable account — every subscription is spent or unreachable')
    return 2
  }
  if (!deps.accounts.some(account => account.id === targetId)) {
    io.err(`unknown account "${targetId}"`)
    return 2
  }

  const stored = await deps.keychain.get(targetId)
  if (stored === null) {
    io.err(`no token stored for "${targetId}" — run \`cuw add ${targetId}\``)
    return 2
  }

  const target = parseCredential(stored)
  if (isLegacyCredential(target)) {
    io.err(`"${targetId}" was stored before cuw kept the full login blob, so it`)
    io.err('cannot be restored without losing plan metadata.')
    io.err(`Re-add it: claude auth login && cuw add ${targetId}`)
    return 2
  }

  const live = await deps.login.read()
  if (live === null) {
    io.err('no Claude Code login found — run `claude auth login`')
    return 2
  }

  const liveCredential = parseCredential(JSON.stringify(live))
  const identity = await deps.fetchIdentity(liveCredential.accessToken)
  if (identity === null) {
    io.err('cannot identify the active login, so it cannot be protected — not switching')
    return 2
  }

  const known = deps.accounts.find(account => account.uuid === identity.uuid)
  let activeId: string
  if (known !== undefined) {
    activeId = known.id
  } else {
    // A registry mid-migration cannot tell "untracked" from "tracked but never
    // identified", and guessing wrong duplicates an account.
    const unidentified = deps.accounts.filter(account => account.uuid === undefined)
    if (unidentified.length > 0) {
      io.err('the active login is unknown, and these accounts have no recorded identity:')
      io.err(`  ${unidentified.map(account => account.id).join(', ')}`)
      io.err('re-add them first: claude auth login && cuw add <id>')
      return 2
    }
    activeId = await capture(live, identity, deps, io)
  }

  if (activeId === targetId) {
    io.out(`already on "${targetId}"`)
    return 0
  }

  try {
    await deps.login.write(mergeLogin(live, target))
  } catch (error) {
    io.err((error as Error).message)
    io.err('nothing was changed')
    return 1
  }

  const row = rows.find(candidate => candidate.id === targetId)
  io.out(`switched: ${activeId} → ${targetId}`)
  if (row !== undefined) {
    io.out(`  five-hour ${row.fiveHourPct ?? 0}%, weekly ${row.weeklyPct ?? 0}%`)
  }
  io.out('  running sessions keep their current account')
  return 0
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: all PASS, tsc silent.

- [ ] **Step 5: Commit**

```bash
git add src/commands/use.ts tests/use.test.ts
git commit -m "feat: add the use command"
```

---

### Task 7: CLI wiring and documentation

**Files:**
- Modify: `src/cli.ts` (`HELP`, the command `switch`)
- Modify: `README.md`
- Modify: `docs/HOW-IT-WORKS.md`
- Test: `tests/integration.test.ts`

**Interfaces:**
- Consumes: `runUse` (Task 6), `createLoginStore` (Task 4), `fetchIdentity` (Task 2).
- Produces: the `cuw use` command.

- [ ] **Step 1: Write the failing test**

Add to `tests/integration.test.ts`:

```ts
  test('rejects `use` with an unknown account id', async () => {
    const { code } = await runCli(['use', 'nope'])
    expect(code).toBe(2)
  })
```

`runCli` is the helper already defined in this file; it spawns `src/cli.ts` with
`HOME`, `CUW_ENDPOINT`, and `CUW_FAKE_TOKEN` pointed at the stub server, so the
test needs no further setup. The registry the suite writes holds only `main`, so
`nope` is rejected before any real Keychain access happens.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/integration.test.ts`
Expected: FAIL — `main` reports `unknown command: use` and returns `EXIT_USAGE` for a different reason, or the assertion fails once the command exists but is unwired.

- [ ] **Step 3: Wire the command in `src/cli.ts`**

Add the imports:

```ts
import { createLoginStore } from './login'
import { runUse } from './commands/use'
```

Add the line to `HELP`, directly under the `status` line:

```
  cuw use [<id>]            Switch the Claude Code login to a subscription
```

Add the case, after `status`:

```ts
    case 'use': {
      const target = rest.find(argument => !argument.startsWith('--'))
      return runUse(target, {
        registryFile: registryPath(home()),
        accounts,
        usage: await buildUsageDeps(),
        // Deliberately the raw store: `use` needs the credential blob, and the
        // refreshing wrapper returns a bare access token.
        keychain: createKeychain(realRunner),
        login: createLoginStore(realRunner),
        fetchIdentity: token => fetchIdentity(token, {
          fetcher: fetch,
          endpoint: PROFILE_ENDPOINT,
          timeoutMs: REQUEST_TIMEOUT_MS,
          now: new Date(),
        }),
      }, io)
    }
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: all PASS, tsc silent.

- [ ] **Step 5: Document the command**

In `README.md`, add the command to the command list:

```markdown
| `cuw use [<id>]` | Point the Claude Code login at a subscription — the recommended one when no id is given |
```

and this section (match the file's existing heading level):

```markdown
## Switching accounts

`cuw use` rewrites the Claude Code login in the Keychain. New `claude` sessions
and the desktop app pick up the new account; sessions already running keep the
one they started with.

That Keychain item also holds the OAuth tokens of every connected MCP server, so
the switch merges into it rather than replacing it — your MCP connections
survive. If the login that is about to be replaced is not one cuw tracks, cuw
stores it as a new account first, so you can always switch back.

Accounts added before this feature was built were stored without the full login
blob. `cuw use` refuses them; re-add each one once:

    claude auth login        # for that subscription
    cuw rm <id>
    cuw add <id>
```

In `docs/HOW-IT-WORKS.md`, add a section covering: the observed structure of the
`Claude Code-credentials` item (`claudeAiOauth` beside `mcpOAuth.<server>`); why
the write is a merge and what replacing it would destroy; why the credential
stores the login branch verbatim rather than the four typed fields; and why an
unidentifiable active login aborts the switch instead of proceeding.

- [ ] **Step 6: Build and verify against the real tool**

```bash
bun run build
./dist/cuw --help
```

Expected: the help text lists `cuw use`. Do not run a real switch until the three configured accounts have been re-added.

- [ ] **Step 7: Commit**

```bash
git add src/cli.ts README.md docs/HOW-IT-WORKS.md tests/integration.test.ts
git commit -m "feat: wire up the use command and document switching"
```

---

## Migration (run once, by hand, after Task 7)

The three configured accounts predate the passthrough. For each of `main`,
`nimzo`, `superclaude`:

```bash
claude auth login          # log into that subscription
cuw rm <id>
cuw add <id>
```

`cuw use` refuses any account not re-added, and refuses to capture an untracked
login while any account still lacks a `uuid`, so a partial migration fails
closed rather than duplicating accounts.
