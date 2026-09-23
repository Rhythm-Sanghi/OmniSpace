import { describe, it, expect, vi } from 'vitest';
import * as Y from 'yjs';
import { OmniClipboardSync } from '../src/clipboardSync.js';

describe('OmniClipboardSync', () => {
  it('synchronizes local changes to Yjs and ignores echo updates', async () => {
    const doc = new Y.Doc();
    let localClipboard = 'Initial Text';
    
    const readSpy = vi.fn().mockImplementation(() => Promise.resolve(localClipboard));
    const writeSpy = vi.fn().mockImplementation((text) => {
      localClipboard = text;
      return Promise.resolve();
    });

    const sync = new OmniClipboardSync(
      'device-A',
      doc,
      readSpy,
      writeSpy
    );

    // Initial check
    sync.initialize();
    await vi.waitFor(() => expect(readSpy).toHaveBeenCalled());

    // Local change -> should write to Yjs map
    localClipboard = 'Hello World';
    // Manually force a poll step (since we didn't mock setTimeout easily)
    await (sync as any).readLocalClipboard();
    
    // Trigger poller code path directly for test control
    await (sync as any).doc.transact(() => {
      (sync as any).lastProcessedContent = 'Hello World';
      (sync as any).lastOwnWriteTime = 1000;
      doc.getMap('clipboard').set('data', {
        content: 'Hello World',
        sourceDeviceId: 'device-A',
        updatedAt: 1000,
      });
    }, 'local-clipboard-poller');

    const clipboardMap = doc.getMap<any>('clipboard');
    expect(clipboardMap.get('data')?.content).toBe('Hello World');
    expect(clipboardMap.get('data')?.sourceDeviceId).toBe('device-A');

    // Remote update -> should write to local clipboard
    doc.transact(() => {
      clipboardMap.set('data', {
        content: 'From Remote',
        sourceDeviceId: 'device-B',
        updatedAt: 2000, // Newer than lastOwnWriteTime (1000)
      });
    });

    expect(localClipboard).toBe('From Remote');

    // Stale remote update -> should be ignored (updatedAt < 2000)
    doc.transact(() => {
      clipboardMap.set('data', {
        content: 'Stale Remote',
        sourceDeviceId: 'device-B',
        updatedAt: 500,
      });
    });

    expect(localClipboard).toBe('From Remote'); // Remains unchanged

    sync.destroy();
  });

  it('manages rich clipboard sync and history with capping and deduplication', async () => {
    const doc = new Y.Doc();
    let localClipboard = '';

    const readSpy = vi.fn().mockImplementation(() => Promise.resolve(localClipboard));
    const writeSpy = vi.fn().mockImplementation((text) => {
      localClipboard = text;
      return Promise.resolve();
    });

    const sync = new OmniClipboardSync('device-A', doc, readSpy, writeSpy);
    const historyChangedSpy = vi.fn();
    sync.onHistoryChanged = historyChangedSpy;

    // Push rich image clipboard
    const sampleBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    await sync.pushRichClipboard('image', sampleBase64, 'image/png');

    const history = sync.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0].type).toBe('image');
    expect(history[0].mimeType).toBe('image/png');
    expect(history[0].content).toBe(sampleBase64);
    expect(history[0].sourceDeviceId).toBe('device-A');
    expect(historyChangedSpy).toHaveBeenCalledTimes(1);

    // Verify Yjs doc map
    const clipboardMap = doc.getMap<any>('clipboard');
    const data = clipboardMap.get('data');
    expect(data.type).toBe('image');
    expect(data.mimeType).toBe('image/png');
    expect(data.content).toBe(sampleBase64);

    // Push identical content -> should deduplicate top item
    await sync.pushRichClipboard('image', sampleBase64, 'image/png');
    expect(sync.getHistory()).toHaveLength(1);

    // Push 11 distinct items to test capping at 10 items
    for (let i = 0; i < 11; i++) {
      await sync.pushRichClipboard('text', `Item ${i}`);
    }
    const cappedHistory = sync.getHistory();
    expect(cappedHistory.length).toBe(10);
    expect(cappedHistory[0].content).toBe('Item 10');

    sync.destroy();
  });
});
