/**
 * Remediation shown for an account that is already in the registry.
 *
 * `cuw login <id>` signs the account in through its own browser flow, so the
 * fix works without first logging the terminal into that subscription. Every
 * such message routes through here so the wording cannot drift apart.
 */
export function reAddHint(id: string): string {
  return `cuw login ${id}`
}

/** The same remediation when the specific id is not known at the call site. */
export const RE_ADD_HINT = 'cuw login <id>'
