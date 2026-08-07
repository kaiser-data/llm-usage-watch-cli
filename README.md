# llm-usage-watch-cli (`cuw`)

See usage across several Claude subscriptions and the active Codex account in
one command. For Claude, `cuw` can also start the five-hour window on an idle
subscription.

> For subscriptions **you own**. This tool reports usage and can open a Claude
> rate-limit window on your own accounts; it does not pool, share, or route work
> between them. See [Scope](#scope).

The five-hour window only begins at an account's *first* message, so an untouched
subscription is not ready to go — switching to it means waiting. `cuw prime`
starts that clock for a few tokens, so a fresh window is always available when
the one you're on runs dry.

## Install

    bun install
    bun run build
    ln -sf "$PWD/dist/cuw" /usr/local/bin/cuw

## Set up each Claude subscription

Log into a subscription in another terminal, then let `cuw` copy that login
credential into its own Keychain entry:

    claude auth login       # in a terminal logged into that account
    cuw add work            # captures the current login

Repeat per subscription. Credentials live in the macOS Keychain under the
service `cuw-token`. `~/.config/cuw/accounts.json` holds no secrets.

## Codex usage

Install the Codex CLI and log in once:

    codex login

`cuw` reads the account-wide limits of that active Codex account. No Codex app,
CLI conversation, or agent session needs to be running. `cuw` starts a
short-lived local app-server for the read and never accesses Codex tokens,
emails, conversations, or session files directly.

## Use

    cuw                     # Claude table plus active Codex usage
    cuw status --json       # { "claude": [...], "codex": {...} }
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
```

`--json` intentionally uses the combined object shape shown above rather than
the former top-level Claude array.

Exit codes: `0` success, `1` bad arguments, `2` a Claude account needs
attention. Codex errors are shown in their own section but do not hide Claude
results or change the exit code.

## How it reads usage

For Claude, the primary path is `GET /api/oauth/usage` — the same endpoint the
Claude Code CLI itself calls for `/usage`. It is exact, free, and returns in
well under a second for all accounts in parallel.

If that endpoint changes shape, each affected account falls back to sending one
minimal request and reading the `anthropic-ratelimit-*` response headers. Rows
served that way are marked `(probe)`, because a probe also opens a window.
`cuw doctor` tells you which path each account is using.

For Codex, `cuw` starts `codex app-server`, performs its JSONL initialization
handshake, reads `account/rateLimits/read`, and terminates the child. Claude and
Codex are collected concurrently. The Codex path makes no inference request and
does not depend on an existing Codex session.

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
each one once, by logging into it and re-recording it in place:

    claude auth login        # for that subscription
    cuw add --force work

`--force` keeps the account's `order` and `label` — its row stays where you put
it — and replaces only the credential and identity. It writes nothing unless the
new login parses and its profile can be read, so a failed migration leaves the
existing account exactly as it was.

## Priming cost

One `hi` to Haiku with `--safe-mode`, no tools, no memory, no plugins, no session
file — tens of tokens. It runs in an isolated `CLAUDE_CONFIG_DIR` and an empty
working directory, so it never touches your logged-in session or picks up a
project's `CLAUDE.md`. The token is passed by environment, never in argv.

`prime` never reports success without re-reading usage to confirm a window
actually opened.

## Scope

`cuw` reports Claude and Codex usage and primes Claude subscriptions. It does not
pool accounts, share credentials, or route work between subscriptions — you
decide where to work. It is for subscriptions you own.

macOS only: Claude account management depends on `security(1)` and the `claude`
CLI; Codex reporting depends on the `codex` CLI and its active login.

## How it works

[`docs/HOW-IT-WORKS.md`](docs/HOW-IT-WORKS.md) covers the auth model (why
`setup-token` does not work and login credentials do), where the numbers come
from, how an account is chosen, and the invariants not to break.

[`docs/CODEX-USAGE.md`](docs/CODEX-USAGE.md) documents the Codex account
requirement, output formats, app-server read, security boundaries, and
troubleshooting.

## Development

    bun test
    bun test --coverage
    bunx tsc --noEmit
    bun run build

Design and plan documents are under `docs/superpowers/`.

## License

MIT — see [LICENSE](LICENSE).
