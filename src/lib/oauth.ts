import { readClaudeCredentials, writeClaudeCredentials, KeychainError } from './keychain.js';
import type { ClaudeCredentials } from './keychain.js';

/**
 * Claude Code's public OAuth client id. Extracted from the official binary;
 * the same value is hard-coded in every Claude Code installation.
 */
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

/**
 * Endpoint the Claude Code CLI itself uses to exchange a refresh token
 * for a new access token. Discovered by inspecting the bundled binary;
 * see also: `strings <claude-binary> | grep oauth/token`.
 *
 * Note: this is **platform.claude.com**, not **console.anthropic.com**.
 * The latter responded 429 on a previous build of Claude Code and is the
 * wrong host going forward.
 */
const REFRESH_URL = 'https://platform.claude.com/v1/oauth/token';

/** Refresh proactively when fewer than this many ms remain before expiry. */
const REFRESH_LEEWAY_MS = 60_000;

export class OAuthError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'OAuthError';
    this.status = status;
  }
}

type RefreshResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;       // seconds
  token_type?: string;
  scope?: string;
};

/** Single in-flight refresh so concurrent callers share one network round-trip. */
let inflight: Promise<ClaudeCredentials> | undefined;

/**
 * Refresh the access token in the keychain using the stored refresh token.
 * Writes the new tokens back to the keychain (preserving extra fields)
 * and returns the updated credentials.
 */
export function refreshAccessToken(current?: ClaudeCredentials): Promise<ClaudeCredentials> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const creds = current ?? readClaudeCredentials();
      if (!creds.refreshToken) {
        throw new OAuthError('no refresh token in keychain — re-login with `claude` required');
      }

      const res = await fetch(REFRESH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: creds.refreshToken,
          client_id: CLIENT_ID,
        }),
      });

      const bodyText = await res.text().catch(() => '');
      if (!res.ok) {
        // 400/401 here usually means our refresh_token was invalidated.
        // The most common benign cause is a concurrent refresh from the
        // Claude Code CLI: it rotated the tokens (writing fresh ones into
        // the keychain) and our copy is now stale. Re-read the keychain;
        // if someone else's refresh has landed since we started, use their
        // freshly minted access token instead of throwing.
        if (res.status === 400 || res.status === 401) {
          try {
            const reread = readClaudeCredentials();
            if (
              reread.accessToken !== creds.accessToken &&
              reread.expiresAt !== undefined &&
              reread.expiresAt > Date.now()
            ) {
              return reread;
            }
          } catch {
            // Re-read failed; fall through to the original error path.
          }
        }
        throw new OAuthError(
          `refresh failed (${res.status}): ${truncate(bodyText, 200)}`,
          res.status
        );
      }

      let parsed: RefreshResponse;
      try {
        parsed = JSON.parse(bodyText) as RefreshResponse;
      } catch (e) {
        throw new OAuthError(`refresh response not JSON: ${(e as Error).message}`);
      }

      if (!parsed.access_token) {
        throw new OAuthError(`refresh response missing access_token: ${truncate(bodyText, 200)}`);
      }

      // Re-read the keychain immediately before write so we pick up any
      // fields (scopes, subscriptionType, …) that the Claude Code CLI may
      // have updated between our initial read and now. Without this, our
      // stale `extra` snapshot would silently clobber those changes.
      let baseline: ClaudeCredentials;
      try {
        baseline = readClaudeCredentials();
      } catch {
        // Re-read failed (extremely unlikely): fall back to the snapshot we
        // started with so we still persist the rotated tokens.
        baseline = creds;
      }

      const updated: ClaudeCredentials = {
        ...baseline,
        accessToken: parsed.access_token,
        // Some OAuth servers rotate the refresh token, some don't. Keep the
        // new one when present, otherwise reuse what's currently in the
        // keychain (which may itself have been rotated by another process).
        // `||` (not `??`) so a buggy server returning an empty string doesn't
        // wipe out our existing refresh token.
        refreshToken: parsed.refresh_token || baseline.refreshToken,
        // Floor expires_in at 60 s: a misconfigured/buggy server returning
        // 0 or negative would otherwise cause us to refresh on every poll.
        expiresAt:
          typeof parsed.expires_in === 'number'
            ? Date.now() + Math.max(parsed.expires_in, 60) * 1000
            : baseline.expiresAt,
      };

      try {
        writeClaudeCredentials(updated);
      } catch (e) {
        // Keychain write failed (rare): still return the fresh in-memory
        // creds so this poll succeeds. Persistence is retried on the next
        // refresh; if the server rotated the refresh token, the stored one
        // may now be stale and the next refresh surfaces a real auth error.
        if (!(e instanceof KeychainError)) throw e;
      }

      return updated;
    } finally {
      inflight = undefined;
    }
  })();
  return inflight;
}

/**
 * Return credentials whose access token is not expired (or about to expire).
 * Refreshes via the OAuth endpoint when needed; otherwise returns the
 * currently stored credentials unchanged.
 */
export async function getFreshCredentials(): Promise<ClaudeCredentials> {
  const creds = readClaudeCredentials();
  if (creds.expiresAt !== undefined && creds.expiresAt - REFRESH_LEEWAY_MS <= Date.now()) {
    return refreshAccessToken(creds);
  }
  return creds;
}

/**
 * Redact known credential patterns and cap length. Anthropic OAuth tokens
 * start with `sk-ant-oat01-` (access) or `sk-ant-ort01-` (refresh); the API
 * usually doesn't echo them in error bodies, but if a future server bug
 * ever does, this keeps them out of plugin log files on disk.
 */
function truncate(s: string, n: number): string {
  const redacted = s.replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-***REDACTED***');
  return redacted.length > n ? redacted.slice(0, n) + '…' : redacted;
}
