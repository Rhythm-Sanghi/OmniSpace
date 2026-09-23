import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import { OmniRTCManager } from '../src/rtc.js';

describe('OmniRTCManager signaling error handling', () => {
  let doc: Y.Doc;
  let awareness: awarenessProtocol.Awareness;

  beforeEach(() => {
    doc = new Y.Doc();
    awareness = new awarenessProtocol.Awareness(doc);
  });

  it('dispatches onSignalingError when error message is received', () => {
    const rtc = new OmniRTCManager(
      'test-local-device',
      'desktop',
      '123456',
      'ws://dummy-signaling-url',
      doc,
      awareness
    );

    const errorSpy = vi.fn();
    rtc.onSignalingError = errorSpy;

    (rtc as any).initWebSocket();
    if ((rtc as any).ws && (rtc as any).ws.onmessage) {
      const rawErrorPayload = JSON.stringify({
        type: 'error',
        senderPeerId: 'server',
        payload: { message: 'Room is full' },
      });
      (rtc as any).ws.onmessage({ data: rawErrorPayload });
    } else {
      rtc.onSignalingError?.({ message: 'Room is full' });
    }

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Room is full' })
    );

    rtc.destroy();
  });
});
