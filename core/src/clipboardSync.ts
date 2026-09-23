import * as Y from 'yjs';

export interface ClipboardPayload {
  type?: 'text' | 'image';
  content: string;
  mimeType?: string;
  sourceDeviceId: string;
  updatedAt: number;
}

export interface ClipboardHistoryItem {
  id: string;
  type: 'text' | 'image';
  content: string;
  mimeType?: string;
  sourceDeviceId: string;
  timestamp: number;
}

export interface ClipboardMapSchema {
  data?: ClipboardPayload;
}

export class OmniClipboardSync {
  private pollerInterval: ReturnType<typeof setTimeout> | null = null;
  private lastOwnWriteTime = 0;
  private lastProcessedContent: string | null = null;
  private isDestroyed = false;
  private isPolling = false;
  private observer: ((event: Y.YMapEvent<any>) => void) | null = null;
  private visibilityListener: (() => void) | null = null;
  private history: ClipboardHistoryItem[] = [];

  public onHistoryChanged?: (history: ClipboardHistoryItem[]) => void;

  constructor(
    private readonly localDeviceId: string,
    private readonly doc: Y.Doc,
    private readonly readLocalClipboard: () => Promise<string>,
    private readonly writeLocalClipboard: (text: string) => Promise<void>
  ) {}

  public getHistory(): ClipboardHistoryItem[] {
    return [...this.history];
  }

  private addToHistory(item: Omit<ClipboardHistoryItem, 'id'>) {
    if (this.history.length > 0 && this.history[0].content === item.content) {
      return;
    }
    const entry: ClipboardHistoryItem = {
      ...item,
      id: `clip-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    };
    this.history.unshift(entry);
    if (this.history.length > 10) {
      this.history.pop();
    }
    if (this.onHistoryChanged) {
      this.onHistoryChanged(this.getHistory());
    }
  }

  public async pushRichClipboard(type: 'text' | 'image', content: string, mimeType = 'text/plain') {
    this.lastOwnWriteTime = Date.now();
    this.lastProcessedContent = content;

    this.addToHistory({
      type,
      content,
      mimeType,
      sourceDeviceId: this.localDeviceId,
      timestamp: this.lastOwnWriteTime,
    });

    const clipboardMap = this.doc.getMap<any>('clipboard');
    this.doc.transact(() => {
      const payload: ClipboardPayload = {
        type,
        content,
        mimeType,
        sourceDeviceId: this.localDeviceId,
        updatedAt: this.lastOwnWriteTime,
      };
      clipboardMap.set('data', payload);
    }, 'local-clipboard-poller');
  }

  /**
   * Initializes polling and Yjs document sync listeners.
   */
  public initialize() {
    const clipboardMap = this.doc.getMap<any>('clipboard');

    // 1. Observe incoming remote clipboard mutations
    this.observer = (event) => {
      // Ignore if transaction was originated locally by this device's own poller
      if (event.transaction.origin === 'local-clipboard-poller') {
        return;
      }

      const payload = clipboardMap.get('data') as ClipboardPayload;
      if (!payload) return;

      // Echo-loop prevention rules
      if (payload.sourceDeviceId === this.localDeviceId) {
        return;
      }

      if (payload.updatedAt <= this.lastOwnWriteTime) {
        return; // Stale incoming remote write compared to our own newer copy
      }

      // Safe to apply remote clipboard write locally
      this.lastProcessedContent = payload.content;
      this.addToHistory({
        type: payload.type || 'text',
        content: payload.content,
        mimeType: payload.mimeType || 'text/plain',
        sourceDeviceId: payload.sourceDeviceId,
        timestamp: payload.updatedAt,
      });

      this.writeLocalClipboardWithRetry(payload.content).catch((err) => {
        console.error('[OmniClipboardSync] Uncaught error in clipboard write retry loop:', err);
      });
    };
    clipboardMap.observe(this.observer);

    // 2. Start polling local clipboard every 1s
    const MAX_CLIPBOARD_BYTES = 512 * 1024; // 512 KB
    const poll = async () => {
      if (this.isDestroyed || this.isPolling) return;
      this.isPolling = true;

      // Pause active polling when document is in background to save battery
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        this.isPolling = false;
        this.pollerInterval = setTimeout(poll, 2500);
        return;
      }

      try {
        const text = await this.readLocalClipboard();
        if (text !== this.lastProcessedContent) {
          this.lastProcessedContent = text;

          // Do not broadcast empty strings if uninitialized, and cap maximum size
          if (text && typeof text === 'string' && text.length <= MAX_CLIPBOARD_BYTES) {
            this.lastOwnWriteTime = Date.now();

            this.addToHistory({
              type: 'text',
              content: text,
              mimeType: 'text/plain',
              sourceDeviceId: this.localDeviceId,
              timestamp: this.lastOwnWriteTime,
            });

            // Write to Yjs doc under a local-clipboard-poller transaction origin
            this.doc.transact(() => {
              const payload: ClipboardPayload = {
                type: 'text',
                content: text,
                mimeType: 'text/plain',
                sourceDeviceId: this.localDeviceId,
                updatedAt: this.lastOwnWriteTime,
              };
              clipboardMap.set('data', payload);
            }, 'local-clipboard-poller');
          }
        }
      } catch (err: any) {
        if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError' || String(err).includes('lock') || String(err).includes('busy'))) {
          // Expected transient background clipboard lock/permission failures
        } else {
          console.debug('[OmniClipboardSync] Error during clipboard polling:', err);
        }
      } finally {
        this.isPolling = false;
      }

      if (this.isDestroyed) return;
      this.pollerInterval = setTimeout(poll, 1000);
    };

    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      this.visibilityListener = () => {
        if (document.visibilityState === 'visible' && !this.isDestroyed) {
          if (this.pollerInterval) {
            clearTimeout(this.pollerInterval);
            this.pollerInterval = null;
          }
          poll();
        }
      };
      document.addEventListener('visibilitychange', this.visibilityListener);
    }

    poll();
  }

  /**
   * Disposes timers and unobserves Yjs events.
   */
  public destroy() {
    this.isDestroyed = true;
    if (this.pollerInterval) {
      clearTimeout(this.pollerInterval);
      this.pollerInterval = null;
    }
    if (this.visibilityListener && typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', this.visibilityListener);
      this.visibilityListener = null;
    }
    if (this.observer) {
      const clipboardMap = this.doc.getMap<any>('clipboard');
      clipboardMap.unobserve(this.observer);
      this.observer = null;
    }
  }

  /**
   * Attempts to write to the local OS clipboard with exponential backoff retries.
   * Useful when another application temporarily locks OS clipboard access.
   */
  private async writeLocalClipboardWithRetry(
    content: string,
    maxAttempts = 3,
    baseDelayMs = 100
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this.isDestroyed) return;
      try {
        await this.writeLocalClipboard(content);
        return;
      } catch (err) {
        if (attempt === maxAttempts) {
          console.error(
            `[OmniClipboardSync] Failed to write clipboard to local OS after ${maxAttempts} attempts:`,
            err
          );
        } else {
          const delay = baseDelayMs * Math.pow(2, attempt - 1);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
  }
}
