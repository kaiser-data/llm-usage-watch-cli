# Account Switching Design

**Date:** 2026-08-04

## Goal

Add `cuw use [<id>]`, which repoints the machine's Claude Code login at one of
the tracked subscriptions. Without an argument it switches to the account
`recommend()` already names in the `→ use:` footer of `cuw status`; with an
argument it switches to that account.

The switch is global: it rewrites the `Claude Code-credentials` Keychain item,
so every subsequently started `claude` session and the desktop app use the new
account. Sessions already running keep the credential they started with.

Out of scope: any automatic trigger. There is no watcher, no daemon, and no
session hook. The automation is in *choosing* the account, not in deciding when
to switch. A `SessionStart` hook calling `cuw use` remains possible for the user
to configure, but ships as neither code nor default.

## The constraint that shapes the design

The `Claude Code-credentials` Keychain item is not just the login. Observed
structure on 2026-08-04:

```
mcpOAuth.<server>.accessToken        MCP server OAuth tokens (notion, supabase, …)
mcpOAuth.<server>.discoveryState.*
claudeAiOauth.accessToken
claudeAiOauth.refreshToken
claudeAiOauth.expiresAt
claudeAiOauth.refreshTokenExpiresAt
claudeAiOauth.scopes
claudeAiOauth.subscriptionType
claudeAiOauth.rateLimitTier
```

Two facts follow, and both are load-bearing.

**The write must merge, not replace.** Writing `{claudeAiOauth: …}` over this
item would destroy every MCP server authorization stored beside it. The switch
must read the live item, replace only the `claudeAiOauth` branch, and write back
every other top-level key untouched.

**The stored credential must be lossless.** `Credential` currently models four
fields; the live branch carries seven, and Anthropic may add more. A switch that
reconstructs `claudeAiOauth` from the typed subset silently drops
`subscriptionType`, `rateLimitTier`, and `refreshTokenExpiresAt`. The credential
therefore carries the whole branch verbatim as a passthrough.

The item's attributes are `svce="Claude Code-credentials"`, `acct="marty"`. The
existing `readLoginCredential` reads by service alone; the write needs the
account attribute too.

## Architecture

### `login.ts` (new)

Owns the live login item, and nothing else. Three pieces:

- `readLoginBlob()` — returns the item's full parsed JSON object, all top-level
  keys, or `null` when no login exists.
- `mergeLogin(liveBlob, credential)` — **pure**. Returns a new object equal to
  `liveBlob` with `claudeAiOauth` replaced by the credential's passthrough. This
  is the function that preserves `mcpOAuth`, so it is the function that carries
  the switch's central test.
- `writeLoginBlob(blob)` — serializes and writes with `-s <service> -a <acct> -U`.
  The account attribute is read from the existing item rather than assumed, so a
  machine whose login was created under another user name still works.

Keeping the merge pure and separate from the two Keychain calls is what makes
the destructive path testable without touching a real Keychain.

### `credentials.ts`

`Credential` gains `raw: Record<string, unknown>` — the `claudeAiOauth` branch
verbatim. The typed fields stay, because every existing caller reasons about
them; `raw` exists solely so a switch can restore the branch byte-faithfully.

`parseCredential` populates `raw` from the wrapped form (`claudeAiOauth`) and
from cuw's own stored form (a persisted `raw` key). `serializeCredential`
persists it.

`refreshCredential` must project the refreshed values back into `raw`
(`accessToken`, `expiresAt`, and a rotated `refreshToken`). Without this the
passthrough goes stale on the first refresh and a later switch would install an
expired access token while reporting success.

`isLegacyCredential(credential)` reports a stored credential that predates the
passthrough. Such a credential cannot be restored losslessly.

### `profile.ts`

`/api/oauth/profile` returns `account.uuid` and `account.email`. Both are
extracted into a new `Identity` type, and `normalizeProfile` returns
`{subscription, identity}`. `fetchSubscription` remains as a thin wrapper so the
status path is unchanged.

This is what lets the switch name the account it is replacing, and what makes
the untracked-login safety net possible.

### `registry.ts`

`Account` gains optional `uuid`. `runAdd` records `uuid` and fills `email`,
which the current implementation deliberately leaves empty because the usage
endpoint exposes no email — the profile endpoint does.

### `commands/use.ts` (new)

Orchestration only; dependencies injected as in `add.ts` and `prime.ts`.

1. Collect usage for all accounts, reusing `collectUsage`, so the choice sees
   current figures. Only usage is needed here — identities come from the
   registry, so neither `collectUsage` nor `AccountUsage` changes.
2. Resolve the target: the `<id>` argument, else `recommend(rows).useId`. Abort
   when no account is usable.
3. Load the target credential. If it is legacy, abort with a re-add instruction
   and write nothing.
4. Read the live blob. Abort when absent.
5. Identify the active account: fetch the profile for the live access token and
   match `account.uuid` against the `uuid` recorded in the registry. On no
   match, capture the login as a new account keyed on the email's local part —
   suffixed `-2`, `-3`, … if that id is taken — then continue.

   Capture is suppressed while any configured account still lacks a `uuid`. A
   registry mid-migration cannot distinguish "this login is untracked" from
   "this login is a tracked account whose uuid was never recorded", and guessing
   wrong duplicates an account. In that state the command aborts and names the
   accounts still to be re-added.
6. If target equals active, report and exit 0 without writing.
7. `writeLoginBlob(mergeLogin(liveBlob, targetCredential))`.
8. Report `switched: <from> → <to>` plus the target's binding-constraint line.

## Error handling

Every failure path aborts before the write. The switch is the only destructive
operation in the tool, so it never runs on partial information.

| Condition | Behavior | Exit |
|---|---|---|
| Target stored in legacy format | Abort, instruct `claude auth login` + `cuw add <id>` | 2 |
| No login item present | Abort, instruct `claude auth login` | 2 |
| Profile fetch for live credential fails | Abort — do **not** guess | 2 |
| Active login untracked, but some account lacks a `uuid` | Abort, name the accounts still to re-add | 2 |
| No usable account (all spent/unreachable) | Abort, report the earliest reset | 2 |
| Target already active | Report, no write | 0 |
| Keychain write fails | Report that nothing changed | 1 |

The profile-failure row is deliberate. Capturing the outgoing login is the
safety net for the destructive write, and it depends on identifying that login.
Losing the identification means losing the net, so the write does not proceed.

No message ever contains a token, and no error surfaces a raw response body or
`security` stderr — both can echo credential material.

## Security note

`security add-generic-password -w <blob>` passes the value as an argv element,
briefly visible to same-user processes. `keychain.set` already documents and
accepts this tradeoff for a single-user Mac. The switch widens it: the blob it
writes contains the MCP server tokens as well as the login. This warrants an
explicit comment at the call site, not a silent reuse of the existing rationale.

## Testing

Existing style: pure functions tested directly, side effects behind injected
dependencies.

- `mergeLogin` preserves `mcpOAuth` and unknown top-level keys, and replaces
  only `claudeAiOauth`. This is the test that matters most; it is the difference
  between a switch and a data-loss bug.
- `parseCredential` captures `raw` verbatim from both the wrapped and the stored
  form; a serialize/parse round-trip loses nothing.
- `refreshCredential` updates `raw` in step with the typed fields.
- `isLegacyCredential` distinguishes stored formats.
- `normalizeProfile` extracts `uuid` and `email`.
- `runUse`: selects the recommendation when given no id; refuses a legacy
  credential without writing; no-ops when the target is already active; captures
  an untracked login before switching; suppresses capture while a `uuid` is
  missing; propagates a write failure.
- Integration: stub Keychain runner and stub server, asserting the exact blob
  written.

## Migration

The three configured accounts were captured before the passthrough existed.
`cuw use` refuses them with an actionable message; each needs one
`claude auth login` followed by `cuw add <id>`. No automatic migration is
possible — cuw never sees a full login blob again after `add`.

## Documentation

`cuw --help`, `README.md`, and `docs/HOW-IT-WORKS.md` gain the command, the
merge behavior, and the migration note.
