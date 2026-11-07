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
  io.out(hasClaude
    ? '✓ claude: found on PATH'
    : '✗ claude: not found on PATH — priming and the probe path will fail')
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
      ? 'usage API unavailable, using the probe fallback (spends a request, and opens a window on an idle account)'
      : 'usage API healthy'
    io.out(`✓ ${row.id}: ${row.source} — ${note}`)
  }

  return healthy ? 0 : 2
}
