import * as Y from 'yjs';

export interface ClipboardPayload {
  content: string;
  sourceDeviceId: string;
  updatedAt: number;
}

export class OmniClipboardSync {
  private pollerInterval: any = null;
  private lastOwnWriteTime = 0;
  private lastProcessedContent: string | null = null;
  private isDestroyed = false;

  constructor(
    private readonly localDeviceId: string,
    private readonly doc: Y.Doc,
    private readonly readLocalClipboard: () => Promise<string>,
    private readonly writeLocalClipboard: (text: string) => Promise<void>
  ) {}

  /**
   * Initializes polling and Yjs document sync listeners.
   */
  public initialize() {
    const clipboardMap = this.doc.getMap<any>('clipboard');

    // 1. Observe incoming remote clipboard mutations
    clipboardMap.observe((event) => {
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
      this.writeLocalClipboard(payload.content).catch((err) => {
        console.error('Failed to write clipboard to local OS:', err);
      });
    });

    // 2. Start polling local clipboard every 1s
    const poll = async () => {
      if (this.isDestroyed) return;
      try {
        const text = await this.readLocalClipboard();
        if (text !== this.lastProcessedContent) {
          this.lastProcessedContent = text;
          this.lastOwnWriteTime = Date.now();

          // Write to Yjs doc under a local-clipboard-poller transaction origin
          this.doc.transact(() => {
            const payload: ClipboardPayload = {
              content: text,
              sourceDeviceId: this.localDeviceId,
              updatedAt: this.lastOwnWriteTime,
            };
            clipboardMap.set('data', payload);
          }, 'local-clipboard-poller');
        }
      } catch (err) {
        // Suppress console spam on background clipboard lock failures
      }

      this.pollerInterval = setTimeout(poll, 1000);
    };

    poll();
  }

  /**
   * Disposes timers.
   */
  public destroy() {
    this.isDestroyed = true;
    if (this.pollerInterval) {
      clearTimeout(this.pollerInterval);
      this.pollerInterval = null;
    }
  }
}
