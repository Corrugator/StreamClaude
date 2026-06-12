import streamDeck from '@elgato/streamdeck';
import { ClaudeUsage } from './actions/claude-usage.js';

// Default level (info). Set 'debug' or 'trace' temporarily when diagnosing.
// streamDeck.logger.setLevel('debug');
streamDeck.actions.registerAction(new ClaudeUsage());
streamDeck.connect();
