import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Y from 'yjs';
import { WindowInstance, OmniMediaTransportManager } from '../src/index.js';

describe('OmniMediaTransportManager', () => {
  let doc: Y.Doc;
  let windowsMap: Y.Map<WindowInstance>;
  let mockRtcManager: any;
  let mockCaptureManager: any;
  let mockPc: any;
  let mockTrack: any;
  let mockStream: any;
  let mockSender: any;

  beforeEach(() => {
    doc = new Y.Doc();
    windowsMap = doc.getMap<WindowInstance>('windows');

    mockSender = { id: 'sender-1' };
    mockTrack = { id: 'track-1', stop: vi.fn() };
    mockStream = {
      id: 'stream-1',
      getVideoTracks: () => [mockTrack],
    };

    mockPc = {
      addTrack: vi.fn().mockReturnValue(mockSender),
      removeTrack: vi.fn(),
    };

    mockRtcManager = {
      localDeviceId: 'device-A',
      getPeerConnection: vi.fn().mockImplementation((peerId) => {
        if (peerId === 'device-B' || peerId === 'device-C') {
          return mockPc;
        }
        return undefined;
      }),
    };

    mockCaptureManager = {
      getLocalStream: vi.fn().mockReturnValue(mockStream),
    };
  });

  it('routes track to remote device when ownership shifts to them', () => {
    const transport = new OmniMediaTransportManager(
      mockRtcManager,
      mockCaptureManager,
      windowsMap
    );

    const win: WindowInstance = {
      id: 'win-1',
      title: 'Real Editor',
      width: 800,
      height: 600,
      x: 0,
      y: 0,
      owningDeviceId: 'device-A', // Start local
      capturingDeviceId: 'device-A',
      hasActiveCapture: true,
      streamId: 'stream-1',
    };

    windowsMap.set(win.id, win);

    // Handoff to device-B
    windowsMap.doc?.transact(() => {
      windowsMap.set(win.id, {
        ...win,
        owningDeviceId: 'device-B',
      });
    });

    expect(mockCaptureManager.getLocalStream).toHaveBeenCalledWith('win-1');
    expect(mockRtcManager.getPeerConnection).toHaveBeenCalledWith('device-B');
    expect(mockPc.addTrack).toHaveBeenCalledWith(mockTrack, mockStream);

    transport.destroy();
  });

  it('removes track from old owner and adds to new owner on subsequent handoff', () => {
    const transport = new OmniMediaTransportManager(
      mockRtcManager,
      mockCaptureManager,
      windowsMap
    );

    const win: WindowInstance = {
      id: 'win-1',
      title: 'Real Editor',
      width: 800,
      height: 600,
      x: 0,
      y: 0,
      owningDeviceId: 'device-B', // Owned by B
      capturingDeviceId: 'device-A',
      hasActiveCapture: true,
      streamId: 'stream-1',
    };

    // Pre-seed window in map
    windowsMap.set(win.id, win);
    mockPc.addTrack.mockClear();
    mockPc.removeTrack.mockClear();

    // Handoff from B to C
    windowsMap.doc?.transact(() => {
      windowsMap.set(win.id, {
        ...win,
        owningDeviceId: 'device-C',
      });
    });

    // Expect removal from B and addition to C
    expect(mockPc.removeTrack).toHaveBeenCalledWith(mockSender);
    expect(mockPc.addTrack).toHaveBeenCalledWith(mockTrack, mockStream);

    transport.destroy();
  });

  it('removes track completely when ownership returns to capturer', () => {
    const transport = new OmniMediaTransportManager(
      mockRtcManager,
      mockCaptureManager,
      windowsMap
    );

    const win: WindowInstance = {
      id: 'win-1',
      title: 'Real Editor',
      width: 800,
      height: 600,
      x: 0,
      y: 0,
      owningDeviceId: 'device-B', // Owned by B
      capturingDeviceId: 'device-A',
      hasActiveCapture: true,
      streamId: 'stream-1',
    };

    windowsMap.set(win.id, win);
    mockPc.addTrack.mockClear();
    mockPc.removeTrack.mockClear();

    // Return ownership to capturer (local device-A)
    windowsMap.doc?.transact(() => {
      windowsMap.set(win.id, {
        ...win,
        owningDeviceId: 'device-A',
      });
    });

    // Expect track removal from B and no further addTrack calls
    expect(mockPc.removeTrack).toHaveBeenCalledWith(mockSender);
    expect(mockPc.addTrack).not.toHaveBeenCalled();

    transport.destroy();
  });

  it('selectively routes tracks in a 3-peer mesh (sends only to display owner, not idle peers)', () => {
    const pcB = {
      addTrack: vi.fn().mockReturnValue({ id: 'sender-B' }),
      removeTrack: vi.fn(),
    };
    const pcC = {
      addTrack: vi.fn().mockReturnValue({ id: 'sender-C' }),
      removeTrack: vi.fn(),
    };

    mockRtcManager.getPeerConnection = vi.fn().mockImplementation((peerId) => {
      if (peerId === 'device-B') return pcB;
      if (peerId === 'device-C') return pcC;
      return undefined;
    });

    const transport = new OmniMediaTransportManager(
      mockRtcManager,
      mockCaptureManager,
      windowsMap
    );

    const win: WindowInstance = {
      id: 'win-1',
      title: 'Real Editor',
      width: 800,
      height: 600,
      x: 0,
      y: 0,
      owningDeviceId: 'device-B', // Owned by B
      capturingDeviceId: 'device-A',
      hasActiveCapture: true,
      streamId: 'stream-1',
    };

    // Pre-seed window in map (should add track to B only)
    windowsMap.set(win.id, win);
    expect(pcB.addTrack).toHaveBeenCalledWith(mockTrack, mockStream);
    // pcC is not the owner, so it shouldn't get the track
    expect(pcC.addTrack).not.toHaveBeenCalled();

    // Clear calls to focus on transition phase
    pcB.addTrack.mockClear();
    pcB.removeTrack.mockClear();
    pcC.addTrack.mockClear();
    pcC.removeTrack.mockClear();

    // Handoff ownership from B to C
    windowsMap.doc?.transact(() => {
      windowsMap.set(win.id, {
        ...win,
        owningDeviceId: 'device-C',
      });
    });

    // Verify old owner B is detached, new owner C is attached
    expect(pcB.removeTrack).toHaveBeenCalledWith({ id: 'sender-B' });
    expect(pcC.addTrack).toHaveBeenCalledWith(mockTrack, mockStream);
    expect(pcB.addTrack).not.toHaveBeenCalled();
    expect(pcC.removeTrack).not.toHaveBeenCalled();

    transport.destroy();
  });
});
