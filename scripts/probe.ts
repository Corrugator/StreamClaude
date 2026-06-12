// Standalone probe: run `npm run probe` to verify keychain + API work.
// Bypasses Stream Deck — uses the same code paths the plugin will.

import { fetchUsage, AnthropicError } from '../src/lib/anthropic-client.ts';
import { readClaudeCredentials, KeychainError } from '../src/lib/keychain.ts';

async function main() {
  console.log('1) Reading credentials from keychain…');
  try {
    const creds = readClaudeCredentials();
    console.log(`   ok — accessToken starts with ${creds.accessToken.slice(0, 12)}…`);
    if (creds.expiresAt) {
      console.log(`   expiresAt: ${new Date(creds.expiresAt).toISOString()}`);
    }
  } catch (e) {
    if (e instanceof KeychainError) {
      console.error(`   FAILED: ${e.message}`);
      if (e.stderr) console.error(`   stderr: ${e.stderr}`);
      process.exit(1);
    }
    throw e;
  }

  console.log('2) Calling Anthropic /v1/messages (minimal probe)…');
  try {
    const snap = await fetchUsage();
    console.log('   ok');
    console.log(`   sessionPct:     ${snap.sessionPct.toFixed(1)}%`);
    console.log(`   weeklyPct:      ${snap.weeklyPct.toFixed(1)}%`);
    console.log(`   sessionResetAt: ${snap.sessionResetAt?.toISOString() ?? '—'}`);
    console.log(`   weeklyResetAt:  ${snap.weeklyResetAt?.toISOString() ?? '—'}`);
  } catch (e) {
    if (e instanceof AnthropicError) {
      console.error(`   FAILED (${e.status ?? '?'}): ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
}

main().catch((e) => {
  console.error('unexpected error:', e);
  process.exit(99);
});
