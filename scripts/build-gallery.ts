/**
 * Build the three 1920×960 gallery images required by the Elgato Marketplace.
 *
 * Pulls the actual button-face SVGs out of view-renderer.ts so the screenshots
 * are pixel-accurate to what users will see on their decks, then composes each
 * one into a marketing canvas with headline + body text.
 *
 * Run via `npm run build:gallery`. Renders to marketplace/gallery-N.png via sips.
 */

import { renderKeypadImage } from '../src/lib/view-renderer.ts';
import type { UsageSnapshot } from '../src/lib/anthropic-client.ts';
import { writeFileSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'marketplace');
mkdirSync(outDir, { recursive: true });

// Fixed "now" so the rendered countdown labels are stable across builds.
const NOW = new Date('2026-05-22T08:00:00Z');

function snap(sessionPct: number, weeklyPct: number, sessionResetIn: number, weeklyResetIn: number): UsageSnapshot {
  return {
    sessionPct,
    weeklyPct,
    sessionResetAt: new Date(NOW.getTime() + sessionResetIn * 60_000),
    weeklyResetAt:  new Date(NOW.getTime() + weeklyResetIn  * 60_000),
    fetchedAt: NOW,
  };
}

function buttonFaceSvg(snap: UsageSnapshot, view: 0 | 1): string {
  // renderKeypadImage returns a data: URI; pull the raw SVG out.
  const uri = renderKeypadImage(snap, undefined, view, false, NOW);
  const b64 = uri.replace(/^data:image\/svg\+xml;base64,/, '');
  return Buffer.from(b64, 'base64').toString('utf-8');
}

/** Wrap raw SVG in a <g> with translate+scale so it sits in a 1920×960 canvas. */
function placeButton(svg: string, x: number, y: number, size: number): string {
  const scale = size / 144;
  // Strip the outer <svg ...> tags; we only need the inner content.
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  return `<g transform="translate(${x}, ${y}) scale(${scale})"><rect width="144" height="144" rx="14" fill="#0A0A0A"/>${inner}</g>`;
}

const COMMON_DEFS = `
  <defs>
    <radialGradient id="bg" cx="0.25" cy="0.5" r="0.95">
      <stop offset="0%" stop-color="#252525"/>
      <stop offset="100%" stop-color="#0B0B0B"/>
    </radialGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="20" stdDeviation="30" flood-color="#000" flood-opacity="0.5"/>
    </filter>
  </defs>`;

const FONT_STACK = `-apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Arial, sans-serif`;

// ── Gallery 1 ────────────────────────────────────────────────────────────────
// Combined view at normal usage. Hero button on the right, text on the left.
function gallery1(): string {
  const face = buttonFaceSvg(snap(34, 22, 2 * 60 + 14, 4 * 24 * 60 + 12 * 60), 0);
  const button = `<g filter="url(#shadow)">${placeButton(face, 1170, 200, 560)}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 960" fill="none">
${COMMON_DEFS}
  <rect width="1920" height="960" fill="url(#bg)"/>
  ${button}
  <g font-family="${FONT_STACK}" fill="#FFFFFF">
    <text x="190" y="360" font-size="72" font-weight="800">See your Claude Code</text>
    <text x="190" y="450" font-size="72" font-weight="800">usage at a glance.</text>
    <text x="190" y="555" font-size="32" font-weight="400" fill="#9CA3AF">Current session and weekly limits, plus reset</text>
    <text x="190" y="600" font-size="32" font-weight="400" fill="#9CA3AF">countdown — right on a Stream Deck button.</text>
    <rect x="190" y="660" width="80" height="4" rx="2" fill="#4ADE80"/>
  </g>
</svg>`;
}

// ── Gallery 2 ────────────────────────────────────────────────────────────────
// Color-coded warning. Show two button faces side by side: normal vs near-limit.
function gallery2(): string {
  const okFace   = buttonFaceSvg(snap(34, 22, 2 * 60 + 14, 4 * 24 * 60 + 12 * 60), 0);
  const hotFace  = buttonFaceSvg(snap(89, 76, 18,         2 * 24 * 60 + 6  * 60), 0);
  const okBtn   = `<g filter="url(#shadow)">${placeButton(okFace,   880, 240, 440)}</g>`;
  const hotBtn  = `<g filter="url(#shadow)">${placeButton(hotFace, 1400, 240, 440)}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 960" fill="none">
${COMMON_DEFS}
  <rect width="1920" height="960" fill="url(#bg)"/>
  ${okBtn}
  ${hotBtn}
  <g font-family="${FONT_STACK}" fill="#FFFFFF">
    <text x="160" y="360" font-size="72" font-weight="800">Color-coded</text>
    <text x="160" y="450" font-size="72" font-weight="800">warnings.</text>
    <text x="160" y="555" font-size="30" font-weight="400" fill="#9CA3AF">Green while you have headroom,</text>
    <text x="160" y="595" font-size="30" font-weight="400" fill="#9CA3AF">yellow as you approach the limit,</text>
    <text x="160" y="635" font-size="30" font-weight="400" fill="#9CA3AF">red when you're close to capped.</text>
    <rect x="160" y="690" width="80" height="4" rx="2" fill="#F87171"/>
  </g>
</svg>`;
}

// ── Gallery 3 ────────────────────────────────────────────────────────────────
// "Two views, one press." — Combined + Reset side by side with a tap indicator.
function gallery3(): string {
  const combined = buttonFaceSvg(snap(34, 22, 2 * 60 + 14, 4 * 24 * 60 + 12 * 60), 0);
  const reset    = buttonFaceSvg(snap(34, 22, 2 * 60 + 14, 4 * 24 * 60 + 12 * 60), 1);
  const leftBtn  = `<g filter="url(#shadow)">${placeButton(combined, 740,  300, 380)}</g>`;
  const rightBtn = `<g filter="url(#shadow)">${placeButton(reset,   1300, 300, 380)}</g>`;
  // Cycle arrow between buttons
  const arrow = `
    <g transform="translate(1180, 460)">
      <path d="M 0 30 L 60 30 M 50 18 L 60 30 L 50 42" stroke="#4ADE80" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      <text x="30" y="-10" text-anchor="middle" font-family="${FONT_STACK}" font-size="22" font-weight="600" fill="#9CA3AF">Press</text>
    </g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 960" fill="none">
${COMMON_DEFS}
  <rect width="1920" height="960" fill="url(#bg)"/>
  ${leftBtn}
  ${rightBtn}
  ${arrow}
  <g font-family="${FONT_STACK}" fill="#FFFFFF">
    <text x="960" y="160" text-anchor="middle" font-size="68" font-weight="800">Two views, one press.</text>
    <text x="960" y="225" text-anchor="middle" font-size="28" font-weight="400" fill="#9CA3AF">Tap the key (or the dial on Stream Deck +) to cycle.</text>

    <text x="930"  y="800" text-anchor="middle" font-size="26" font-weight="600" fill="#FFFFFF">Combined</text>
    <text x="930"  y="838" text-anchor="middle" font-size="22" font-weight="400" fill="#9CA3AF">session + weekly</text>

    <text x="1490" y="800" text-anchor="middle" font-size="26" font-weight="600" fill="#FFFFFF">Next Reset</text>
    <text x="1490" y="838" text-anchor="middle" font-size="22" font-weight="400" fill="#9CA3AF">countdown to soonest window</text>
  </g>
</svg>`;
}

const builds: Array<[string, () => string]> = [
  ['gallery-1-overview',   gallery1],
  ['gallery-2-warnings',   gallery2],
  ['gallery-3-two-views',  gallery3],
];

for (const [name, fn] of builds) {
  const svgPath = resolve(outDir, `${name}.svg`);
  const pngPath = resolve(outDir, `${name}.png`);
  writeFileSync(svgPath, fn());
  // -z H W (height first in sips). For 1920×960 the SVG viewBox already matches.
  execFileSync('/usr/bin/sips', ['-s', 'format', 'png', '-z', '960', '1920', svgPath, '--out', pngPath], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const sipsOut = execFileSync('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', pngPath]).toString();
  const stat = sipsOut
    .split('\n')
    .filter((l) => l.includes('pixel'))
    .map((l) => l.trim())
    .join(' ');
  console.log(`✔ ${name}.png  (${stat})`);
}
