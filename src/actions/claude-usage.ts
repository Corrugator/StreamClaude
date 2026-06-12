import streamDeck, {
  action,
  DialDownEvent,
  DialRotateEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  SingletonAction,
  WillAppearEvent,
  WillDisappearEvent,
} from '@elgato/streamdeck';
import {
  getInterval,
  getLastError,
  getLatest,
  isPolling,
  setInterval as setUsageInterval,
  subscribe,
} from '../lib/usage-store.js';
import {
  deriveView,
  renderEncoderFeedback,
  renderKeypadImage,
  VIEWS,
  type ViewId,
} from '../lib/view-renderer.js';

type UsageSettings = {
  view?: ViewId;
};

const logger = streamDeck.logger.createScope('UsageAction');

// Re-render all visible instances every 30 s so the countdown ticks down
// even when the API isn't polled in between.
const TICK_MS = 30_000;

@action({ UUID: 'com.corrugator.streamclaude.usage' })
export class ClaudeUsage extends SingletonAction<UsageSettings> {
  private unsubscribe?: () => void;
  private tickTimer?: ReturnType<typeof setInterval>;
  private activeCount = 0;

  override async onWillAppear(ev: WillAppearEvent<UsageSettings>): Promise<void> {
    this.activeCount++;
    logger.debug(`onWillAppear active=${this.activeCount} isDial=${ev.action.isDial()}`);
    if (!this.unsubscribe) {
      this.unsubscribe = subscribe(() => this.renderAll());
    }
    if (!this.tickTimer) {
      this.tickTimer = setInterval(() => this.renderAll(), TICK_MS);
    }
    try {
      await this.renderOne(ev);
    } catch (e) {
      logger.error(`onWillAppear renderOne threw`, e);
    }
  }

  override onWillDisappear(_ev: WillDisappearEvent<UsageSettings>): void {
    this.activeCount = Math.max(0, this.activeCount - 1);
    if (this.activeCount === 0) {
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      if (this.tickTimer) {
        clearInterval(this.tickTimer);
        this.tickTimer = undefined;
      }
    }
  }

  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<UsageSettings>
  ): Promise<void> {
    await this.renderOne(ev);
  }

  override async onKeyDown(ev: KeyDownEvent<UsageSettings>): Promise<void> {
    await this.cycleView(ev);
  }

  override async onDialDown(ev: DialDownEvent<UsageSettings>): Promise<void> {
    await this.cycleView(ev);
  }

  override async onDialRotate(ev: DialRotateEvent<UsageSettings>): Promise<void> {
    const step = 15_000; // 15 s per tick
    setUsageInterval(getInterval() + ev.payload.ticks * step);
    // Transient feedback: show the new interval instead of firing an extra
    // API probe (the store already rescheduled its timer). The next poll
    // notification or 30 s render tick restores the usage view.
    const secs = getInterval() / 1000;
    const m = Math.floor(secs / 60);
    const s = Math.round(secs % 60);
    await ev.action.setFeedback({
      viewLabel: { value: 'Poll every', color: '#A0A0A0' },
      bigValue:  { value: m === 0 ? `${s}s` : s === 0 ? `${m}m` : `${m}m ${s}s`, color: '#FFFFFF' },
      bar:       { value: Math.round(((secs - 15) / (900 - 15)) * 100) },
      subLabel:  { value: 'turn to adjust', color: '#C8C8C8' },
    });
  }

  // ------------------------------------------------------------------

  private async cycleView(
    ev: KeyDownEvent<UsageSettings> | DialDownEvent<UsageSettings>
  ): Promise<void> {
    const current = (ev.payload.settings.view ?? 0) as ViewId;
    const idx = VIEWS.indexOf(current);
    const next = VIEWS[(idx + 1) % VIEWS.length];
    await ev.action.setSettings({ ...ev.payload.settings, view: next });
    logger.info(`cycle view: ${current} → ${next}`);
    // onDidReceiveSettings will fire and re-render; render eagerly anyway.
    await this.renderOne(ev, next);
  }

  private async renderOne(
    ev:
      | WillAppearEvent<UsageSettings>
      | DidReceiveSettingsEvent<UsageSettings>
      | KeyDownEvent<UsageSettings>
      | DialDownEvent<UsageSettings>
      | DialRotateEvent<UsageSettings>,
    overrideView?: ViewId
  ): Promise<void> {
    const rawView = overrideView ?? ev.payload.settings.view ?? 0;
    const view = (rawView === 1 ? 1 : 0) as ViewId;
    const snap = getLatest();
    const err  = getLastError();
    const a = ev.action;
    if (a.isDial()) {
      await a.setFeedback(renderEncoderFeedback(deriveView(view, snap, err)));
    } else {
      await a.setImage(renderKeypadImage(snap, err, view, isPolling()));
      await a.setTitle('');
    }
  }

  private renderAll(): void {
    const snap    = getLatest();
    const err     = getLastError();
    const polling = isPolling();
    for (const a of this.actions) {
      void (async () => {
        try {
          const settings = await a.getSettings();
          const rawView  = settings.view ?? 0;
          const view     = (rawView === 1 ? 1 : 0) as ViewId;
          if (a.isDial()) {
            await a.setFeedback(renderEncoderFeedback(deriveView(view, snap, err)));
          } else {
            await a.setImage(renderKeypadImage(snap, err, view, polling));
            await a.setTitle('');
          }
        } catch (e) {
          logger.error(`renderAll one threw dial=${a.isDial()}`, e);
        }
      })();
    }
  }
}
