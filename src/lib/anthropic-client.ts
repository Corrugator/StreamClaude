import { getFreshCredentials, refreshAccessToken, OAuthError } from './oauth.js';

export type UsageSnapshot = {
  sessionPct: number;        // 0..100
  weeklyPct: number;         // 0..100
  sessionResetAt: Date | null;
  weeklyResetAt: Date | null;
  fetchedAt: Date;
};

export class AnthropicError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'AnthropicError';
    this.status = status;
  }
}

const API_URL = 'https://api.anthropic.com/v1/messages';

/**
 * Probe-model candidates, tried in order. The probe only needs a model that
 * *exists* (the rate-limit headers we care about are produced regardless of
 * the actual completion). The list cascades from current → older haiku
 * versions so the plugin keeps working when Anthropic deprecates a model.
 * The first model that doesn't return a model-not-found error is cached.
 */
const PROBE_MODELS = [
  'claude-haiku-4-5',
  'claude-haiku-4-0',
  'claude-3-5-haiku-latest',
];
let activeModelIdx = 0;

/**
 * Fire a minimal /v1/messages request and parse rate-limit headers
 * to derive Claude Code session and weekly usage percentages.
 *
 * The request itself is throwaway (max_tokens=1) — the value lives
 * in the response headers, mirroring how Clawdmeter works.
 *
 * Token handling: we refresh proactively when the keychain token is at or
 * past its expiry (with leeway), and reactively on a 401. The reactive
 * path matters because Claude Code may rotate the token from under us.
 */
export async function fetchUsage(): Promise<UsageSnapshot> {
  let creds;
  try {
    creds = await getFreshCredentials();
  } catch (e) {
    if (e instanceof OAuthError) {
      throw new AnthropicError(`oauth refresh failed: ${e.message}`, e.status);
    }
    throw e;
  }

  // Track the token actually in use so the model-fallback path below probes
  // with the refreshed token, not the stale snapshot from before a 401.
  let token = creds.accessToken;
  let res = await doProbeRequest(token);

  // Reactive refresh: token may have been invalidated server-side even
  // before its stored expiry (e.g. rotated by another Claude Code process).
  if (res.status === 401) {
    try {
      const refreshed = await refreshAccessToken(creds);
      token = refreshed.accessToken;
      res = await doProbeRequest(token);
    } catch (e) {
      if (e instanceof OAuthError) {
        throw new AnthropicError(`unauthorized; refresh also failed: ${e.message}`, 401);
      }
      throw e;
    }
    if (res.status === 401) {
      throw new AnthropicError('unauthorized after refresh (re-login required)', 401);
    }
  }

  // Model-not-found: walk the fallback list until something sticks. We only
  // act on this when the response is *also* missing rate-limit headers —
  // Anthropic usually returns those even on 4xx, in which case the current
  // model is fine and the 4xx is unrelated.
  if (
    (res.status === 404 || res.status === 400) &&
    res.headers.get('anthropic-ratelimit-unified-5h-utilization') === null &&
    res.headers.get('anthropic-ratelimit-unified-7d-utilization') === null
  ) {
    const startIdx = activeModelIdx;
    while (activeModelIdx + 1 < PROBE_MODELS.length) {
      activeModelIdx++;
      res = await doProbeRequest(token);
      if (res.status !== 404 && res.status !== 400) break;
    }
    if (
      res.headers.get('anthropic-ratelimit-unified-5h-utilization') === null &&
      res.headers.get('anthropic-ratelimit-unified-7d-utilization') === null
    ) {
      // The walk didn't reach a model that returns usage headers — the 4xx
      // was likely transient/unrelated, so don't pin a fallback model for
      // the rest of the process lifetime.
      activeModelIdx = startIdx;
    }
  }

  const sessionPctRaw = res.headers.get('anthropic-ratelimit-unified-5h-utilization');
  const weeklyPctRaw = res.headers.get('anthropic-ratelimit-unified-7d-utilization');
  const sessionResetRaw = res.headers.get('anthropic-ratelimit-unified-5h-reset');
  const weeklyResetRaw = res.headers.get('anthropic-ratelimit-unified-7d-reset');

  if (sessionPctRaw === null && weeklyPctRaw === null) {
    throw new AnthropicError(
      `no rate-limit headers in response (status=${res.status})`,
      res.status
    );
  }

  return {
    sessionPct: parsePct(sessionPctRaw),
    weeklyPct: parsePct(weeklyPctRaw),
    sessionResetAt: parseResetTimestamp(sessionResetRaw),
    weeklyResetAt: parseResetTimestamp(weeklyResetRaw),
    fetchedAt: new Date(),
  };
}

async function doProbeRequest(accessToken: string): Promise<Response> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
    },
    body: JSON.stringify({
      model: PROBE_MODELS[activeModelIdx],
      max_tokens: 1,
      messages: [{ role: 'user', content: '.' }],
    }),
  });
  // Drain the body so the socket can be reused — we only care about headers.
  await res.text().catch(() => undefined);
  return res;
}

function parsePct(raw: string | null): number {
  if (raw === null) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  // Header is documented as a fraction 0..1, but some endpoints return 0..100.
  return n > 1 ? clamp(n, 0, 100) : clamp(n * 100, 0, 100);
}

function parseResetTimestamp(raw: string | null): Date | null {
  if (!raw) return null;
  // Anthropic returns ISO-8601 (e.g. "2026-05-17T20:00:00Z").
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    // Fallback: unix seconds.
    const n = Number(raw);
    if (Number.isFinite(n)) return new Date(n * 1000);
    return null;
  }
  return d;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
