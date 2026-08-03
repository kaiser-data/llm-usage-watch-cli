# llm-usage-watch-cli (`cuw`)

See five-hour and weekly usage across several Claude subscriptions without
logging in and out, and start the five-hour window on an idle one.

> For subscriptions **you own**. This tool reports usage and opens a rate-limit
> window on your own accounts; it does not pool, share, or route work between
> them. See [Scope](#scope).

The five-hour window only begins at an account's *first* message, so an untouched
subscription is not ready to go — switching to it means waiting. `cuw prime`
starts that clock for a few tokens, so a fresh window is always available when
the one you're on runs dry.

## Install

    bun install
    bun run build
    ln -sf "$PWD/dist/cuw" /usr/local/bin/cuw

## Set up each subscription

Log into a subscription in another terminal, mint a long-lived token, and hand it
to `cuw`:

    claude setup-token      # in a terminal logged into that account
    cuw add work            # paste the token when prompted

Repeat per subscription. Tokens live in the macOS Keychain under the service
`cuw-token` and are read from stdin, never from argv, so they stay out of your
shell history. `~/.config/cuw/accounts.json` holds no secrets.

## Use

    cuw                     # the table
    cuw status --json       # machine-readable
    cuw prime work          # start the five-hour window on one account
    cuw prime --cold        # start it on every idle account
    cuw doctor              # diagnose tokens and data paths
    cuw rm work             # forget an account and delete its token

```
ACCOUNT      5H WINDOW      RESETS   WEEKLY   STATE
────────────────────────────────────────────────────
main          12%  ▓░░░░░░░░   3h41m     34%   ● warm
secondary      0%  ░░░░░░░░░      —      18%   ○ cold
third         88%  ▓▓▓▓▓▓▓▓░     47m     71%   ▲ hot

→ use: secondary  (cold — run `cuw prime secondary` to start its clock)
```

Exit codes: `0` success, `1` bad arguments, `2` an account needs attention.

## How it reads usage

Primary path is `GET /api/oauth/usage` — the same endpoint the Claude Code CLI
itself calls for `/usage`. It is exact, free, and returns in well under a second
for all accounts in parallel.

If that endpoint changes shape, each affected account falls back to sending one
minimal request and reading the `anthropic-ratelimit-*` response headers. Rows
served that way are marked `(probe)`, because a probe also opens a window.
`cuw doctor` tells you which path each account is using.

## Priming cost

One `hi` to Haiku with `--safe-mode`, no tools, no memory, no plugins, no session
file — tens of tokens. It runs in an isolated `CLAUDE_CONFIG_DIR` and an empty
working directory, so it never touches your logged-in session or picks up a
project's `CLAUDE.md`. The token is passed by environment, never in argv.

`prime` never reports success without re-reading usage to confirm a window
actually opened.

## Scope

`cuw` reports and primes. It does not pool accounts, share credentials, or route
work between subscriptions — you decide where to work. It is for subscriptions
you own.

macOS only: it depends on `security(1)` and the `claude` CLI.

## Development

    bun test              # 117 tests
    bun test --coverage   # ~98% lines
    bun run build

Design and plan documents are under `docs/superpowers/`.

## License

MIT — see [LICENSE](LICENSE).
