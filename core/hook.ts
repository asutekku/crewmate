/** Shared process boundary for presence hook entry points. */

/**
 * Runs one hook without allowing a coordination failure to block Claude Code.
 *
 * Hook implementations still own payload validation and event behavior. This wrapper
 * owns the invariant process policy: report programmer/runtime errors, then fail open.
 */
export async function runHook(file: string, hook: () => Promise<void>): Promise<void> {
  try {
    await hook();
  } catch (err) {
    console.error(`[presence] ${file} failed:`, err);
  }
}
