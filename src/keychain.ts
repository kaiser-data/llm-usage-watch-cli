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
