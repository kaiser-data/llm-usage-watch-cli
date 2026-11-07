# Cursor Usage Design

**Date:** 2026-08-08

## Goal

Extend `cuw status` so it reports the usage meter of the currently logged-in
Cursor account alongside the existing Claude and Codex overviews.

This first version supports exactly one Cursor account: whichever account the
local Cursor app is logged into. It does not add Cursor account registration,
credential storage in the `cuw` Keychain, account switching, priming, or
recommendations.

## Chosen integration

`cuw` reads the active Cursor session JWT from the local Cursor SQLite state
database (`state.vscdb`, key `cursorAuth/accessToken`) and calls Cursor's
unofficial Dashboard Connect RPC:

`POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage`

with headers:

- `Authorization: Bearer <accessToken>`
- `Content-Type: application/json`
- `Connect-Protocol-Version: 1`
- body `{}`

Plan label comes from `cursorAuth/stripeMembershipType` in the same database,
optionally refined by `GetPlanInfo` when available.

Access tokens are short-lived JWTs. When expired, `cuw` refreshes in memory via
`POST https://api2.cursor.sh/oauth/token` using the local refresh token. Refreshed
tokens are never written back into Cursor's database and never stored in the
`cuw` Keychain.

This mirrors the Codex "active login" pattern: read through the product's own
auth material on the machine, normalize at the boundary, and isolate failures.

## Architecture

### Cursor auth reader

A focused module locates the platform-specific `state.vscdb` path, opens it
read-only, and returns access token, refresh token, and membership type. Path
and DB access are dependency-injected so tests never touch a real Cursor install.

### Cursor usage client

A second module owns HTTP calls and normalization. Its public operation returns
a normalized `CursorUsage` and does not expose tokens or raw response bodies.

The module must:

- obtain credentials via the auth reader;
- refresh expired access tokens in memory when needed;
- call `GetCurrentPeriodUsage` with a short timeout;
- validate and normalize the response;
- classify failures into a small safe set.

### Normalized data

Cursor limits remain separate from Claude's `UsageWindows` and Codex buckets.
Cursor exposes a USD-denominated included pool plus Auto/API percentage lanes,
so forcing those into either existing shape would discard information.

```ts
type CursorErrorCause =
  | 'not-installed'
  | 'not-logged-in'
  | 'auth'
  | 'network'
  | 'schema'
  | 'timeout'

type CursorUsageLimit = {
  id: 'plan' | 'auto' | 'api' | 'on-demand'
  name: string | null
  usedPct: number
  resetsAt: Date | null
}

type CursorUsage = {
  provider: 'cursor'
  plan: string | null
  periodEnd: Date | null
  limits: CursorUsageLimit[]
  error: { cause: CursorErrorCause; message: string } | null
}
```

Normalization:

- `plan` from `planUsage.totalPercentUsed`, or `includedSpend / limit` when the
  percent is absent; `resetsAt` from `billingCycleEnd`
- `auto` / `api` from `autoPercentUsed` / `apiPercentUsed` when present
- `on-demand` only when an individual or pooled spend limit is set and greater
  than zero
- percentages are clamped/validated; unknown fields are ignored
- tokens and email addresses never appear in the normalized value

### Status orchestration

`runStatus` starts Claude, Codex, and Cursor collection concurrently. A failure
on any side never prevents the others from rendering. Claude classification,
recommendation, priming, add/remove, and doctor logic remain unchanged.

## Output

### Terminal

Claude, then Codex, then a separate `CURSOR` section:

- account label (`active`)
- plan
- one row per normalized limit (`plan`, `auto`, `api`, optional `on-demand`)
- usage percentage and bar
- reset countdown when supplied

If Cursor is unavailable, the section contains one concise actionable message.
Raw response bodies and tokens are never rendered.

### JSON

```json
{
  "claude": [],
  "codex": { "provider": "codex", "plan": null, "limits": [], "error": null },
  "cursor": {
    "provider": "cursor",
    "plan": "pro",
    "periodEnd": "2026-09-01T00:00:00.000Z",
    "limits": [],
    "error": null
  }
}
```

Dates serialize as ISO strings through `JSON.stringify`.

## Error and exit-code behavior

Cursor failures are display-level and do not change the command exit code.
Claude authentication remains authoritative for exit codes (`0` / `2` / `1`).

Cursor error causes:

- state database missing (`not-installed`)
- no login / refresh requires re-auth (`not-logged-in`)
- 401 after refresh (`auth`)
- network failure
- schema/normalization failure
- timeout

## Testing

Auth and HTTP boundaries are dependency-injected. Coverage includes missing DB,
missing token, expired JWT with successful refresh, `shouldLogout`, 401, schema
drift, percent/period normalization, Auto/API/on-demand rows, render, combined
JSON, and unchanged Claude exit codes when Cursor fails.

Verification: `bun test`, `bunx tsc --noEmit`, `bun run build`.

## Documentation and scope

`README.md`, `docs/HOW-IT-WORKS.md`, and `docs/CURSOR-USAGE.md` describe the
combined status, active-account behavior, local-login prerequisite, and JSON
shape.

Out of scope for this version:

- multi-account Cursor registry, switching, or priming
- writing refreshed tokens back to Cursor storage
- Enterprise Admin/Analytics API keys
- doctor Cursor diagnostics
- recommendations based on Cursor usage
