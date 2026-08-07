/**
 * Remediation shown for an account that is already in the registry.
 *
 * A bare `cuw add <id>` is refused as a duplicate, so any hint aimed at a
 * configured account must carry `--force` or it dead-ends the user: the message
 * tells them to run a command that cannot succeed. Every such message routes
 * through here so the two cannot drift apart again.
 */
export function reAddHint(id: string): string {
  return `cuw add --force ${id}`
}

/** The same remediation when the specific id is not known at the call site. */
export const RE_ADD_HINT = 'cuw add --force <id>'
