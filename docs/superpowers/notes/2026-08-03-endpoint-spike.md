# Endpoint spike — 2026-08-03

**Decision: API path is viable.** Task 4 proceeds as written; the probe path
remains as the fallback only.

## How the endpoint was found

`claude` is a single ~257 MB bundle at
`~/.local/share/claude/versions/<version>`. Grepping it for quoted API
paths surfaced `"/api/oauth/usage"`, and the surrounding source shows the call
site:

```js
async function $ke(){return Vc("api_usage_fetch",async()=>{
  ...
  let r=await Hi.get("/api/oauth/usage",{timeout:5000,
    headers:{"Content-Type":"application/json"},refreshOAuth:!0});
  if(!r.ok)throw Error(...); return r});
  ... return t.data})
```

Notable: a 5 s timeout, and `refreshOAuth: true` — the CLI refreshes an expired
OAuth token and retries once on 401. `cuw` uses long-lived `setup-token`
credentials instead, which do not need that refresh dance.

## Live probe

```
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <token>
anthropic-beta: oauth-2025-04-20
→ HTTP 200
```

Top-level keys returned:

```
five_hour, seven_day, seven_day_oauth_apps, seven_day_opus, seven_day_sonnet,
seven_day_cowork, seven_day_omelette, tangelo, iguana_necktie,
omelette_promotional, nimbus_quill, cinder_cove, amber_ladder,
extra_usage, limits, spend, member_dashboard_available
```

Real values observed:

```json
"five_hour": { "utilization": <pct>, "resets_at": "<iso-8601>",
               "limit_dollars": null, "used_dollars": null, "remaining_dollars": null }
"seven_day": { "utilization": <pct>, "resets_at": "<iso-8601>", ...  }
"seven_day_opus": null
"limits": [
  { "kind": "session",    "group": "session", "percent": <pct>, "severity": "normal",
    "resets_at": "...", "scope": null, "is_active": false },
  { "kind": "weekly_all", "group": "weekly",  "percent": <pct>, "severity": "normal",
    "resets_at": "...", "scope": null, "is_active": true }
]
```

## Field mapping

The plan's guessed `FIELD_PATHS` were correct. Confirmed mapping:

| `UsageWindows` field | Source path |
|---|---|
| `fiveHourPct` | `five_hour.utilization` |
| `fiveHourResetsAt` | `five_hour.resets_at` (ISO 8601) |
| `weeklyPct` | `seven_day.utilization` |
| `weeklyResetsAt` | `seven_day.resets_at` |
| `opusWeeklyPct` | `seven_day_opus.utilization`, `null` on this plan |

**Utilization is on a 0–100 scale**, not 0–1 (e.g. `23.0` = 23%). `firstNumber`
already handles both, so no change is needed — but a future 0–1 payload would
be silently misread only if a value happened to be ≤ 1, i.e. under 1% used. That
is an acceptable edge.

**Per-model keys are nullable.** `seven_day_opus` and `seven_day_sonnet` were
both `null` on this plan, so `pick()` must tolerate a null intermediate — it
does, since it type-checks each hop.

## Open observations

- `limits[]` is a redundant second view of the same numbers, keyed by
  `kind: "session" | "weekly_all"` with an integer `percent`. Not used: the
  top-level objects are simpler and carry the same values. Worth switching to if
  the top-level keys are ever removed.
- Several top-level keys are unreleased-feature codenames (`tangelo`,
  `iguana_necktie`, `nimbus_quill`, …), all `null`. Ignored.
- `extra_usage` and `spend` carry real billing figures. **The committed fixture
  has these amounts zeroed**; every other field is verbatim from the live
  response. No token, email, or account UUID appears in the payload.

## Fixture

`tests/fixtures/usage-api.json` — the real 200 response, billing amounts
neutralised. This is the reference for `normalizeApiResponse`.
