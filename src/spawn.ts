/**
 * Spawning a child with an environment map, so a token is passed via the
 * environment and never appears in argv (where `ps` would expose it).
 * Shared by the probe path and the prime command.
 */
export type SpawnResult = { code: number; stderrTail: string }

export type Spawner = (
  argv: string[],
  env: Record<string, string>,
  cwd: string,
) => Promise<SpawnResult>

const STDERR_TAIL_BYTES = 2_000

export const realSpawner: Spawner = async (argv, env, cwd) => {
  const proc = Bun.spawn(argv, { env, cwd, stdout: 'ignore', stderr: 'pipe' })
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  return { code, stderrTail: stderr.slice(-STDERR_TAIL_BYTES) }
}
