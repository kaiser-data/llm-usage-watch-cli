# llm-usage-watch-cli (`cuw`)

See usage across several Claude subscriptions, the active Codex account, the
active Cursor login, and the active Grok login in one command. For Claude,
`cuw` can also start the five-hour window on an idle subscription.

> For subscriptions **you own**. This tool reports usage and can open a Claude
> rate-limit window on your own accounts; it does not pool, share, or route work
> between them. See [Scope](#scope).

The five-hour window only begins at an account's *first* message, so an untouched
subscription is not ready to go — switching to it means waiting. `cuw prime`
starts that clock for a few tokens, so a fresh window is always available when
the one you're on runs dry.

## Install

    bun install
    bun run install-cli     # builds dist/cuw and links it into ~/.local/bin

Re-run `bun run install-cli` after pulling changes to update the installed binary.

## Set up each Claude subscription

### Automatic (recommended)

`cuw` imports whatever the terminal is logged into. Every `cuw` run — and
`cuw sync`, meant for a Claude Code `SessionStart` hook — reads the live Claude
Code login, identifies it, and stores it under the matching account (adding a
new one, named from the email, when none matches). When Claude Code renews its
token, the next run picks the new one up. When `cuw` itself refreshes a token it
shares with the live login, it writes the rotated token back, so neither side
signs the other out. So: log into a subscription once with `claude auth login`,
start a session, and it is tracked.

Hook (in `~/.claude/settings.json` → `hooks.SessionStart`):

    {"hooks":[{"type":"command","async":true,"timeout":30,
      "command":"$HOME/.local/bin/cuw sync --quiet >/dev/null 2>&1 || true"}]}

### Manual, without switching the terminal's login


    cuw login work          # opens the browser; sign in with that subscription

Repeat per subscription. `cuw login` runs `claude auth login` in a throwaway
profile, so the terminal's own Claude Code login is never touched. It pre-fills
the account's email, refuses a sign-in that landed on a different subscription
(the usual mistake when the browser is still signed into another claude.ai
account), and deletes the temporary login once the credential is stored.

When tokens expire — typically after not using `cuw` for a while — one command
signs back in every account that needs it, one browser round-trip each:

    cuw login

Each account gets its own OAuth grant, held only by `cuw`. A credential copied
out of the live login (`cuw add <id>`, still available) shares its refresh
token with Claude Code, which rotates it and leaves `cuw`'s copy dead.

Credentials live in the macOS Keychain under the service `cuw-token`.
`~/.config/cuw/accounts.json` holds no secrets.

## Codex usage

Install the Codex CLI and log in once:

    codex login

`cuw` reads the account-wide limits of that active Codex account. No Codex app,
CLI conversation, or agent session needs to be running. `cuw` starts a
short-lived local app-server for the read and never accesses Codex tokens,
emails, conversations, or session files directly.

## Cursor usage

Sign into Cursor on this machine once. `cuw` reads the active session from
Cursor's local state database and asks Cursor's dashboard API for the current
period meter. It never copies Cursor tokens into the `cuw` Keychain and never
writes refreshed tokens back into Cursor's storage.

## Grok usage (grokmeter)

Sign into the Grok CLI once (`grok login`). `cuw` reads the active session from
`~/.grok/auth.json` and asks Grok's billing endpoint for the monthly credit
meter. It never copies Grok tokens into the `cuw` Keychain and never writes
refreshed tokens back into Grok's auth file.

## Use

    cuw                     # Claude, Codex, Cursor, and Grok usage
    cuw status --json       # { "claude": [...], "codex": {...}, "cursor": {...}, "grok": {...} }
    cuw login               # sign every expired account back in
    cuw use                 # switch the login to the recommended account
    cuw use work            # switch the login to a named account
    cuw prime work          # start the five-hour window on one account
    cuw prime --cold        # start it on every idle account
    cuw doctor              # diagnose tokens and data paths
    cuw rm work             # forget an account and delete its token

```
ACCOUNT    PLAN  5H WINDOW        RESETS  WEEKLY         RESETS   RENEWS  STATE
──────────────────────────────────────────────────────────────────────────────
main       pro    12%  ▓░░░░░░░░   3h41m    34%  ▓▓▓░░░░░░      2d      ~9d  ● warm
secondary pro     0%  ░░░░░░░░░       —    18%  ▓▓░░░░░░░      4d     ~18d  ○ cold

→ use: secondary  (cold — run `cuw prime secondary` to start its clock)

CODEX  active  PLAN plus
LIMIT  WINDOW         USED             RESETS
──────────────────────────────────────────────
codex  primary 7d      73%  ▓▓▓▓▓▓▓░░      4d

CURSOR  active  PLAN pro
LIMIT       USED             RESETS
──────────────────────────────────
plan         46%  ▓▓▓▓░░░░░     12d
auto          0%  ░░░░░░░░░     12d
api          46%  ▓▓▓▓░░░░░     12d

GROK  active  PLAN pro
LIMIT       USED             RESETS
──────────────────────────────────
monthly       1%  ░░░░░░░░░     24d
```

`--json` intentionally uses the combined object shape shown above rather than
the former top-level Claude array.

Exit codes: `0` success, `1` bad arguments, `2` a Claude account needs
attention. Codex, Cursor, and Grok errors are shown in their own sections but do
not hide Claude results or change the exit code.

## How it reads usage

For Claude, the primary path is `GET /api/oauth/usage` — the same endpoint the
Claude Code CLI itself calls for `/usage`. It is exact, free, and returns in
well under a second for all accounts in parallel.

If that endpoint changes shape, each affected account falls back to sending one
minimal request and reading the `anthropic-ratelimit-*` response headers. Rows
served that way are marked `(probe)`, because a probe also opens a window.
`cuw doctor` tells you which path each account is using.

A throttled read is the one failure that does *not* fall back. The usage
endpoint rate-limits reads independently of account budget, and does so
transiently, so `cuw` retries it and then reports `usage reads are being
throttled` rather than spending real quota on a probe to answer a question the
API is about to answer for free.

A window `cuw` could not read is shown as `—`, never as `0%`. The two are not
the same, and a spent account that reads as empty is the most dangerous thing
this tool can print — it is exactly the row the recommender would send you to.

For Codex, `cuw` starts `codex app-server`, performs its JSONL initialization
handshake, reads `account/rateLimits/read`, and terminates the child. The Codex
path makes no inference request and does not depend on an existing Codex session.

For Cursor, `cuw` opens the local `state.vscdb` read-only, refreshes the access
token in memory when needed, and calls Cursor's dashboard
`GetCurrentPeriodUsage` RPC.

For Grok, `cuw` reads `~/.grok/auth.json` read-only, refreshes the OIDC access
token in memory when needed, and calls
`GET https://cli-chat-proxy.grok.com/v1/billing` (plus
`/user?include=subscription` for the plan label). Claude, Codex, Cursor, and
Grok are collected concurrently.

## Switching accounts

`cuw use` rewrites the Claude Code login in the Keychain. New `claude` sessions
and the desktop app pick up the new account; sessions already running keep the
one they started with. Without an id it switches to the account the status
footer recommends.

That Keychain item also holds the OAuth tokens of every connected MCP server, so
the switch merges into it rather than replacing it — your MCP connections
survive. If the login about to be replaced is not one `cuw` tracks, it is stored
as a new account first, so you can always switch back.

Accounts added before this feature existed were stored without the full login
blob, and without the account identity a switch needs to recognise them. `cuw
use` refuses those, because restoring one would drop its plan metadata. Migrate
each one once by signing it back in:

    cuw login work

Re-signing keeps the account's `order` and `label` — its row stays where you put
it — and replaces only the credential and identity. It writes nothing unless the
new login parses and its profile can be read, so a failed sign-in leaves the
existing account exactly as it was.

## Priming cost

One `hi` to Haiku with `--safe-mode`, no tools, no memory, no plugins, no session
file — tens of tokens. It runs in an isolated `CLAUDE_CONFIG_DIR` and an empty
working directory, so it never touches your logged-in session or picks up a
project's `CLAUDE.md`. The token is passed by environment, never in argv.

`prime` never reports success without re-reading usage to confirm a window
actually opened.

## Scope

`cuw` reports Claude, Codex, and Cursor usage and primes Claude subscriptions.
It does not pool accounts, share credentials, or route work between
subscriptions — you decide where to work. It is for subscriptions you own.

macOS only for Claude Keychain management: Claude account management depends on
`security(1)` and the `claude` CLI; Codex reporting depends on the `codex` CLI
and its active login; Cursor reporting depends on a local Cursor install and
login.

## How it works

[`docs/HOW-IT-WORKS.md`](docs/HOW-IT-WORKS.md) covers the auth model (why
`setup-token` does not work and login credentials do), where the numbers come
from, how an account is chosen, and the invariants not to break.

[`docs/CODEX-USAGE.md`](docs/CODEX-USAGE.md) documents the Codex account
requirement, output formats, app-server read, security boundaries, and
troubleshooting.

[`docs/CURSOR-USAGE.md`](docs/CURSOR-USAGE.md) documents the Cursor login
requirement, meter rows, dashboard read, security boundaries, and
troubleshooting.

## Development

    bun test
    bun test --coverage
    bunx tsc --noEmit
    bun run build

Design and plan documents are under `docs/superpowers/`.

## License

MIT — see [LICENSE](LICENSE).
