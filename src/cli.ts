#!/usr/bin/env bun
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CLAUDE_CREDENTIAL_SERVICE,
  CODEX_USAGE_TIMEOUT_MS,
  CURSOR_USAGE_TIMEOUT_MS,
  DEFAULT_TERM_WIDTH,
  GROK_USAGE_TIMEOUT_MS,
  PROBE_ENDPOINT,
  PROBE_MODEL,
  PROBE_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  PROFILE_ENDPOINT,
  USAGE_ENDPOINTS,
} from './constants'
import { createKeychain, realRunner } from './keychain'
import { collectCodexUsage, realCodexAppServerSpawner } from './codex-app-server'
import { realCursorAuthStore } from './cursor-auth'
import { buildCollectCursorUsage } from './cursor-usage'
import { realGrokAuthStore } from './grok-auth'
import { buildCollectGrokUsage } from './grok-usage'
import { createRefreshingTokenSource } from './token-source'
import { loadRegistry, registryPath } from './registry'
import { realSpawner } from './spawn'
import { fetchUsage } from './usage-api'
import { fetchIdentity, fetchSubscription } from './profile'
import { probeUsage } from './usage-probe'
import { EXIT_OK, EXIT_USAGE, runStatus, type Io } from './commands/status'
import { createLoginStore } from './login'
import { describeSync, syncLiveLogin, type SyncResult } from './live-sync'
import { runAdd } from './commands/add'
import { runLogin } from './commands/login'
import { createIsolatedLogin, realInteractiveSpawner } from './claude-login'
import { CredentialError } from './credentials'
import { runUse } from './commands/use'
import { runRm } from './commands/rm'
import { runPrime } from './commands/prime'
import { runDoctor } from './commands/doctor'
import type { UsageDeps } from './usage'

const HELP = `cuw — Claude, Codex, Cursor, and Grok usage

Usage:
  cuw [status] [--json]     Show Claude, Codex, Cursor, and Grok usage
  cuw use [<id>]            Switch the Claude Code login to a subscription
  cuw sync [--quiet]        Import the terminal's Claude login (runs automatically)
  cuw login                 Sign every expired subscription back in
  cuw login <id> [<id>...]  Sign in (or add) specific subscriptions
  cuw add <id>              Store the terminal's current login as <id>
  cuw add --force <id>      Re-record an account from the current login
  cuw rm <id>               Remove a subscription
  cuw prime <id>            Start the five-hour window on a subscription
  cuw prime --cold          Start the window on every idle subscription
  cuw doctor                Diagnose tokens and data paths
  cuw --help                Show this message
`

const AUTO_SYNC_COMMANDS = new Set(['status', 'use', 'prime', 'doctor', 'login'])

export function home(): string {
  const value = process.env.HOME
  if (!value) throw new Error('HOME is not set')
  return value
}

export function configHome(): string {
  return join(home(), '.config', 'cuw')
}

/** Reads the credential blob the current `claude auth login` session holds. */
export async function readLoginCredential(): Promise<string | null> {
  const result = await realRunner([
    'security', 'find-generic-password', '-s', CLAUDE_CREDENTIAL_SERVICE, '-w',
  ])
  if (result.code !== 0) return null
  const blob = result.stdout.trim()
  return blob === '' ? null : blob
}

/** Imports the live Claude Code login into the matching account. */
export function syncNow(): Promise<SyncResult> {
  return syncLiveLogin({
    registryFile: registryPath(home()),
    keychain: createKeychain(realRunner),
    login: createLoginStore(realRunner),
    fetchIdentity: token => fetchIdentity(token, {
      fetcher: fetch,
      endpoint: PROFILE_ENDPOINT,
      timeoutMs: REQUEST_TIMEOUT_MS,
      now: new Date(),
    }),
    now: () => Date.now(),
  })
}

export async function buildUsageDeps(): Promise<UsageDeps> {
  const keychain = createRefreshingTokenSource(createKeychain(realRunner), {
    fetcher: fetch,
    now: () => Date.now(),
    login: createLoginStore(realRunner),
    resync: async () => { await syncNow() },
  })
  // Test-only, read-only escape hatches used by the integration suite to point
  // at a stub server. CUW_FAKE_TOKEN supplies a token; it never reveals one.
  // CUW_PROBE_ENDPOINT exists so the fallback can be covered end to end without
  // spending real quota — the probe sends a live inference request, so an
  // uncovered fallback is otherwise the one path no test dares to exercise.
  const endpoint = process.env.CUW_ENDPOINT ?? USAGE_ENDPOINTS[0]
  const fakeToken = process.env.CUW_FAKE_TOKEN
  const resolvedKeychain = fakeToken
    ? { get: async () => fakeToken, set: async () => {}, remove: async () => {} }
    : keychain

  return {
    keychain: resolvedKeychain,
    fetchWindows: token =>
      fetchUsage(token, {
        fetcher: fetch,
        endpoint,
        timeoutMs: REQUEST_TIMEOUT_MS,
      }),
    fetchSubscription: token =>
      fetchSubscription(token, {
        fetcher: fetch,
        endpoint: PROFILE_ENDPOINT,
        timeoutMs: REQUEST_TIMEOUT_MS,
        now: new Date(),
      }),
    probeWindows: token =>
      probeUsage(token, {
        fetcher: fetch,
        endpoint: process.env.CUW_PROBE_ENDPOINT ?? PROBE_ENDPOINT,
        model: PROBE_MODEL,
        timeoutMs: PROBE_TIMEOUT_MS,
      }),
  }
}

/** Reads one line from stdin, so a pasted token never reaches argv or history. */
async function readLine(): Promise<string> {
  const chunks: string[] = []
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(new TextDecoder().decode(chunk))
    if (chunks.join('').includes('\n')) break
  }
  return chunks.join('').split('\n')[0] ?? ''
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

  if (command === 'sync') {
    let result: SyncResult
    try {
      result = await syncNow()
    } catch (error) {
      if (!rest.includes('--quiet')) io.err(`not synced: ${(error as Error).message}`)
      return EXIT_OK
    }
    if (!rest.includes('--quiet')) io.out(describeSync(result) ?? '')
    return EXIT_OK
  }

  // Keeps accounts fresh with no manual step: whatever the terminal is logged
  // into — and whatever Claude Code renewed — lands in the matching account
  // before it is read. Never fatal; a failure only means nothing was imported.
  if (AUTO_SYNC_COMMANDS.has(command) && process.env.CUW_FAKE_TOKEN === undefined) {
    try {
      const result = await syncNow()
      if (result.kind === 'added' || result.kind === 'updated') io.err(describeSync(result)!)
    } catch {
      // Ignored by design.
    }
  }

  const accounts = await loadRegistry(registryPath(home()))

  switch (command) {
    case 'status': {
      return runStatus(
        { json: rest.includes('--json') },
        {
          accounts,
          usage: await buildUsageDeps(),
          collectCodex: () => collectCodexUsage({
            spawn: realCodexAppServerSpawner,
            timeoutMs: CODEX_USAGE_TIMEOUT_MS,
          }),
          collectCursor: buildCollectCursorUsage(realCursorAuthStore(), {
            timeoutMs: CURSOR_USAGE_TIMEOUT_MS,
          }),
          collectGrok: buildCollectGrokUsage(realGrokAuthStore(), {
            timeoutMs: GROK_USAGE_TIMEOUT_MS,
          }),
          color: process.stdout.isTTY === true,
          width: process.stdout.columns ?? DEFAULT_TERM_WIDTH,
          now: new Date(),
        },
        io,
      )
    }
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

    case 'add': {
      const id = rest.find(argument => !argument.startsWith('--'))
      if (!id) {
        io.err('usage: cuw add [--force] <id>')
        return EXIT_USAGE
      }
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
      }, io, { force: rest.includes('--force') })
    }

    case 'login': {
      const ids = rest.filter(argument => !argument.startsWith('--'))
      const raw = createKeychain(realRunner)
      const refreshing = createRefreshingTokenSource(raw, { fetcher: fetch, now: () => Date.now() })
      return runLogin(ids, {
        registryFile: registryPath(home()),
        keychain: raw,
        signIn: createIsolatedLogin({
          run: realRunner,
          spawn: realInteractiveSpawner,
          configDir: join(configHome(), 'profiles', 'login'),
        }),
        fetchIdentity: token => fetchIdentity(token, {
          fetcher: fetch,
          endpoint: PROFILE_ENDPOINT,
          timeoutMs: REQUEST_TIMEOUT_MS,
          now: new Date(),
        }),
        needsLogin: async id => {
          try {
            return (await refreshing.get(id)) === null
          } catch (error) {
            // Only a credential that is provably dead qualifies; a network
            // failure says nothing about the account.
            return error instanceof CredentialError
          }
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

    case 'prime': {
      const cold = rest.includes('--cold')
      const ids = rest.filter(argument => !argument.startsWith('--'))
      if (!cold && ids.length === 0) {
        io.err('usage: cuw prime <id> | cuw prime --cold')
        return EXIT_USAGE
      }
      const usage = await buildUsageDeps()
      // An empty directory, so no CLAUDE.md is discovered by the primed session.
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
          sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
        },
        now: new Date(),
      }, io)
    }

    case 'doctor': {
      return runDoctor({
        accounts,
        usage: await buildUsageDeps(),
        claudeOnPath: async () => (await realRunner(['which', 'claude'])).code === 0,
      }, io)
    }

    default:
      io.err(`unknown command: ${command}`)
      io.err(HELP)
      return EXIT_USAGE
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2))
}
