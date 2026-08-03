#!/usr/bin/env bun
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CLAUDE_CREDENTIAL_SERVICE,
  DEFAULT_TERM_WIDTH,
  REQUEST_TIMEOUT_MS,
  USAGE_ENDPOINTS,
} from './constants'
import { createKeychain, realRunner } from './keychain'
import { createRefreshingTokenSource } from './token-source'
import { loadRegistry, registryPath } from './registry'
import { realSpawner } from './spawn'
import { fetchUsage } from './usage-api'
import { probeUsage } from './usage-probe'
import { EXIT_OK, EXIT_USAGE, runStatus, type Io } from './commands/status'
import { runAdd } from './commands/add'
import { runRm } from './commands/rm'
import { runPrime } from './commands/prime'
import { runDoctor } from './commands/doctor'
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

/** Reads the credential blob the current `claude auth login` session holds. */
export async function readLoginCredential(): Promise<string | null> {
  const result = await realRunner([
    'security', 'find-generic-password', '-s', CLAUDE_CREDENTIAL_SERVICE, '-w',
  ])
  if (result.code !== 0) return null
  const blob = result.stdout.trim()
  return blob === '' ? null : blob
}

export async function buildUsageDeps(): Promise<UsageDeps> {
  const keychain = createRefreshingTokenSource(createKeychain(realRunner), {
    fetcher: fetch,
    now: () => Date.now(),
  })
  const scratchDir = await mkdtemp(join(tmpdir(), 'cuw-scratch-'))

  // Test-only, read-only escape hatches used by the integration suite to point
  // at a stub server. CUW_FAKE_TOKEN supplies a token; it never reveals one.
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
    probeWindows: token =>
      probeUsage(token, {
        spawn: realSpawner,
        scratchDir,
        configDir: join(configHome(), 'profiles', 'probe'),
        logPath: join(scratchDir, 'debug.log'),
        readLog: path => readFile(path, 'utf8'),
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
  const accounts = await loadRegistry(registryPath(home()))

  switch (command) {
    case 'status': {
      return runStatus(
        { json: rest.includes('--json') },
        {
          accounts,
          usage: await buildUsageDeps(),
          color: process.stdout.isTTY === true,
          width: process.stdout.columns ?? DEFAULT_TERM_WIDTH,
          now: new Date(),
        },
        io,
      )
    }
    case 'add': {
      const id = rest[0]
      if (!id) {
        io.err('usage: cuw add <id>')
        return EXIT_USAGE
      }
      return runAdd(id, {
        registryFile: registryPath(home()),
        keychain: createKeychain(realRunner),
        readLoginCredential,
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
