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
