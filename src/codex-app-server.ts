import {
  CodexSchemaError,
  failedCodexUsage,
  normalizeCodexRateLimits,
} from './codex-usage'
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

class CodexClientError extends Error {
  constructor(override readonly cause: CodexErrorCause, message: string) {
    super(message)
    this.name = 'CodexClientError'
  }
}

type RpcRecord = Record<string, unknown>

function rpcRecord(value: unknown): RpcRecord | null {
  return typeof value === 'object' && value !== null
    ? value as RpcRecord
    : null
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
      if (chunk.done) {
        throw new CodexClientError('process', 'Codex app-server exited early')
      }
      buffer += decoder.decode(chunk.value, { stream: true })

      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.trim() === '') continue

        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          throw new CodexClientError('protocol', 'Codex app-server returned invalid JSON')
        }
        const message = rpcRecord(parsed)
        if (message === null) {
          throw new CodexClientError('protocol', 'Codex returned an invalid message')
        }
        if ('id' in message) pending.push(message)
      }
    }
  }

  process.write({
    method: 'initialize',
    id: 0,
    params: {
      clientInfo: { name: 'cuw', title: 'LLM Usage Watch', version: '0.1.0' },
    },
  })
  const initialized = await response(0)
  if (initialized.error !== undefined) {
    throw new CodexClientError('protocol', 'Codex app-server initialization failed')
  }

  process.write({ method: 'initialized', params: {} })
  process.write({ method: 'account/rateLimits/read', id: 1 })
  const limits = await response(1)
  if (limits.error !== undefined) {
    throw new CodexClientError(
      'not-logged-in',
      'Codex is not logged into a ChatGPT account — run `codex login`',
    )
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
    if (error instanceof CodexClientError) {
      return failedCodexUsage(error.cause, error.message)
    }
    if (error instanceof CodexSchemaError) {
      return failedCodexUsage('protocol', 'Codex returned an unrecognized rate-limit response')
    }
    return failedCodexUsage('process', 'Codex usage could not be read')
  } finally {
    if (timeout !== null) clearTimeout(timeout)
    try {
      process?.kill()
    } catch {
      // The child may already be gone; cleanup must not replace the status result.
    }
  }
}

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
