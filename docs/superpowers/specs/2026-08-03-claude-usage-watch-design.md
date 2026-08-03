# claude-usage-watch (`cuw`) — Design

**Date:** 2026-08-03
**Status:** Approved for planning
**Author:** project maintainer

## Problem

Four separate Claude subscriptions are in use. Today, checking how much of each
one is consumed requires logging out of Claude Code and back in as another
account — slow, error-prone, and it destroys the working session. Worse, the
five-hour usage window on an account only starts at its *first* message, so an
untouched subscription is not "ready to go": switching to it means waiting for a
window to open rather than finding one already ticking.

Two needs follow:

1. **See** the usage of all four subscriptions at once, without switching logins.
2. **Start the clock** on an idle subscription with a negligible request, so
   windows are staggered and a fresh account is always available.

## Goals

- One command shows the 5-hour and weekly usage of every configured subscription.
- One command starts the 5-hour window on a chosen (or every idle) subscription,
  costing far less than 0.1% of that subscription's budget.
- Neither operation disturbs the currently logged-in Claude Code session.
- The tool tells the user which subscription to use right now.

## Non-goals

- No account sharing, pooling, or credential handoff between people. Every token
  belongs to the operator's own subscription.
- No proxying or transparent routing of real work between accounts. The tool
  reports and primes; the human decides where to work.
- No historical trend storage or dashboards in v1. (`--json` output keeps that
  door open.)
- No support for API-key billing, Bedrock, or Vertex. Subscription accounts only.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Authenticate with one long-lived token per account, minted by `claude setup-token` and stored in the macOS Keychain | `claude auth` has no profile support; swapping the live credential blob would mutate the active login. Tokens give read + prime access to all four accounts concurrently, with no login churn. |
| D2 | One-shot CLI table as the primary interface | The check happens dozens of times a day; a terminal command is the lowest-friction surface and pipes into scripts and statuslines. |
| D3 | Hybrid data source: usage API first, per-account fallback to a header probe | The API path is exact, instant, and free. The probe path uses only ordinary client behaviour, so the tool degrades instead of going dark if the endpoint changes. |
| D4 | Priming is manual (`prime <id>`) plus an explicit sweep (`prime --cold`); no background scheduler | Keeps every outbound request user-initiated and auditable. The sweep provides the convenience without a daemon. |
| D5 | Bun + TypeScript, zero runtime dependencies, compiled to a single binary | Bun 1.3.13 is already installed. ~10ms startup matters for a reflexively-run command; native `fetch` and `Bun.spawn` cover all I/O; `bun test` covers the suite. |

## Constraints and boundaries

- The tool stays inside normal Claude Code client behaviour: the operator's own
  tokens, real Claude Code sessions for priming, no spoofed identity.
- Tokens are never written to disk by `cuw`, never printed, and are redacted from
  every log line and error message.
- `--bare` cannot be used for priming: it explicitly refuses OAuth and keychain
  auth, accepting only `ANTHROPIC_API_KEY` / `apiKeyHelper`. Isolation is achieved
  with `--safe-mode` plus explicit stripping flags instead.

## Architecture

Three layers, each independently testable:

```
  cli.ts ──► commands/*.ts
                 │
                 ├─► credential layer   keychain.ts, registry.ts
                 ├─► usage layer        usage.ts ─► usage-api.ts
                 │                               └─► usage-probe.ts
                 └─► presentation layer classify.ts, render.ts   (pure)
```

**Credential layer.** `registry.ts` owns `~/.config/cuw/accounts.json`, which
holds no secrets — only `{id, label, email, order}` per account, so it is safe to
back up or commit. `keychain.ts` wraps `security add-generic-password` /
`find-generic-password` / `delete-generic-password` against service `cuw-token`,
with the account `id` as the item account. It exposes `get`, `set`, `remove` and
guarantees no secret value reaches stdout, stderr, or an exception message.

**Usage layer.** `usage.ts` orchestrates: for each account, attempt
`usage-api.ts`; on transport failure or schema mismatch, fall back to
`usage-probe.ts` for *that account only*. Both paths return the same normalized
record, so nothing downstream knows or cares which path served a row.

**Presentation layer.** `classify.ts` and `render.ts` are pure functions with no
I/O — records in, decisions and strings out. This is where the majority of test
coverage lives.

### Normalized record

The stable internal contract, independent of which path produced it:

```ts
type AccountUsage = {
  id: string
  label: string
  fiveHourPct: number | null       // null = no active window (cold)
  fiveHourResetsAt: Date | null
  weeklyPct: number | null
  weeklyResetsAt: Date | null
  opusWeeklyPct: number | null     // null when the plan has no separate Opus limit
  source: 'api' | 'probe'
  error: UsageError | null
}
```

## Commands

| Command | Behaviour |
|---|---|
| `cuw` / `cuw status` | Render the status table. Default command. |
| `cuw status --json` | Emit `AccountUsage[]` as JSON for scripts and statuslines. |
| `cuw add <id>` | Print the `claude setup-token` instructions, read the token from stdin (never as an argv argument, which would land in shell history), verify it against the usage path, store it in the Keychain, and append the account to the registry. |
| `cuw rm <id>` | Remove the registry entry and the Keychain item. Prompts for confirmation. |
| `cuw prime <id>` | Start the five-hour window on one account. |
| `cuw prime --cold` | Start the window on every account currently classified `cold`. |
| `cuw doctor` | Per account: token present, token valid, which data path served it, and the remediation for anything broken. |

## Data flow: `cuw status`

1. Load the registry. If absent or empty, print the first-run message pointing at
   `cuw add` and exit 0.
2. Read all tokens from the Keychain concurrently.
3. Issue all usage requests concurrently, each with an independent timeout.
4. Normalize each result into an `AccountUsage`, attaching an error rather than
   throwing when a row fails.
5. Classify each row and compute the recommendation.
6. Render.

A slow or failing account never blocks or invalidates the others; its row
displays the failure while every other row remains correct.

### Classification

Named constants, no magic numbers:

- `cold` — no active five-hour window.
- `warm` — window active, under `HOT_THRESHOLD_PCT` (70).
- `hot` — at or above `HOT_THRESHOLD_PCT`, below 100.
- `spent` — at the limit.
- `unknown` — the row carries an error; excluded from recommendation.

### Recommendation

Pick the account with the greatest remaining five-hour headroom, tiebroken by
greatest remaining weekly headroom, excluding `spent` and `unknown` rows. If any
`cold` account exists, additionally emit a nudge to prime it now, so a window is
already open when the current account runs dry. This nudge is the part that
addresses the original complaint: never wait five hours for a window to start.

If every account is `spent` or `unknown`, say so explicitly and print the
earliest reset time across all rows.

### Output

```
$ cuw

ACCOUNT      5H WINDOW      RESETS   WEEKLY   STATE
────────────────────────────────────────────────────
main          12%  ▓░░░░░░░░   3h41m     34%   ● warm
secondary      0%  ░░░░░░░░░      —      18%   ○ cold
third         88%  ▓▓▓▓▓▓▓▓░     47m     71%   ▲ hot
fourth        41%  ▓▓▓▓░░░░░   2h05m     52%   ● warm

→ use: secondary  (cold — run `cuw prime secondary` to start its clock)
```

Colour is applied only when stdout is a TTY. `render.ts` stays pure: TTY-ness and
terminal width are passed in as explicit options by the `status` command, never
read from the environment inside the renderer. Rows served by the probe path are
marked so the source is never ambiguous.

## Data flow: `cuw prime`

For each target account, spawn a real Claude Code session:

- Environment: `CLAUDE_CODE_OAUTH_TOKEN=<token>`, and `CLAUDE_CONFIG_DIR` pointed
  at an isolated directory under `~/.config/cuw/profiles/<id>` so the operator's
  own config, session history, and login state are untouched.
- Working directory: an empty scratch directory, so no `CLAUDE.md` is discovered.
- Flags: `-p "hi" --model haiku --tools "" --safe-mode --no-session-persistence`.

`--safe-mode` disables plugins, hooks, MCP servers, skills, and custom commands;
`--tools ""` removes the tool definitions from the request; the empty working
directory and isolated config dir remove project and user memory. What remains is
a minimal prompt against the cheapest model — on the order of tens of tokens,
comfortably under 0.1% of a five-hour budget.

After the spawn exits, re-read that account's usage to confirm a window is now
active, and print its reset time. If the window did not open, report the spawn's
exit code and stderr tail rather than claiming success.

`prime --cold` runs the same operation concurrently across every `cold` account
and prints one confirmation line per account.

## Error handling

| Condition | Behaviour |
|---|---|
| Registry missing or empty | First-run message pointing at `cuw add`; exit 0 |
| Keychain item missing for a listed account | Row reads `not configured` with the `cuw add <id>` remediation; other rows unaffected |
| Token expired or revoked (HTTP 401/403) | Row reads `auth ✗` with re-mint instructions; process exit code 2 |
| Network failure or timeout | Row shows `—` and the reason; other rows unaffected |
| Malformed or unrecognized API response | That account silently retries via the probe path; `doctor` reports the downgrade |
| Both paths fail for an account | Row classified `unknown`, excluded from the recommendation, error shown |
| `prime` spawn fails | Report exit code and stderr tail; never report a window as started without confirming it |

No error path prints or logs a token. Errors carry structured causes so `doctor`
can render remediation without re-deriving it from message strings.

## File layout

Small, single-purpose modules per the project's coding rules:

```
src/
  cli.ts             argument parsing and command dispatch
  registry.ts        accounts.json read/write and validation
  keychain.ts        `security` wrapper; secret-safe by construction
  usage-api.ts       usage endpoint client + response validation
  usage-probe.ts     fallback path: minimal request, rate-limit header parse
  usage.ts           per-account orchestration and fallback policy
  classify.ts        state classification + recommendation  (pure)
  render.ts          table, bars, colour, durations             (pure)
  prime.ts           isolated Claude Code invocation
  constants.ts       thresholds, timeouts, service names
  commands/
    status.ts  add.ts  rm.ts  prime.ts  doctor.ts
tests/
  (mirrors src/, plus fixtures/ and one integration test)
```

## Testing

Test-first, targeting 80%+ coverage.

- **Pure units** (`classify`, `render`, response normalization) carry the heaviest
  coverage, driven by fixtures: every state, ties in the recommendation, all-spent,
  all-unknown, single account, mixed `api`/`probe` sources, missing Opus limit.
- **Keychain and process spawning** sit behind narrow interfaces, so command logic
  is exercised against fakes with no Keychain writes and no network.
- **Integration**: one test runs the compiled binary against a stub HTTP server
  covering the healthy path, a 401, and a malformed response that forces fallback.
- **Never** tested against live accounts in CI; the recorded fixture from the spike
  below is the reference for the real response shape.

## Implementation order

The first step is a spike, because one input is genuinely unknown.

**Step 0 — Endpoint spike.** The exact path and response shape of the usage
endpoint that Claude Code's `/usage` consumes is undocumented and has not been
confirmed. With the operator's explicit permission, read the currently
logged-in account's token from the Keychain and probe it. Two outcomes, both
defined:

- *Reachable* — freeze the real response as `tests/fixtures/usage-api.json`,
  implement `usage-api.ts` against it, and the design proceeds unchanged.
- *Not reachable* — `usage-probe.ts` becomes the primary path and `usage-api.ts`
  is dropped from v1. Every other section of this design stands as written,
  because the normalized record insulates them; `status` simply becomes a few
  seconds slower and each check also primes the window it measures, which is
  called out in the output.

The spike is complete when `tests/fixtures/` contains a real recorded response
from whichever path won.

Subsequent steps, each test-first: registry and keychain → usage layer against
fixtures → classify → render → `status` → `add` / `rm` → `prime` → `doctor` →
`bun build --compile` and PATH installation.

## Success criteria

- `cuw` shows accurate five-hour and weekly usage for all four subscriptions in
  under one second, without touching the active login.
- `cuw prime <id>` opens a five-hour window on a chosen subscription at a cost
  under 0.1% of that subscription's budget, confirmed by the follow-up read.
- `cuw prime --cold` leaves every subscription with an open, staggered window.
- A broken or unreachable account degrades to one bad row, never a failed command.
- No token ever appears on disk, on screen, or in a log.
