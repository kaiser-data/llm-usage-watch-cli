import { classify, recommend } from '../classify'
import { failedCodexUsage } from '../codex-usage'
import { renderCodexUsage, renderTable } from '../render'
import type { Account, CodexUsage } from '../types'
import { collectUsage, type UsageDeps } from '../usage'

export type Io = { out: (text: string) => void; err: (text: string) => void }

export type StatusDeps = {
  accounts: Account[]
  usage: UsageDeps
  collectCodex: () => Promise<CodexUsage>
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

  const hasAuthProblem = rows.some(
    row => row.error?.cause === 'auth' || row.error?.cause === 'no-token',
  )
  return hasAuthProblem ? EXIT_AUTH : EXIT_OK
}
