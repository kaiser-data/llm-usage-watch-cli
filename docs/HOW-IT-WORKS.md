# How `cuw` works

A working reference for whoever picks this up next — including future me.

## The problem it solves

Several Claude subscriptions plus one active Codex account, one machine. Two
costs made the Claude subscriptions painful to use together:

1. **Seeing usage required switching logins.** `claude auth login` holds exactly
   one credential, so checking another subscription meant logging out, logging
   in, looking, and logging back — destroying the working session each time.
2. **A fresh subscription is not ready to use.** The five-hour window starts at
   an account's *first message*, not at midnight. Switching to an untouched
   account means waiting up to five hours for a window to open.

`cuw` answers both: it reads every subscription at once without touching the
active login, and `cuw prime` opens a window for a few tokens so the accounts
are staggered and one is always ready.

The same status command also reads the account-wide limits for the currently
logged-in Codex account. That read is independent of any running Codex app,
conversation, or agent session.

## Current state

Three of four subscriptions registered: `superclaude`, `nimzo`, `main`.
`silverblock` is still pending — see *Adding an account* below for why it keeps
failing.

```
ACCOUNT      PLAN  5H WINDOW        RESETS  WEEKLY         RESETS   RENEWS  STATE
────────────────────────────────────────────────────────────────────────────────
superclaude  pro   100%  ▓▓▓▓▓▓▓▓▓     16m    44%  ▓▓▓▓░░░░░  18h46m  ~27d18h  ■ spent
nimzo        pro    93%  ▓▓▓▓▓▓▓▓░   3h56m    44%  ▓▓▓▓░░░░░   4d22h  ~24d19h  ▲ hot
main         pro    16%  ▓░░░░░░░░   4h46m    68%  ▓▓▓▓▓▓░░░   1d14h      ~2d  ● warm

→ use: main  (only 32% of the weekly limit left — that is what binds)

CODEX  active  PLAN plus
LIMIT  WINDOW         USED             RESETS
──────────────────────────────────────────────
codex  primary 7d      73%  ▓▓▓▓▓▓▓░░      4d
```

## Authentication — the part that took three attempts to get right

### What does not work: `claude setup-token`

The original design used long-lived tokens from `claude setup-token`. They are
refused by the usage endpoint with **HTTP 403**. The CLI's own source explains
why:

> Long-lived tokens (from `claude setup-token` or `CLAUDE_CODE_OAUTH_TOKEN`) are
> limited to inference-only for security reasons.

They carry `user:inference` but not `user:profile`, and `/api/oauth/usage`
requires `user:profile`. The original spike missed this because it validated the
endpoint with a full-scope *session* token — the wrong credential type.

### What works: a copy of the login credential

`claude auth login` writes a blob to the macOS Keychain under service
`Claude Code-credentials`:

```json
{ "claudeAiOauth": {
    "accessToken": "…", "refreshToken": "…", "expiresAt": 1785…,
    "scopes": ["user:inference", "user:profile", …],
    "subscriptionType": "pro" } }
```

`cuw add <id>` copies that blob into its own Keychain entry, service
`cuw-token`, account `<id>`. Full scope, so usage reads work; and because it is
a *copy*, `cuw` keeps working after you log into a different subscription.

### Staying alive

The access token expires in ~8 hours. `src/token-source.ts` wraps the Keychain:
on every read it parses the credential, and if the token is expired (or within
`REFRESH_SKEW_MS`, 5 min) it POSTs a `refresh_token` grant to
`https://platform.claude.com/v1/oauth/token` with Claude Code's public client id,
persists the rotated credential, and returns the new access token.

It is deliberately shaped as a `Keychain` (`get`/`set`/`remove`), so `usage.ts`,
`prime.ts` and `doctor.ts` consume it unchanged — they only ever needed "give me
a usable token for this account".

Refresh tokens last months, so in practice you log in once per subscription.

## Where the numbers come from

### Claude subscriptions

Two endpoints, both hit concurrently per account, and all accounts concurrently
with each other:

| Endpoint | Gives | On failure |
|---|---|---|
| `GET /api/oauth/usage` | `five_hour.utilization`, `seven_day.utilization`, `resets_at` for each | falls back to the probe path |
| `GET /api/oauth/profile` | plan tier, `subscription_status`, `subscription_created_at` | returns `null`; the row still renders |

Utilization is on a **0–100 scale** (`23.0` = 23%), not 0–1.

`limits[]` in the usage payload is a redundant second view of the same numbers
keyed by `kind: "session" | "weekly_all"`. Unused, but a ready fallback if the
top-level keys ever disappear.

### The probe path, and why it is not the default

`src/usage-probe.ts` runs a minimal `claude -p` and parses the
`anthropic-ratelimit-unified-*` response headers from the debug log. It exists so
the tool degrades instead of going dark if the usage endpoint changes shape.

**It must never be used for routine status reads.** A probe *is* an inference
request, so it opens a five-hour window. Auto-probing on every `cuw` would open
windows on all four accounts and destroy the staggering the tool exists to
provide. That is why a 403 stays a hard, explained error rather than silently
falling back.

Rows served by the probe are marked `(probe)` so the source is never ambiguous.

### Codex: short-lived app-server read

For the active Codex login, `cuw` starts `codex app-server`, completes its JSONL
initialization handshake, calls `account/rateLimits/read`, normalizes every
returned bucket and primary/secondary window, and terminates the child. This is
account-wide data; it does not depend on a running Codex conversation, desktop
app, or CLI session.

The app-server owns authentication and refresh. `cuw` does not read Codex auth
files, copy tokens, inspect conversation logs, or call a private HTTP endpoint.
Only normalized plan, bucket, percentage, duration, and reset values cross the
process boundary. Raw protocol errors and stderr are discarded.

Claude and Codex collection start concurrently. A Codex failure becomes a safe
message in the Codex section and cannot suppress the Claude table,
recommendation, or exit code.

## Choosing an account

### Classification (`src/classify.ts`)

| State | Meaning |
|---|---|
| `cold` | no active five-hour window — nothing is ticking |
| `warm` | window active, under 70% |
| `hot` | 70–99% |
| `spent` | five-hour **or weekly** at 100% |
| `unknown` | the row carries an error; excluded from recommendation |

Weekly at 100% counts as `spent` regardless of the session window: the weekly
limit recovers over days, so a fresh five-hour window on that account is
worthless.

### The recommendation

Ranked by the **binding limit** — `min(fiveHourHeadroom, weeklyHeadroom)` — not
by session headroom alone. This is the difference that matters in practice:

> `main` had a much fresher session window (16% vs nimzo's 93%), but its weekly
> budget was at 68%. Ranking on session headroom alone would have recommended
> the account with only 32% of its week left. The footer now names which limit
> actually binds.

Ties break on weekly headroom, since that is the slower one to recover. A `cold`
account counts as 100% session headroom and gets a "run `cuw prime`" nudge.

## Priming

`cuw prime <id>` opens the five-hour window with the smallest real request
possible:

```
claude -p "hi" --model haiku --tools "" --safe-mode --no-session-persistence
```

with `CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_CONFIG_DIR` in the **environment**
(never argv — `ps` would expose a token), and an empty working directory so no
`CLAUDE.md` is discovered. `--safe-mode` strips plugins, hooks, MCP servers and
skills. Cost: tens of tokens.

Afterwards it **re-reads usage to confirm a window actually opened**, and reports
failure rather than success if not. `cuw prime --cold` does this for every
account currently classified `cold`.

Note: `claude auth login` appears to open the window by itself, so freshly
logged-in accounts are already ticking and `--cold` will find less to do than
expected.

## Adding an account

```
claude auth login      # in a terminal you are not working in
cuw add <id>
```

**The recurring failure:** if the browser still holds a claude.ai session, OAuth
auto-approves that account and the login silently lands on the wrong
subscription. This is what has blocked `silverblock` — three attempts all
returned `nimzo`. Account selection happens entirely in the browser; the CLI
cannot influence it. Fix by signing out (`open https://claude.ai/logout`) or
opening the printed authorize URL in a private window first.

`cuw add` works fine on an exhausted account — it only reads the credential, it
makes no inference request. Registering a spent subscription is in fact the
point: the table then tells you when it comes back.

## Switching the login

`cuw use` repoints the machine's Claude Code login. The whole design is dictated
by one fact about the `Claude Code-credentials` Keychain item: **it is not only
the login.**

```
mcpOAuth.<server>.accessToken     every connected MCP server's OAuth token
mcpOAuth.<server>.discoveryState.*
claudeAiOauth.accessToken
claudeAiOauth.refreshToken
claudeAiOauth.expiresAt
claudeAiOauth.refreshTokenExpiresAt
claudeAiOauth.scopes
claudeAiOauth.subscriptionType
claudeAiOauth.rateLimitTier
```

Two consequences, both load-bearing:

**The write merges.** `mergeLogin` in `login.ts` is pure: it returns the live
blob with only `claudeAiOauth` replaced. Writing `{claudeAiOauth: …}` over the
item would destroy every MCP server authorization stored beside it — silently,
with no way back. That single function carries the feature's most important
test.

**The stored credential is verbatim.** `Credential.raw` holds the whole
`claudeAiOauth` branch as read. cuw models four of its fields; reconstructing the
branch from those four would drop `subscriptionType`, `rateLimitTier`,
`refreshTokenExpiresAt`, and anything Anthropic adds later. `refreshCredential`
projects new tokens back into `raw` so the passthrough cannot go stale — and
deliberately refuses to give a legacy credential a passthrough it never had.

**Identification before destruction.** The switch resolves who is currently
logged in by fetching `/api/oauth/profile` for the live credential and matching
`account.uuid` against the registry. If the profile cannot be read, the switch
**aborts**: capturing the outgoing login is the safety net for a destructive
write, and the net depends on identifying it. If the login is unknown, it is
captured as a new account first. Capture is suppressed while any account still
lacks a `uuid`, because a half-migrated registry cannot tell "untracked" from
"tracked but never identified", and guessing wrong duplicates an account.

Accounts added before `Credential.raw` existed are refused with a re-add
instruction. No automatic migration is possible: cuw never sees a full login blob
again after `add`.

## Module map

```
cli.ts                 argument parsing, dependency wiring, the only place
                       that touches the real Keychain / network / processes
  ├─ registry.ts       ~/.config/cuw/accounts.json — ids and labels, NO secrets
  ├─ keychain.ts       security(1) wrapper, secret-safe by construction
  ├─ credentials.ts    parse / validate scope / refresh the OAuth credential
  ├─ token-source.ts   Keychain decorator: always returns a valid access token
  ├─ usage-api.ts      /api/oauth/usage client + schema validation
  ├─ profile.ts        /api/oauth/profile client (plan, renewal estimate)
  ├─ usage-probe.ts    fallback: minimal request, rate-limit header parse
  ├─ usage.ts          per-account orchestration and fallback policy
  ├─ codex-usage.ts    validate/normalize arbitrary Codex limit buckets
  ├─ codex-app-server.ts short-lived JSONL client + process lifecycle
  ├─ classify.ts       state + recommendation            (pure)
  ├─ render.ts         table, bars, countdowns, colour   (pure)
  ├─ login.ts          the live login item: read, pure merge, write
  ├─ prime.ts          isolated `claude -p` invocation
  └─ commands/         status, use, add, rm, prime, doctor
```

`classify.ts` and `render.ts` do no I/O and read no environment — TTY-ness,
terminal width and the current time are passed in. That is what makes them
exhaustively testable.

## Invariants — do not break these

- **Never replace the login item, only merge into it.** `mergeLogin` is the sole
  writer of `claudeAiOauth`, and it preserves every other top-level key. The MCP
  server tokens live in that same item.
- **Tokens may appear only** in `keychain.ts`, `credentials.ts`, `login.ts`,
  `token-source.ts`, `usage-probe.ts`, `prime.ts` and `cli.ts`. Never in a
  render, JSON, or log path. Error messages discard response bodies and stderr
  tails that could echo credentials; `prime.ts` has a `redact()` helper.
- **Never auto-probe for routine reads.** See above.
- **Never read Codex credentials or session files directly.** Authentication
  stays inside `codex app-server`; raw stdout messages and stderr never reach
  terminal or JSON output.
- **One failing account or provider must never fail the command.** Each Claude
  row carries its own error, and Codex has a provider-level safe error. Claude
  and Codex run independently under `Promise.all`.
- **Codex never affects Claude recommendation or exit status.** Exit `2`
  continues to mean a missing or rejected Claude credential.
- **Never report a primed window without confirming it.**
- **The test fixture is synthetic** (`tests/fixtures/usage-api.json`: year-2099
  timestamps, USD, zeroed amounts) because the repo is public. Do not replace it
  with a live capture — the original contained real billing figures, and an
  earlier commit had to be discarded from git history to remove them.
- **Run `bunx tsc --noEmit` as well as `bun test`.** A tests-only loop once
  missed nine strict-mode errors, including a `sort()[0]` that could be
  `undefined`.

## Known limits

- **Only the active Codex account is shown.** This version does not register,
  switch, or aggregate multiple Codex accounts. The Codex CLI must be installed
  and logged in, but no Codex session needs to be running.
- **The JSON top level changed intentionally.** `cuw status --json` returns
  `{ "claude": [...], "codex": {...} }`; consumers of the former top-level
  Claude array must select the `claude` property.
- **No subscription end date exists.** The API exposes no `current_period_end`
  or `subscription_ends_at`. The `RENEWS` column is *derived* — the next monthly
  anniversary of `subscription_created_at` — and is prefixed `~` to say so. An
  annual plan renews later than shown. A real `claude_code_trial_ends_at`, when
  present, is shown instead and is authoritative.
- **`HOME` overrides break Keychain access.** `security` resolves the login
  keychain through `$HOME`, so sandboxing a test with `HOME=$(mktemp -d)`
  produces a false "no Claude Code login found". Any test touching the Keychain
  must use the real `HOME`.
- **The refresh endpoint rate-limits.** After many logins in quick succession,
  `POST /v1/oauth/token` returns `rate_limit_error`, and a throttled response is
  indistinguishable from a dead refresh token. If a row suddenly says "re-add",
  wait before concluding the credential is broken.
- macOS only: Claude management depends on `security(1)` and the `claude` CLI;
  Codex reporting depends on the `codex` CLI.

## The one change worth making next

`claude auth login` overwrites the single default credential — that is what cost
us `silverblock`, and what makes every added account a small race.

`CLAUDE_CONFIG_DIR` gives each profile its **own** Keychain slot (verified: with
a distinct config dir, `claude auth status` reports `loggedIn: false` while the
default profile is logged in; the Keychain shows a second entry named
`Claude Code-credentials-<hash>`).

So `cuw login <id>` should create `~/.config/cuw/profiles/<id>/`, run
`CLAUDE_CONFIG_DIR=<that dir> claude auth login`, and read the account email back
from `claude auth status`. All four logins would then coexist permanently, the
default login would never be disturbed, and each account could be
re-authenticated independently. Details in
`docs/superpowers/notes/2026-08-03-handoff.md`.
