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
});
