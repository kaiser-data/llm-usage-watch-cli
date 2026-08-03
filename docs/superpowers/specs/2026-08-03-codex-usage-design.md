# Codex Usage Design

**Date:** 2026-08-03

## Goal

Extend `cuw status` so it reports the account-wide usage limits of the currently
logged-in Codex account alongside the existing Claude subscription overview.
The read must work without a running Codex CLI, app, or conversation session.

This first version supports exactly one Codex account: whichever account the
locally installed Codex CLI is currently logged into. It does not add Codex
account registration, credential storage, account switching, priming, or
recommendations.

## Chosen integration

`cuw` starts a short-lived `codex app-server` child process and communicates
with it over its standard-input/standard-output JSONL protocol. It sends:

1. `initialize` with `cuw` client metadata
2. the `initialized` notification
3. `account/rateLimits/read`

It then normalizes the response and terminates the process. This is independent
of any existing Codex conversation session: the child process reads the active
account's account-wide quota through Codex's own authentication lifecycle.

This uses the documented, stable account API rather than reading Codex auth
files, copying tokens, calling an internal HTTP endpoint, or inferring quota
from local session logs. The relevant protocol fields are:

- `rateLimitsByLimitId`, with `rateLimits` as the backward-compatible fallback
- `limitId` and optional `limitName`
- `planType`
- `primary` and optional `secondary` windows
- `usedPercent`, `windowDurationMins`, and `resetsAt` for each window

Reference: <https://developers.openai.com/codex/app-server/>

## Architecture

### Codex protocol client

A new focused module owns the child-process protocol. Its public operation
returns a normalized, Codex-specific status value and does not expose raw
JSON-RPC messages or authentication details.

The module must:

- spawn `codex app-server` without a shell;
- write newline-delimited JSON messages;
- tolerate unrelated notifications while waiting for matching response IDs;
- validate the response before returning it;
- impose a short timeout;
- terminate the child after success, protocol failure, timeout, or caller error;
- discard or safely summarize stderr without leaking account information.

The child process receives the normal user environment so Codex can locate the
active login. `cuw` does not read or persist Codex tokens, email addresses,
conversation data, or session files.

### Normalized data

Codex limits remain separate from Claude's `UsageWindows`. Codex can return
multiple named buckets and arbitrary window durations, so forcing those values
into Claude's five-hour/weekly shape would discard information and couple the
providers incorrectly.

The normalized shape is fixed at the boundary:

```ts
type CodexUsage = {
  provider: 'codex'
  plan: string | null
  limits: Array<{
    id: string
    name: string | null
    windows: Array<{
      role: 'primary' | 'secondary'
      usedPct: number
      durationMinutes: number | null
      resetsAt: Date | null
    }>
  }>
  error: { cause: CodexErrorCause; message: string } | null
}
```

`plan` is the first non-null plan reported by a returned bucket. A successful
response has `error: null`; a failed read has no limits and carries a safe error
value. A bucket without a server-provided identifier receives the stable
fallback identifier `codex`.

Percentages and timestamps are validated and converted at the boundary.
Unknown additional response fields are ignored.

### Status orchestration

`runStatus` starts Claude collection and Codex collection concurrently. A
failure on either side never prevents the other side from rendering. Claude
classification, account recommendation, priming, add/remove, and doctor logic
remain unchanged.

The normal empty-Claude-registry message remains useful, but it does not prevent
Codex status from being shown.

## Output

### Terminal

The existing Claude table and recommendation render first. A separate `CODEX`
section follows with:

- account label (`active`);
- plan;
- one row per returned limit window;
- a usage percentage and bar;
- window duration when supplied;
- reset countdown when supplied.

Separate sections preserve the meaning of Claude's fixed five-hour and weekly
columns while allowing Codex to expose whatever buckets the service returns.
No Codex recommendation or state classification is added in this version.

If Codex is unavailable, the section contains one concise actionable message,
such as Codex not being installed, no ChatGPT login being active, a protocol
failure, or a timeout. Raw stderr and raw server responses are never rendered.

### JSON

`cuw status --json` changes from a top-level Claude array to:

```json
{
  "claude": [],
  "codex": {
    "provider": "codex",
    "plan": "plus",
    "limits": [],
    "error": null
  }
}
```

This is an intentional breaking change. Dates continue to serialize as ISO
strings through `JSON.stringify`. The JSON contains normalized status only;
tokens, raw protocol messages, stderr, and email addresses are excluded.

## Error and exit-code behavior

Codex failures are display-level failures and do not change the command's exit
code. Existing Claude authentication behavior remains authoritative:

- `0`: status rendered and no Claude account requires authentication;
- `2`: at least one Claude account has a missing or rejected credential;
- `1`: invalid command-line usage, unchanged.

This preserves existing automation semantics and prevents an optional provider
from making Claude monitoring unavailable.

Codex errors are classified into a small safe set:

- executable missing;
- not logged in or unsupported API-key-only authentication;
- timeout;
- protocol/schema failure;
- child-process failure.

## Testing

The process boundary is dependency-injected so tests use a fake child process
and never require a real Codex login or network request.

Coverage includes:

- initialize/initialized/rate-limit request sequencing;
- ignoring unrelated notifications and matching response IDs;
- normalization of the multi-bucket response;
- fallback to the single `rateLimits` bucket;
- primary and secondary windows with nullable duration/reset fields;
- malformed responses and safe error messages;
- missing executable, nonzero child exit, and timeout cleanup;
- Codex terminal rendering with one and multiple windows;
- the unavailable-Codex message;
- the new combined JSON envelope;
- status output when no Claude accounts are registered;
- unchanged Claude recommendation and exit-code behavior.

Verification runs `bun test`, `bunx tsc --noEmit`, and `bun run build`.

## Documentation and scope

`README.md` and `docs/HOW-IT-WORKS.md` will describe the combined status,
active-account behavior, absence of a running-session requirement, the Codex
CLI/login prerequisite, and the JSON shape change.

Out of scope for this version:

- multiple Codex accounts;
- login or logout commands;
- credential copying or direct token access;
- token-activity history from `account/usage/read`;
- reset-credit redemption;
- account selection or cross-provider recommendations;
- changes to Claude priming or doctor behavior.
