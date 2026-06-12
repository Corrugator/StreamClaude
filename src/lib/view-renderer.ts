import type { UsageSnapshot } from './anthropic-client.js';

export type ViewId = 0 | 1;
export const VIEWS: ReadonlyArray<ViewId> = [0, 1];
export const VIEW_NAME: Record<ViewId, string> = {
  0: 'Combined',
  1: 'Reset',
};

// ── Colors ────────────────────────────────────────────────────────────────────

const COLOR_OK    = '#4ADE80';
const COLOR_WARN  = '#FACC15';
const COLOR_HOT   = '#F87171';
const COLOR_MUTED = '#9CA3AF';
const COLOR_ERROR = '#6B7280';

function colorForPct(pct: number): string {
  if (pct >= 85) return COLOR_HOT;
  if (pct >= 60) return COLOR_WARN;
  return COLOR_OK;
}

// ── Format helpers ────────────────────────────────────────────────────────────

function fmtCountdown(target: Date | null, now: Date): string {
  if (!target) return '—';
  const ms = target.getTime() - now.getTime();
  if (ms <= 0) return 'now';
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 1) return `${h}h ${m.toString().padStart(2, '0')}m`;
  return `${m}m`;
}

function fmtResetsIn(target: Date | null, now: Date): string {
  if (!target) return '—';
  const ms = target.getTime() - now.getTime();
  if (ms <= 0) return 'Resetting…';
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const d = Math.floor(h / 24);
  const hRem = h % 24;
  if (d >= 1) return `Resets in ${d}d ${hRem}h`;
  if (h >= 1) return `Resets in ${h}h ${m.toString().padStart(2, '0')}m`;
  return `Resets in ${m}m`;
}

function fmtUpdatedAgo(fetchedAt: Date, now: Date, polling: boolean): string {
  if (polling) return '✳ Polling…';
  const sec = Math.round((now.getTime() - fetchedAt.getTime()) / 1000);
  if (sec < 5)  return '✳ Just updated';
  if (sec < 60) return `✳ ${sec}s ago`;
  return `✳ ${Math.floor(sec / 60)}m ago`;
}

// ── DerivedView (encoder LCD only, via setFeedback) ───────────────────────────

type DerivedView = {
  label: string;
  big: string;
  sub: string;
  pct: number | null;
  color: string;
};

/**
 * Classify an error message so the UI can show actionable text instead of a
 * vague "auth or net". We only inspect the message string — instanceof checks
 * would couple the renderer to the network layer.
 */
type ErrorKind = 'auth' | 'network' | 'api' | 'unknown';
function classifyError(error: Error): ErrorKind {
  const m = error.message.toLowerCase();
  // 'keychain' covers KeychainError (entry missing/unreadable) — signing in
  // via `claude` recreates the entry, so the auth UI is the actionable path.
  if (m.includes('unauthorized') || m.includes('invalid_grant') ||
      m.includes('401') || m.includes('oauth') || m.includes('re-login') ||
      m.includes('keychain')) {
    return 'auth';
  }
  if (m.includes('econnrefused') || m.includes('enotfound') ||
      m.includes('etimedout') || m.includes('fetch failed') ||
      m.includes('network')) {
    return 'network';
  }
  // \b5\d\d\b → 5xx status codes only, not any message containing a "5".
  if (m.includes('no rate-limit headers') || m.includes('429') || /\b5\d\d\b/.test(m)) {
    return 'api';
  }
  return 'unknown';
}

/** Short, user-facing error labels for the encoder LCD (must fit ~12 chars). */
function errorSummary(error: Error): { big: string; sub: string; color: string } {
  switch (classifyError(error)) {
    case 'auth':    return { big: 'Sign in',  sub: 'Run: claude',     color: COLOR_HOT  };
    case 'network': return { big: 'Offline',  sub: 'No connection',   color: COLOR_WARN };
    case 'api':     return { big: 'API err',  sub: 'Anthropic down?', color: COLOR_WARN };
    default:        return { big: '!',        sub: 'check logs',      color: COLOR_ERROR };
  }
}

export function deriveView(
  view: ViewId,
  snap: UsageSnapshot | undefined,
  error: Error | undefined,
  now: Date = new Date()
): DerivedView {
  if (!snap) {
    if (error) {
      const e = errorSummary(error);
      return { label: VIEW_NAME[view], big: e.big, sub: e.sub, pct: null, color: e.color };
    }
    return {
      label: VIEW_NAME[view],
      big: '…',
      sub: 'loading',
      pct: null,
      color: COLOR_ERROR,
    };
  }
  switch (view) {
    case 0:
      return {
        label: 'Session',
        big: `${Math.round(snap.sessionPct)}%`,
        sub: `${fmtCountdown(snap.sessionResetAt, now)} left`,
        pct: snap.sessionPct,
        color: colorForPct(snap.sessionPct),
      };
    case 1: {
      const candidates: Array<[string, Date | null]> = [
        ['session', snap.sessionResetAt],
        ['week',    snap.weeklyResetAt],
      ];
      const valid = candidates
        .filter((c): c is [string, Date] => c[1] !== null)
        .sort((a, b) => a[1].getTime() - b[1].getTime());
      if (valid.length === 0) {
        return { label: 'Reset', big: '—', sub: 'no data', pct: null, color: COLOR_MUTED };
      }
      const [name, when] = valid[0];
      const pct = name === 'session' ? snap.sessionPct : snap.weeklyPct;
      return {
        label: 'Reset',
        big: fmtCountdown(when, now),
        sub: `${name} · ${Math.round(pct)}%`,
        pct,
        color: colorForPct(pct),
      };
    }
  }
}

// ── Keypad SVG (144×144) ──────────────────────────────────────────────────────

const FONT = '-apple-system, Helvetica, sans-serif';

// No inline header icon: a 14×14 glyph is too small to be readable and would
// duplicate the "Usage" label sitting next to it. The button face stays
// header-text-only, which also keeps the rendering trademark-neutral.
const ICON_SVG = '';

function barW(pct: number, maxW = 126): string {
  return Math.max(0, Math.min(maxW, (maxW * pct) / 100)).toFixed(1);
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function svgToUri(svg: string): string {
  return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf-8').toString('base64');
}

/**
 * One metric card (57px tall) at the given cardY offset.
 *
 * Layout within the card:
 *   big %   — left, baseline at cardY+30
 *   badge   — right pill, y=cardY+3..17, text at cardY+13
 *   bar     — full width, y=cardY+37..43
 *   sub     — reset text, baseline at cardY+53
 */
function metricCard(
  cardY: number,
  pct: number,
  color: string,
  label: string,
  resetText: string
): string {
  const bigY      = cardY + 30;
  const badgeT    = cardY + 3;
  const badgeTxtY = cardY + 13;
  const barY      = cardY + 37;
  const subY      = cardY + 53;
  const bw        = barW(pct);
  return `
  <rect x="3" y="${cardY}" width="138" height="57" rx="6" fill="#1C1C1C"/>
  <text x="9" y="${bigY}" font-family="${FONT}" font-size="27" font-weight="800" fill="${color}">${Math.round(pct)}%</text>
  <rect x="91" y="${badgeT}" width="50" height="14" rx="7" fill="#2D2D2D"/>
  <text x="116" y="${badgeTxtY}" text-anchor="middle" font-family="${FONT}" font-size="9" fill="#999">${escapeXml(label)}</text>
  <rect x="9" y="${barY}" width="126" height="6" rx="2" fill="#222"/>
  ${Number(bw) > 0 ? `<rect x="9" y="${barY}" width="${bw}" height="6" rx="2" fill="${color}"/>` : ''}
  <text x="9" y="${subY}" font-family="${FONT}" font-size="10" fill="#666">${escapeXml(resetText)}</text>`;
}

function renderCombinedSvg(
  snap: UsageSnapshot | undefined,
  error: Error | undefined,
  polling: boolean,
  now: Date
): string {
  const commonHeader = `
  <rect width="144" height="144" fill="#111"/>
  ${ICON_SVG}
  <text x="72" y="13" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" fill="#777">Usage</text>`;

  if (!snap) {
    if (error) {
      const e = errorSummary(error);
      return svgToUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">${commonHeader}
  <text x="72" y="78" text-anchor="middle" font-family="${FONT}" font-size="22" font-weight="800" fill="${e.color}">${escapeXml(e.big)}</text>
  <text x="72" y="108" text-anchor="middle" font-family="${FONT}" font-size="13" font-weight="600" fill="#E5E7EB">${escapeXml(e.sub)}</text>
  <text x="72" y="138" text-anchor="middle" font-family="${FONT}" font-size="9" fill="#9CA3AF">in Terminal</text>
</svg>`);
    }
    return svgToUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">${commonHeader}
  <text x="72" y="88" text-anchor="middle" font-family="${FONT}" font-size="36" font-weight="800" fill="${COLOR_ERROR}">…</text>
  <text x="72" y="140" text-anchor="middle" font-family="${FONT}" font-size="9" fill="#9CA3AF">✳ Loading…</text>
</svg>`);
  }

  const footer = fmtUpdatedAgo(snap.fetchedAt, now, polling);
  const card1  = metricCard(16, snap.sessionPct, colorForPct(snap.sessionPct), 'Current', fmtResetsIn(snap.sessionResetAt, now));
  const card2  = metricCard(77, snap.weeklyPct,  colorForPct(snap.weeklyPct),  'Weekly',  fmtResetsIn(snap.weeklyResetAt,  now));

  return svgToUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">${commonHeader}${card1}${card2}
  <text x="72" y="143" text-anchor="middle" font-family="${FONT}" font-size="9" fill="#CC4400">${escapeXml(footer)}</text>
</svg>`);
}

function renderResetSvg(
  snap: UsageSnapshot | undefined,
  error: Error | undefined,
  now: Date
): string {
  if (!snap) {
    if (error) {
      const e = errorSummary(error);
      return svgToUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
  <rect width="144" height="144" fill="#111"/>
  <text x="72" y="32" text-anchor="middle" font-family="${FONT}" font-size="14" font-weight="600" fill="#666">Next Reset</text>
  <text x="72" y="78" text-anchor="middle" font-family="${FONT}" font-size="22" font-weight="800" fill="${e.color}">${escapeXml(e.big)}</text>
  <text x="72" y="108" text-anchor="middle" font-family="${FONT}" font-size="13" font-weight="600" fill="#E5E7EB">${escapeXml(e.sub)}</text>
  <text x="72" y="138" text-anchor="middle" font-family="${FONT}" font-size="9" fill="#9CA3AF">in Terminal</text>
</svg>`);
    }
    return svgToUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
  <rect width="144" height="144" fill="#111"/>
  <text x="72" y="32" text-anchor="middle" font-family="${FONT}" font-size="14" font-weight="600" fill="#666">Next Reset</text>
  <text x="72" y="88" text-anchor="middle" font-family="${FONT}" font-size="36" font-weight="800" fill="${COLOR_ERROR}">…</text>
  <text x="72" y="128" text-anchor="middle" font-family="${FONT}" font-size="12" fill="#9CA3AF">loading</text>
</svg>`);
  }

  type Entry = { name: string; when: Date; pct: number };
  const candidates = [
    { name: 'session', when: snap.sessionResetAt, pct: snap.sessionPct },
    { name: 'week',    when: snap.weeklyResetAt,  pct: snap.weeklyPct  },
  ].filter((c): c is Entry => c.when !== null)
   .sort((a, b) => a.when.getTime() - b.when.getTime());

  if (candidates.length === 0) {
    return svgToUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
  <rect width="144" height="144" fill="#111"/>
  <text x="72" y="32" text-anchor="middle" font-family="${FONT}" font-size="14" font-weight="600" fill="#666">Next Reset</text>
  <text x="72" y="88" text-anchor="middle" font-family="${FONT}" font-size="36" font-weight="800" fill="${COLOR_MUTED}">—</text>
</svg>`);
  }

  const { name, when, pct } = candidates[0];
  const color    = colorForPct(pct);
  const countdown = fmtCountdown(when, now);
  const barFill  = Math.min(116, (116 * pct) / 100).toFixed(1);

  return svgToUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
  <rect width="144" height="144" fill="#111"/>
  <text x="72" y="32" text-anchor="middle" font-family="${FONT}" font-size="14" font-weight="600" fill="#777">Next Reset</text>
  <text x="72" y="86" text-anchor="middle" font-family="${FONT}" font-size="38" font-weight="800" fill="${color}">${escapeXml(countdown)}</text>
  <rect x="14" y="97" width="116" height="8" rx="3" fill="#222"/>
  ${Number(barFill) > 0 ? `<rect x="14" y="97" width="${barFill}" height="8" rx="3" fill="${color}"/>` : ''}
  <text x="72" y="126" text-anchor="middle" font-family="${FONT}" font-size="13" fill="#888">${escapeXml(name)} · ${Math.round(pct)}%</text>
</svg>`);
}

export function renderKeypadImage(
  snap: UsageSnapshot | undefined,
  error: Error | undefined,
  view: ViewId,
  polling: boolean,
  now: Date = new Date()
): string {
  return view === 1
    ? renderResetSvg(snap, error, now)
    : renderCombinedSvg(snap, error, polling, now);
}

// ── Encoder LCD feedback (setFeedback payload) ────────────────────────────────

export type EncoderFeedback = {
  viewLabel: { value: string; color: string };
  bigValue:  { value: string; color: string };
  bar:       { value: number };
  subLabel:  { value: string; color: string };
};

export function renderEncoderFeedback(v: DerivedView): EncoderFeedback {
  return {
    viewLabel: { value: v.label, color: '#A0A0A0' },
    bigValue:  { value: v.big,   color: v.color   },
    bar:       { value: Math.round(v.pct ?? 0) },
    subLabel:  { value: v.sub,   color: '#C8C8C8' },
  };
}
