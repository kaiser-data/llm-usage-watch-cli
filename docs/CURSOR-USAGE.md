# Cursor usage meter

`cuw` shows the usage meter for the Cursor account currently logged into the
local Cursor app, alongside Claude and Codex.

## Prerequisites

Cursor must be installed and signed in on this machine. `cuw` reads the active
session from Cursor's local state database and never stores Cursor tokens in the
`cuw` Keychain.

## Use

```sh
cuw                 # Claude, Codex, and Cursor sections
cuw status --json   # machine-readable combined envelope
```

Terminal output places Cursor below Codex:

```text
CURSOR  active  PLAN pro
LIMIT       USED             RESETS
──────────────────────────────────
plan         46%  ▓▓▓▓░░░░░     12d
auto          0%  ░░░░░░░░░     12d
api          46%  ▓▓▓▓░░░░░     12d
```

Rows:

- `plan` — included monthly pool percent used
- `auto` — Auto-mode lane percent when reported
- `api` — manual/named-model lane percent when reported
- `on-demand` — only when a spend limit is configured

## JSON

```json
{
  "claude": [],
  "codex": { "provider": "codex", "plan": null, "limits": [], "error": null },
  "cursor": {
    "provider": "cursor",
    "plan": "pro",
    "periodEnd": "2026-09-01T00:00:00.000Z",
    "limits": [
      {
        "id": "plan",
        "name": "plan",
        "usedPct": 46,
        "resetsAt": "2026-09-01T00:00:00.000Z"
      }
    ],
    "error": null
  }
}
```

`limits` and `error` are always present. On a read failure, Claude and Codex
output remain available and `cursor.error` carries a short safe message. Cursor
failures never change the exit code.

## How the read works

1. Open Cursor's `state.vscdb` read-only and load `cursorAuth/accessToken`,
   `cursorAuth/refreshToken`, and `cursorAuth/stripeMembershipType`.
2. If the access token JWT is near expiry, refresh in memory via
   `POST https://api2.cursor.sh/oauth/token`. Refreshed tokens are not written
   back to Cursor's database.
3. Call
   `POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage`
   (Connect RPC v1) and normalize the response.

These dashboard endpoints are unofficial and may change. Claude and Cursor
collection run concurrently with Codex.

## Troubleshooting

- State database missing: install Cursor and open it at least once.
- Not logged in / refresh requires logout: sign in through the Cursor app, then
  re-run `cuw`.
- Auth rejected: sign out and back into Cursor so tokens refresh.
- Timeout or network: retry; Cursor errors do not hide Claude or Codex.
