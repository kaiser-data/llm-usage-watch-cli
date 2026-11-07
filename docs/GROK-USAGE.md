# Grok usage meter (grokmeter)

`cuw` shows the usage meter for the Grok account currently logged into the
local Grok CLI, alongside Claude, Codex, and Cursor.

## Prerequisites

The Grok CLI must be installed and signed in on this machine:

```sh
grok login
```

`cuw` reads the active session from `~/.grok/auth.json` (or `$GROK_HOME/auth.json`)
and never stores Grok tokens in the `cuw` Keychain.

## Use

```sh
cuw                 # Claude, Codex, Cursor, and Grok sections
cuw status --json   # machine-readable combined output
```

Terminal output places Grok below Cursor:

```text
GROK  active  PLAN pro
LIMIT       USED             RESETS
──────────────────────────────────
monthly       1%  ░░░░░░░░░     24d
```

If an on-demand spend cap is configured and greater than zero, an `on-demand`
row is shown as well.

## JSON shape

```json
{
  "claude": [],
  "codex": {},
  "cursor": {},
  "grok": {
    "provider": "grok",
    "plan": "pro",
    "periodEnd": "2026-09-01T00:00:00.000Z",
    "limits": [
      {
        "id": "monthly",
        "name": "monthly",
        "usedPct": 1,
        "resetsAt": "2026-09-01T00:00:00.000Z"
      }
    ],
    "error": null
  }
}
```

On a Grok read failure, Claude / Codex / Cursor remain available and
`grok.error` carries a short safe message. Grok failures do not change the
command exit code.

## Technical flow

1. Open `~/.grok/auth.json` read-only and load the access token, refresh token,
   OIDC client id, and expiry.
2. When the access token is near expiry, refresh in memory via
   `POST https://auth.x.ai/oauth2/token`. Refreshed tokens are not written back
   to Grok's auth file.
3. Call `GET https://cli-chat-proxy.grok.com/v1/billing` for the monthly credit
   pool and, in parallel, `GET .../user?include=subscription` for the plan
   label (`subscriptionTiers`).
4. Normalize `used / monthlyLimit` (and optional on-demand) into percentage rows.

These first-party CLI proxy endpoints are unofficial and may change. Claude and
Grok remain independent: a Grok failure never hides Claude results.
