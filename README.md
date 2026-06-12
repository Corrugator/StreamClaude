# StreamClaude

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

Install **"Usage Monitor for Claude Code"** from the Elgato Marketplace (once the listing is live). Updates arrive automatically.

### Option B: install a packaged build

```bash
git clone <this-repo>
cd StreamClaude
npm install
npm run pack
open com.corrugator.streamclaude.streamDeckPlugin   # Stream Deck installs it
```

### Option C: link for development

```bash
git clone <this-repo>
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

## Project structure

```
StreamClaude/
├── package.json                      # ESM, Node 20, @elgato/streamdeck v2
├── rollup.config.mjs                 # Bundles src/plugin.ts → bin/plugin.js (ESM, SDK included)
├── tsconfig.json                     # ES2022, strict, bundler resolution
├── helpers/
│   └── keychain-helper.swift         # Swift CLI: keychain read/write via Security framework
├── scripts/
│   ├── probe.ts                      # `npm run probe` — verifies keychain + API outside Stream Deck
│   └── build-gallery.ts              # `npm run build:gallery` — renders marketplace gallery images
├── marketplace/                      # Listing assets (icons, thumbnail, gallery)
├── src/
│   ├── plugin.ts                     # Entry: registers ClaudeUsage, calls connect()
│   ├── actions/
│   │   └── claude-usage.ts           # SingletonAction; handles Keypad + Encoder in one class
│   └── lib/
│       ├── keychain.ts               # Spawns the bundled keychain-helper (read/write)
│       ├── oauth.ts                  # Token refresh against the Claude Code OAuth endpoint
│       ├── anthropic-client.ts       # POST /v1/messages, extracts rate-limit headers → UsageSnapshot
│       ├── usage-store.ts            # Singleton polling cache: subscribe/notify, backoff on error
│       └── view-renderer.ts          # deriveView() + renderKeypadImage() + renderEncoderFeedback()
└── com.corrugator.streamclaude.sdPlugin/
    ├── manifest.json                 # Action UUID com.corrugator.streamclaude.usage
    │                                 # Controllers: ["Keypad", "Encoder"]
    ├── bin/                          # Build output: plugin.js + keychain-helper
    │                                 # (plugin.js.map only in dev builds)
    ├── imgs/
    │   ├── plugin/{icon,category}.{png,svg}
    │   └── actions/usage/icon.svg
    ├── layouts/
    │   └── usage.json                # Stream Deck+ LCD layout (label / value / bar / sub)
    └── ui/
        └── usage-pi.html             # Property inspector (default-view dropdown)
```

### Critical files for understanding / modifying the plugin

| File | Purpose |
|---|---|
| `src/lib/anthropic-client.ts` | The only place that talks to the Anthropic API. Change request body, headers, or which response headers are parsed here. |
| `src/lib/oauth.ts` | Access-token refresh (proactive + reactive). Single in-flight refresh; preserves unknown keychain fields; redacts tokens from error text. |
| `src/lib/keychain.ts` | Spawns `bin/keychain-helper` to read/write the `Claude Code-credentials` entry. Secret via stdin, lookup pinned to (service, current user). |
| `src/lib/usage-store.ts` | Polling lifecycle and listener pattern. Change default interval, backoff curve, or add new derived state here. |
| `src/lib/view-renderer.ts` | All visual output. `ViewId` is `0` (Combined) or `1` (Reset). The keypad renders a 144×144 SVG directly from the `UsageSnapshot`. To re-skin, edit `renderCombinedSvg()` / `renderResetSvg()` (keypad) and `renderEncoderFeedback()` (LCD). |
| `src/actions/claude-usage.ts` | Stream Deck event handlers. The unified class checks `a.isDial()` to fork rendering between LCD and keypad. |
| `helpers/keychain-helper.swift` | The keychain CLI. Rebuilt + ad-hoc-signed by `npm run build:helper`. |
| `com.corrugator.streamclaude.sdPlugin/manifest.json` | Manifest. To add a second action, register it here AND in `src/plugin.ts`. **Do not add `"Nodejs": {"Debug": "disabled"}`** — see Troubleshooting. |
| `com.corrugator.streamclaude.sdPlugin/layouts/usage.json` | LCD layout. `key` values here must match the keys returned by `renderEncoderFeedback()`. |

---

## Scripts

| Command | What it does |
|---|---|
| `npm run build` | Rollup bundle (with source map) + compile + ad-hoc-sign the Swift keychain helper. Dev build. |
| `npm run build:prod` | Same, but removes logs and source map, sets `NODE_ENV=production`. Use this before packing for distribution. |
| `npm run build:helper` | Just rebuilds the universal (arm64+x86_64) `keychain-helper` binary and ad-hoc-signs it. |
| `npm run build:gallery` | Re-renders the 1920×960 marketplace gallery images from the current view-renderer. |
| `npm run pack` | `build:prod` + `npx @elgato/cli pack -f` — produces the `.streamDeckPlugin` artifact for marketplace upload. |
| `npm run clean:logs` | Removes leftover log files from the bundle. |
| `npm run watch` | Rollup with file watching (dev). |
| `npm run probe` | Runs `scripts/probe.ts` via `tsx` — reads the keychain, calls Anthropic, prints the parsed snapshot. Use this to debug auth/network without touching Stream Deck. |

### Useful Elgato CLI commands

```bash
npx @elgato/cli validate com.corrugator.streamclaude.sdPlugin
npx @elgato/cli link     com.corrugator.streamclaude.sdPlugin
npx @elgato/cli unlink   com.corrugator.streamclaude
npx @elgato/cli restart  com.corrugator.streamclaude
npx @elgato/cli stop     com.corrugator.streamclaude
npx @elgato/cli pack -f  com.corrugator.streamclaude.sdPlugin
```

---

## Releasing / Marketplace updates

**Rule of thumb: every change that ships to anyone other than yourself requires a version bump *and* a freshly built `.streamDeckPlugin` file.** Elgato's marketplace rejects re-uploads with the same version string, and users who already installed the plugin won't be offered the update if the version didn't change.

### Checklist for every release

1. **Bump the version** in *both* of these files (they must match the major/minor/patch parts; the four-part vs. three-part difference is just convention):
   - `com.corrugator.streamclaude.sdPlugin/manifest.json` → `Version` (e.g. `"0.1.0.3"` → `"0.1.0.4"`)
   - `package.json` → `version`  (e.g. `"0.1.3"` → `"0.1.4"`)

   Use a **patch bump** for bug fixes and small UX improvements, **minor** for new features that don't break existing usage, **major** for breaking changes.

2. **Validate** the manifest:
   ```bash
   npx @elgato/cli validate com.corrugator.streamclaude.sdPlugin
   ```
   Must end with `✔ Validation successful` — any error or new warning blocks submission.

3. **Build the marketplace artifact:**
   ```bash
   npm run pack
   ```
   Produces `com.corrugator.streamclaude.streamDeckPlugin` in the repo root. **Don't** ship the dev tree (`com.corrugator.streamclaude.sdPlugin/` directory) — it may contain a source map and leftover logs.

4. **Sanity-check the artifact** before upload — verify Name, Version, helper architectures, and that no logs or secrets leaked in:
   ```bash
   unzip -p com.corrugator.streamclaude.streamDeckPlugin '*/manifest.json' | grep -E '"Name"|"Version"|"Author"|SDKVersion'
   unzip -l com.corrugator.streamclaude.streamDeckPlugin | grep -vE '\.(js|json|html|svg|png)|keychain-helper|----|Archive|Length'
   unzip -p com.corrugator.streamclaude.streamDeckPlugin '*/bin/keychain-helper' > /tmp/k && lipo -info /tmp/k && rm /tmp/k
   ```

5. **Write release notes** that name the user-visible change in one sentence. Put them under `## v<version>` in your release-notes draft so they paste cleanly into Maker Console.

6. **Upload** in Elgato Maker Console — wait for review approval before declaring it shipped.

### Why this matters

- **Same-version upload rejected.** If you re-submit the same version string Maker Console refuses the upload, and you waste a review cycle.
- **Auto-update gate.** Existing users only get the new build if their installed version compares lower than what's published. Forgetting the bump means your fix never reaches them.
- **Diagnostic clarity.** When a user reports a bug, the version number in the manifest is how you know which build they're running. Identical versions with different contents make remote debugging impossible.

### What NOT to bump for

- Local-only experiments that you never share — the dev tree (`com.corrugator.streamclaude.sdPlugin/`) used via `npx streamdeck link` is fine to keep at the same version.
- Pure tooling changes (scripts, README, gallery images) that don't change the runtime binary — the marketplace listing description can be updated without a new build.

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

## Extending

### Add a new view (worked example)

1. In `src/lib/view-renderer.ts`:
   - Widen `ViewId` to `0 | 1 | 2`
   - Add a `VIEWS` entry and a `VIEW_NAME` entry
   - Add a branch in `renderKeypadImage()` for the new id (call a new `renderXyzSvg()` helper)
   - Add a `case 2:` branch in `deriveView()` for the encoder LCD
2. In `src/actions/claude-usage.ts`: update the view clamp in `renderOne()` / `renderAll()` (`rawView === 1 ? 1 : 0` currently folds everything else to `0`).
3. In `com.corrugator.streamclaude.sdPlugin/ui/usage-pi.html`: add the matching `<option>` to the dropdown.
4. Rebuild: `npm run build`
5. Restart: `npx @elgato/cli restart com.corrugator.streamclaude`

Cycling order and persistence derive from `VIEWS.length` automatically.

### Add a new data source

If you want metrics not in the rate-limit headers (e.g. cost from local Claude Code session JSONL files):
1. Add a new fetcher in `src/lib/` (e.g. `cost-from-jsonl.ts`).
2. Either extend `UsageSnapshot` and merge in `usage-store.ts.poll()`, or create a parallel store with its own polling interval.
3. Surface the value via a new view (see above).

### Port to Linux / Windows

The platform-specific parts are `src/lib/keychain.ts` and the Swift helper it spawns. Replace them with the platform's secret store (`secret-tool` on Linux, Credential Manager on Windows — keep the secret out of argv there too), adjust where Claude Code stores its credentials on that OS, and update `manifest.json`'s `OS` array.

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
