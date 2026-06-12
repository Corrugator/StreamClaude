import { spawnSync } from 'child_process';
import { chmodSync } from 'fs';
import { userInfo } from 'os';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const KEYCHAIN_SERVICE = 'Claude Code-credentials';

// Path to the bundled Swift helper that performs Keychain reads/writes
// via the Security framework. Resolved relative to the compiled plugin.js
// inside the .sdPlugin bundle.
const HELPER_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'keychain-helper'
);

// `@elgato/cli pack` (and many ZIP unpackers) strip Unix mode bits, so the
// helper arrives on the user's machine without the executable bit set and
// `spawnSync` would fail with EACCES. Restore +x once per process startup;
// chmod is idempotent and cheap.
let helperReady = false;
function ensureHelperExecutable(): void {
  if (helperReady) return;
  try {
    chmodSync(HELPER_PATH, 0o755);
  } catch {
    // If chmod fails (e.g. file owned by another user) we still attempt the
    // spawn — the resulting error message will be more diagnostic than ours.
  }
  helperReady = true;
}

export type ClaudeCredentials = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  /** Any other fields present in the JSON blob (scopes, subscriptionType, …). Preserved on write. */
  extra?: Record<string, unknown>;
};

export class KeychainError extends Error {
  readonly stderr?: string;
  constructor(message: string, stderr?: string) {
    super(message);
    this.name = 'KeychainError';
    this.stderr = stderr;
  }
}

/**
 * Read the Claude Code OAuth credentials from the macOS keychain.
 *
 * Goes through the bundled Swift helper rather than `/usr/bin/security` so
 * the user's "Always Allow" decision actually sticks: Claude Code writes the
 * keychain item with a strict partition list that excludes `apple-tool:`, so
 * every `security` invocation re-prompts even after Always Allow. The helper
 * has its own ad-hoc code signature and is identified independently by the
 * keychain ACL — one prompt, then it's permanent.
 *
 * The lookup is pinned to (service, current-user-account) so a stray second
 * entry with the same service name but a different account (e.g. left over
 * from an OS migration or shared iCloud keychain) can't be silently read
 * while writes go to a different slot.
 */
export function readClaudeCredentials(): ClaudeCredentials {
  ensureHelperExecutable();
  const account = userInfo().username;
  const result = spawnSync(
    HELPER_PATH,
    ['read', KEYCHAIN_SERVICE, account],
    { encoding: 'utf-8', timeout: 10_000 }
  );

  // We intentionally do NOT fall back to `/usr/bin/security` on errSecItemNotFound
  // (helper exit code 4). That fallback used to trigger a keychain prompt every
  // time the Claude Code CLI rotated its token via delete+add, even though our
  // helper has a permanent ACL entry. Letting the read fail surfaces the
  // existing "Sign in / Run: claude" UI; the next 60 s poll recovers the moment
  // the new entry appears.

  if (result.error) {
    throw new KeychainError(`keychain-helper read failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new KeychainError(
      `keychain entry "${KEYCHAIN_SERVICE}" not readable (exit ${result.status})`,
      result.stderr?.toString()
    );
  }

  const raw = result.stdout.trim();
  if (!raw) {
    throw new KeychainError('keychain returned empty value');
  }

  // The entry may be either a JSON blob (newer Claude Code versions)
  // or a bare token string. Handle both.
  if (raw.startsWith('{')) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new KeychainError(`keychain value is not valid JSON: ${(e as Error).message}`);
    }
    const claudeAi = (parsed.claudeAiOauth ?? parsed) as Record<string, unknown>;
    const accessToken =
      (claudeAi.accessToken as string | undefined) ??
      (claudeAi.access_token as string | undefined);
    if (!accessToken) {
      throw new KeychainError('keychain JSON has no accessToken field');
    }
    // Preserve any unknown fields (scopes, subscriptionType, rateLimitTier, …)
    // so a round-trip write keeps the entry intact for Claude Code itself.
    const known = new Set([
      'accessToken', 'access_token',
      'refreshToken', 'refresh_token',
      'expiresAt', 'expires_at',
    ]);
    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(claudeAi)) {
      if (!known.has(k)) extra[k] = v;
    }
    return {
      accessToken,
      refreshToken:
        (claudeAi.refreshToken as string | undefined) ??
        (claudeAi.refresh_token as string | undefined),
      expiresAt:
        (claudeAi.expiresAt as number | undefined) ??
        (claudeAi.expires_at as number | undefined),
      extra,
    };
  }

  return { accessToken: raw };
}

/**
 * Persist updated Claude Code credentials back into the macOS keychain,
 * preserving the original JSON shape so the Claude Code CLI keeps working.
 *
 * Delegates to a bundled Swift helper that reads the secret from stdin and
 * uses the Security framework directly (SecItemUpdate / SecItemAdd). The
 * naive alternative — `/usr/bin/security add-generic-password -w <BLOB>` —
 * would place the secret in argv, where every other process running as the
 * same user could read it via `ps`. The helper avoids that exposure entirely
 * because stdin is private to the parent–child pipe.
 *
 * The account name defaults to the current macOS user, matching how Claude
 * Code creates the entry on first login.
 */
export function writeClaudeCredentials(creds: ClaudeCredentials): void {
  ensureHelperExecutable();
  const blob = JSON.stringify({
    claudeAiOauth: {
      accessToken: creds.accessToken,
      ...(creds.refreshToken !== undefined ? { refreshToken: creds.refreshToken } : {}),
      ...(creds.expiresAt !== undefined ? { expiresAt: creds.expiresAt } : {}),
      ...(creds.extra ?? {}),
    },
  });

  const account = userInfo().username;
  const result = spawnSync(
    HELPER_PATH,
    ['write', KEYCHAIN_SERVICE, account],
    {
      input: blob,                  // secret goes via stdin, NOT argv
      encoding: 'utf-8',
      timeout: 10_000,
    }
  );

  if (result.error) {
    throw new KeychainError(`keychain-helper spawn failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new KeychainError(
      `keychain-helper exited ${result.status}`,
      result.stderr?.toString()
    );
  }
}
