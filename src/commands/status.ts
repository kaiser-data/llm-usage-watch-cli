import { classify, recommend } from '../classify'
import { failedCodexUsage } from '../codex-usage'
import { failedCursorUsage } from '../cursor-usage'
import { failedGrokUsage } from '../grok-usage'
import {
  renderCodexUsage,
  renderCursorUsage,
  renderGrokUsage,
  renderTable,
} from '../render'
import type { Account, CodexUsage, CursorUsage, GrokUsage } from '../types'
import { collectUsage, type UsageDeps } from '../usage'

export type Io = { out: (text: string) => void; err: (text: string) => void }

export type StatusDeps = {
  accounts: Account[]
  usage: UsageDeps
  collectCodex: () => Promise<CodexUsage>
  collectCursor: () => Promise<CursorUsage>
  collectGrok: () => Promise<GrokUsage>
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
  const [rows, codex, cursor, grok] = await Promise.all([
    collectUsage(deps.accounts, deps.usage),
    deps.collectCodex().catch(() =>
      failedCodexUsage('process', 'Codex usage could not be read')),
    deps.collectCursor().catch(() =>
      failedCursorUsage('network', 'Cursor usage could not be read')),
    deps.collectGrok().catch(() =>
      failedGrokUsage('network', 'Grok usage could not be read')),
  ])
  const rec = recommend(rows)
  const options = { color: deps.color, width: deps.width, now: deps.now }

  if (args.json) {
    io.out(JSON.stringify({
      claude: rows.map(row => ({ ...row, state: classify(row) })),
      codex,
      cursor,
      grok,
    }, null, 2))
  } else {
    const claude = renderTable(rows, rec, options).trimEnd()
    const codexText = renderCodexUsage(codex, options).trimEnd()
    const cursorText = renderCursorUsage(cursor, options).trimEnd()
    const grokText = renderGrokUsage(grok, options).trimEnd()
    io.out(`${claude}\n\n${codexText}\n\n${cursorText}\n\n${grokText}\n`)
  }

  const hasAuthProblem = rows.some(
    row => row.error?.cause === 'auth' || row.error?.cause === 'no-token',
  )
  return hasAuthProblem ? EXIT_AUTH : EXIT_OK
}
