import type {
  CodexErrorCause,
  CodexUsage,
  CodexUsageLimit,
  CodexUsageWindow,
} from './types'

export class CodexSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexSchemaError'
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : null
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function nullableInteger(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new CodexSchemaError(`invalid ${field}`)
  }
  return value as number
}

function windowValue(
  value: unknown,
  role: CodexUsageWindow['role'],
): CodexUsageWindow | null {
  if (value === null || value === undefined) return null
  const source = record(value)
  if (source === null) throw new CodexSchemaError(`invalid ${role} window`)

  const usedPct = source.usedPercent
  if (!Number.isInteger(usedPct) || (usedPct as number) < 0 || (usedPct as number) > 100) {
    throw new CodexSchemaError(`invalid ${role} usedPercent`)
  }

  const durationMinutes = nullableInteger(source.windowDurationMins, `${role} duration`)
  const resetsAtSeconds = nullableInteger(source.resetsAt, `${role} reset`)
  return {
    role,
    usedPct: usedPct as number,
    durationMinutes,
    resetsAt: resetsAtSeconds === null ? null : new Date(resetsAtSeconds * 1000),
  }
}

function limitValue(
  key: string,
  value: unknown,
): { limit: CodexUsageLimit; plan: string | null } {
  const source = record(value)
  if (source === null) throw new CodexSchemaError(`invalid Codex limit ${key}`)

  const primary = windowValue(source.primary, 'primary')
  const secondary = windowValue(source.secondary, 'secondary')
  return {
    limit: {
      id: nullableString(source.limitId) ?? key,
      name: nullableString(source.limitName),
      windows: [primary, secondary].filter(
        (item): item is CodexUsageWindow => item !== null,
      ),
    },
    plan: nullableString(source.planType),
  }
}

export function failedCodexUsage(cause: CodexErrorCause, message: string): CodexUsage {
  return { provider: 'codex', plan: null, limits: [], error: { cause, message } }
}

export function normalizeCodexRateLimits(raw: unknown): CodexUsage {
  const source = record(raw)
  if (source === null) {
    throw new CodexSchemaError('Codex rate-limit result was not an object')
  }

  const multi = record(source.rateLimitsByLimitId)
  const entries = multi !== null && Object.keys(multi).length > 0
    ? Object.entries(multi)
    : source.rateLimits === null || source.rateLimits === undefined
      ? []
      : [['codex', source.rateLimits] as [string, unknown]]
  if (entries.length === 0) {
    throw new CodexSchemaError('Codex returned no rate-limit buckets')
  }

  const parsed = entries.map(([key, value]) => limitValue(key || 'codex', value))
  return {
    provider: 'codex',
    plan: parsed.map(item => item.plan).find((plan): plan is string => plan !== null) ?? null,
    limits: parsed.map(item => item.limit),
    error: null,
  }
}
