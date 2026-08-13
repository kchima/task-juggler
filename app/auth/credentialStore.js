/**
 * Credential store — macOS Keychain via the `security` CLI.
 * No native module dependencies; uses the system keychain which is
 * always available on macOS and encrypted at rest.
 *
 * Each credential is stored as a generic password item with:
 *   - Account: 'task-juggler'
 *   - Service: provider-specific identifier (e.g. 'todoist-oauth')
 *   - Password: JSON-serialized credential object
 */

import { execSync } from 'child_process';

const KEYCHAIN_ACCOUNT = 'task-juggler';

/**
 * Store a credential in the macOS Keychain.
 * Overwrites an existing item for the same service.
 */
export function storeCredential(service, data) {
  const json = JSON.stringify(data);
  // Use -U to update if exists, -w for the password data
  execSync(
    `security add-generic-password -a '${escapeShellArg(KEYCHAIN_ACCOUNT)}' -s '${escapeShellArg(service)}' -w '${escapeShellArg(json)}' -U 2>/dev/null`,
    { stdio: 'pipe', timeout: 5000, encoding: 'utf-8' }
  );
}

/**
 * Read a credential from the macOS Keychain.
 * Returns null if no item exists for the given service.
 */
export function getCredential(service) {
  try {
    const output = execSync(
      `security find-generic-password -a '${escapeShellArg(KEYCHAIN_ACCOUNT)}' -s '${escapeShellArg(service)}' -w 2>/dev/null`,
      { stdio: 'pipe', timeout: 5000, encoding: 'utf-8' }
    );
    const trimmed = output.trim();
    if (!trimmed) return null;
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Delete a credential from the macOS Keychain.
 * Silently succeeds if no item exists.
 */
export function deleteCredential(service) {
  try {
    execSync(
      `security delete-generic-password -a '${escapeShellArg(KEYCHAIN_ACCOUNT)}' -s '${escapeShellArg(service)}' 2>/dev/null`,
      { stdio: 'pipe', timeout: 5000, encoding: 'utf-8' }
    );
  } catch {
    // Item already deleted or never existed
  }
}

/**
 * List all service names stored under the task-juggler account.
 */
export function listCredentials() {
  try {
    const output = execSync(
      `security dump-keychain -a '${escapeShellArg(KEYCHAIN_ACCOUNT)}' 2>/dev/null | grep '"svce"' | awk -F'"' '{print $4}'`,
      { stdio: 'pipe', timeout: 5000, encoding: 'utf-8' }
    );
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Escape a string for use in a single-quoted shell argument.
 * Single quotes are replaced with end-quote, escaped literal quote, re-open-quote.
 */
function escapeShellArg(str) {
  if (!str) return '';
  // Replace ' with '"'"' (end single-quote, double-quote an apostrophe, re-open single-quote)
  return str.replace(/'/g, "'\"'\"'");
}