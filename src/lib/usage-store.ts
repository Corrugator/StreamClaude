import streamDeck from '@elgato/streamdeck';
import { fetchUsage } from './anthropic-client.js';
import type { UsageSnapshot } from './anthropic-client.js';

type Listener = () => void;

const logger = streamDeck.logger.createScope('UsageStore');

const DEFAULT_INTERVAL_MS = 60_000;
const ERROR_BACKOFF_MS = 5 * 60_000;

let intervalMs = DEFAULT_INTERVAL_MS;
let timer: ReturnType<typeof setTimeout> | undefined;
let inflight: Promise<void> | undefined;
let consecutiveErrors = 0;

let latest: UsageSnapshot | undefined;
let lastError: Error | undefined;

const listeners = new Set<Listener>();

function scheduleNext(): void {
  if (timer) clearTimeout(timer);
  const delay = consecutiveErrors > 0
    ? Math.min(ERROR_BACKOFF_MS, intervalMs * (1 + consecutiveErrors))
    : intervalMs;
  timer = setTimeout(() => void poll(), delay);
}

async function poll(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      latest = await fetchUsage();
      lastError = undefined;
      consecutiveErrors = 0;
      logger.info(
        `usage refreshed: session=${latest.sessionPct.toFixed(1)}% weekly=${latest.weeklyPct.toFixed(1)}%`
      );
    } catch (e) {
      lastError = e as Error;
      consecutiveErrors++;
      logger.warn(`usage refresh failed (${consecutiveErrors}): ${(e as Error).message}`);
    } finally {
      inflight = undefined;
      notify();
      if (listeners.size > 0) scheduleNext();
    }
  })();
  return inflight;
}

function notify(): void {
  for (const cb of listeners) {
    try {
      cb();
    } catch (e) {
      logger.error('listener threw', e);
    }
  }
}

export function subscribe(cb: Listener): () => void {
  const wasEmpty = listeners.size === 0;
  listeners.add(cb);
  if (wasEmpty) {
    void poll();
  } else if (latest) {
    // New subscriber: deliver cached value immediately.
    queueMicrotask(cb);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
}

export function getLatest(): UsageSnapshot | undefined {
  return latest;
}

export function getLastError(): Error | undefined {
  return lastError;
}

export function setInterval(ms: number): void {
  const clamped = Math.max(15_000, Math.min(15 * 60_000, Math.round(ms)));
  if (clamped === intervalMs) return;
  intervalMs = clamped;
  logger.info(`poll interval set to ${intervalMs / 1000}s`);
  if (listeners.size > 0) scheduleNext();
}

export function getInterval(): number {
  return intervalMs;
}

export function isPolling(): boolean {
  return inflight !== undefined;
}

export function refreshNow(): Promise<void> {
  return poll();
}
