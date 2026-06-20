# StreamDeck-Claude

A [Stream Deck](https://www.elgato.com/stream-deck) plugin that shows live **Claude Code** usage on a single button.

| View | Shows |
|---|---|
| **Combined** *(default)* | Session (5 h) and weekly utilization side by side, each with a colored bar and reset countdown |
| **Reset** *(press to toggle)* | Countdown to the next reset (whichever of session / week comes first) |

The bar and value color shifts **green → yellow → red** as utilization rises (thresholds: 60 %, 85 %). A small footer line shows the polling status (`✳ 42s ago` / `✳ Polling…`).

Works on classic Stream Decks (Mini / MK.2 / XL / Neo) **and** on the Stream Deck+ (where it additionally drives the LCD strip and lets you tweak the polling interval with the encoder dial).

Inspired by [Clawdmeter](https://github.com/HermannBjorgvin/Clawdmeter) by Hermann Björgvin — same data source, different hardware target.

---

## How it works

Anthropic returns rate-limit utilization in **response headers** on every `/v1/messages` call. The plugin fires a minimal probe request (`max_tokens: 1`), reads the headers, and ignores the body. No log scraping, no analytics, no third-party servers — the plugin only ever talks to Anthropic-owned endpoints.

> **Transparency note:** the plugin authenticates with the same OAuth credentials that Claude Code stores in your macOS keychain, and refreshes them through the same token endpoint the Claude Code CLI itself uses. Each probe consumes a tiny sliver (~1 token) of the very usage budget it measures. Neither the rate-limit headers nor the OAuth endpoint are officially documented public APIs, so a change on Anthropic's side may require a plugin update.

```
┌──────────────────────────────┐        ┌─────────────────────────────────┐
│  macOS Keychain              │        │  api.anthropic.com              │
│  service "Claude Code-       │ token  │  POST /v1/messages              │
│   credentials" (JSON blob)   │ ─────▶ │  max_tokens:1, probe            │
│  read/write via the bundled  │        └───────────┬─────────────────────┘
│  Swift keychain-helper       │                    │ response headers:
└───────────┬──────────────────┘                    │  anthropic-ratelimit-unified-5h-utilization
            │ token expired?                        │  anthropic-ratelimit-unified-5h-reset
            ▼                                       │  anthropic-ratelimit-unified-7d-utilization
┌──────────────────────────────┐                    │  anthropic-ratelimit-unified-7d-reset
│  platform.claude.com         │                    ▼
│  POST /v1/oauth/token        │   ┌────────────────────────────────────────────────┐
│  refresh, then write the     │   │ usage-store (singleton, polls every 60 s,      │
│  rotated tokens back         │   │  linear error backoff capped at 5 min)         │
└──────────────────────────────┘   │ ↓ subscribe / notify                           │
                                   │ ClaudeUsage action(s) — one per button         │
                                   │   onKeyDown / onDialDown → cycle view          │
                                   │   onWillAppear → subscribe + render            │
                                   │   onWillDisappear → unsubscribe when none left │
                                   │ ↓                                              │
                                   │ view-renderer → SVG datauri (keypad)           │
                                   │                 OR feedback payload (LCD)      │
                                   └────────────────────────────────────────────────┘
```

**Key design decisions:**
- Single API call per polling tick, shared by every visible button instance.
- Polling lifecycle is owned by `usage-store`; the action subscribes when visible and unsubscribes when the last instance disappears. No leaked timers when the user removes the action from their Stream Deck profile.
- View state (`0|1`) is stored in per-action `settings` so it survives a Stream Deck software restart.
- A separate 30-second "tick" re-renders visible buttons so countdowns update smoothly between API polls.
- The keypad image is generated as an inline SVG datauri — no `node-canvas`, no image dependencies, no native modules to compile.
- Keychain access goes through a small bundled Swift helper (`bin/keychain-helper`) instead of `/usr/bin/security`: the secret travels via **stdin** (never argv, where other processes could read it), and the helper's own code signature makes the macOS "Always Allow" decision permanent.
- OAuth tokens are refreshed proactively before expiry and reactively on 401, tolerant of token rotation by a concurrently running Claude Code CLI (single in-flight refresh, re-read before write, never clobbers fields the CLI added).

---

## Requirements

| | |
|---|---|
| **OS** | macOS 12.0+ |
| **Stream Deck software** | 6.9+ |
| **Hardware** | Any Stream Deck (Mini, MK.2, XL, Neo, +) |
| **Claude Code** | Logged in once — credentials must exist in the Keychain under service `Claude Code-credentials` |
| **For local builds only** | Node.js 20+ and the Xcode Command Line Tools (`swiftc`, for the keychain helper) |

The first time the plugin reads the token, macOS prompts with an **"Always Allow"** keychain dialog for `keychain-helper`. Allow it once — the decision sticks until the helper binary changes (i.e. after a plugin update).

---

## Install

### Option A: Elgato Marketplace

Install **"StreamDeck-Claude"** from the Elgato Marketplace (once the listing is live). Updates arrive automatically.

### Option B: download a packaged build

Grab the latest `com.corrugator.streamclaude.streamDeckPlugin` from the
[**Releases**](https://github.com/Corrugator/StreamClaude/releases/latest) page
and open it — Stream Deck installs it.

### Option C: build from source

```bash
git clone https://github.com/Corrugator/StreamClaude.git
cd StreamClaude
npm install
npm run build
npx @elgato/cli link com.corrugator.streamclaude.sdPlugin
npx @elgato/cli restart com.corrugator.streamclaude
```

Then drag the **"Claude Usage"** action onto any button or encoder slot.

---

## Use

- **Click / push** — toggle between Combined view and Reset countdown.
- **Default view** — select the action in the Stream Deck app; the property inspector offers a "Start with" dropdown.
- **Stream Deck+ only — rotate the encoder** — adjusts the polling interval in 15-second steps (clamped to 15 s – 15 min).

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Button shows **"Sign in / Run: claude"** | No Claude Code credentials in the keychain (never logged in, or logged out) | Run `claude` in a terminal and log in. The plugin recovers on the next poll (≤ 60 s). `npm run probe` shows the same pipeline outside Stream Deck. |
| **"Sign in"** although you are logged in | Refresh token invalidated (e.g. re-login on another machine rotated it) | Log in to Claude Code again. Token refresh itself is automatic — a persistent 401 means the stored refresh token no longer works. |
| Button shows **"Offline"** | No network connection | The plugin backs off (up to 5 min) and recovers automatically. |
| Button shows `…` / "loading" forever | First poll hasn't completed (or the API call is hanging) | Check the logs: `~/Library/Logs/ElgatoStreamDeck/` and `com.corrugator.streamclaude.sdPlugin/logs/`. |
| Keychain prompt: *"keychain-helper wants to access…"* | First read of the OAuth token (or first read after a plugin update changed the helper binary) | Click **Always Allow**. Happens once per helper build. |
| Plugin won't load after rebuild | Stream Deck cached the old bundle | `npx @elgato/cli restart com.corrugator.streamclaude` |
| Plugin process **dies instantly** after install/link (exit 1, no plugin logs, "unstable" after ~1 min) | Stream Deck 7.4.x mishandles `"Nodejs": {"Debug": "disabled"}` in the manifest when (re-)registering a plugin | Omit the `Debug` key entirely — disabled is the default anyway. |
| `npm run build` fails with "Cannot find package typescript/lib/typescript.js" | TypeScript 6 is installed but `@rollup/plugin-typescript` does not support it yet | Downgrade: `npm install typescript@5 --save-dev` |
| Build takes hours instead of seconds | Project is stored on iCloud Drive — every file write triggers a sync round-trip | Move the project to a local path outside of iCloud Drive. |

Plugin logs are written to `com.corrugator.streamclaude.sdPlugin/logs/` by the `@elgato/streamdeck` SDK. The default log level is `info`; for diagnosis, temporarily uncomment `streamDeck.logger.setLevel('debug')` in `src/plugin.ts` and rebuild — don't ship that.

---

## Limitations / known issues

- **macOS only**, see above.
- **Shares Claude Code's OAuth session.** Access tokens are refreshed automatically (proactively before expiry, reactively on 401), and the plugin tolerates token rotation by a concurrently running Claude Code CLI. If the keychain entry disappears entirely (logout), the button shows "Sign in" until you log in again.
- **Polling cost:** each tick spends ~1 token of your own usage budget — at the default 60-second interval that's negligible relative to the 5-hour window it measures. The encoder dial can stretch the interval up to 15 minutes.
- **Unofficial data source:** the rate-limit headers and the Claude Code OAuth endpoint are not documented public APIs. If Anthropic changes either, the plugin needs an update.
- **No Developer-ID signature.** The plugin bundle is unsigned; the keychain helper carries an ad-hoc signature — enough to make the keychain "Always Allow" decision stick. Install trust comes from the Marketplace review (Option A) or from building it yourself (Options B/C).

---

## Credits

- [Clawdmeter](https://github.com/HermannBjorgvin/Clawdmeter) by Hermann Björgvin — the original idea and the discovery that Anthropic's rate-limit headers are the cleanest data source for Claude Code usage. This plugin reuses the same approach.
- [@elgato/streamdeck](https://docs.elgato.com/streamdeck/sdk/introduction) — Elgato's TypeScript SDK for Stream Deck plugins.

## License

ISC
