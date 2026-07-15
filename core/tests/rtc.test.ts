import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import { Device, OmniRTCManager } from '../src/index.js';

// Mock global objects
const mockWebSocketSend = vi.fn();
const mockWebSocketClose = vi.fn();

class MockWebSocket {
  public onopen: any = null;
  public onmessage: any = null;
  public onclose: any = null;
  public readyState = 1;

  constructor(public url: string) {
    setTimeout(() => {
      if (this.onopen) this.onopen();
    }, 10);
  }

  send(data: string) {
    mockWebSocketSend(data);
  }

  close() {
    mockWebSocketClose();
  }
}

class MockRTCDataChannel {
  public readyState = 'open';
  public binaryType = 'blob';
  public onopen: any = null;
  public onmessage: any = null;
  public onclose: any = null;

  constructor(public label: string) {
    setTimeout(() => {
      if (this.onopen) this.onopen();
    }, 10);
  }

  send(_payload: any) {}
}

class MockRTCPeerConnection {
  public onicecandidate: any = null;
  public ondatachannel: any = null;
  public localDescription: any = null;
  public remoteDescription: any = null;

  createDataChannel(label: string) {
    return new MockRTCDataChannel(label);
  }

  async createOffer() {
    return { type: 'offer', sdp: 'sdp' };
  }

  async createAnswer() {
    return { type: 'answer', sdp: 'sdp' };
  }

  async setLocalDescription(_desc: any) {
    this.localDescription = _desc;
  }

  async setRemoteDescription(_desc: any) {
    this.remoteDescription = _desc;
  }

  addIceCandidate(_cand: any) {}

  close() {}
}

describe('OmniRTCManager Transport Orchestration', () => {
  let doc: Y.Doc;
  let awareness: awarenessProtocol.Awareness;

  beforeEach(() => {
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('RTCPeerConnection', MockRTCPeerConnection);
    vi.useFakeTimers();

    doc = new Y.Doc();
    awareness = new awarenessProtocol.Awareness(doc);

    // Mock screen properties
    vi.stubGlobal('screen', { width: 1440, height: 900 });
    vi.stubGlobal('devicePixelRatio', 2);
    vi.stubGlobal('navigator', { userAgent: 'MockBrowser' });

    mockWebSocketSend.mockClear();
    mockWebSocketClose.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('gates dimension reporting until all room roster handshakes are resolved', () => {
    const manager = new OmniRTCManager(
      'peer-A',
      'desktop',
      '123456',
      'ws://localhost:3000',
      doc,
      awareness
    );

    manager.connect();
    vi.advanceTimersByTime(20);

    const devicesMap = doc.getMap<Device>('devices');
    expect(devicesMap.has('peer-A')).toBe(false); // Gated

    // Simulate receiving a room-roster snapshot with one existing peer (peer-B)
    const socketInstance = (manager as any).ws;
    socketInstance.onmessage({
      data: JSON.stringify({
        type: 'room-roster',
        senderPeerId: 'server',
        payload: { peers: ['peer-A', 'peer-B'] },
      }),
    });

    vi.advanceTimersByTime(20);
    // Still gated because handshake with peer-B is pending
    expect(devicesMap.has('peer-A')).toBe(false);

    // Simulate peer-B completing state vector sync handshake
    const peerConnectionState = (manager as any).peerConnections.get('peer-B');
    expect(peerConnectionState).toBeDefined();

    // Trigger MSG_DOC_DIFF callback manually on B's data channel
    const emptyUpdate = Y.encodeStateAsUpdate(new Y.Doc());
    const msgDiff = new Uint8Array(emptyUpdate.length + 1);
    msgDiff[0] = 2; // MSG_DOC_DIFF
    msgDiff.set(emptyUpdate, 1);
    peerConnectionState.docChannel.onmessage({ data: msgDiff.buffer });

    // Handshake complete, dimension reported
    expect(devicesMap.has('peer-A')).toBe(true);
    expect(devicesMap.get('peer-A')?.status).toBe('connected');
    
    manager.destroy();
  });

  it('unblocks dimension reporting after the 10-second timeout fallback if peers lag', () => {
    const manager = new OmniRTCManager(
      'peer-A',
      'desktop',
      '123456',
      'ws://localhost:3000',
      doc,
      awareness
    );

    manager.connect();
    vi.advanceTimersByTime(20);

    const socketInstance = (manager as any).ws;
    socketInstance.onmessage({
      data: JSON.stringify({
        type: 'room-roster',
        senderPeerId: 'server',
        payload: { peers: ['peer-A', 'peer-B'] }, // peer-B is unresponsive
      }),
    });

    const devicesMap = doc.getMap<Device>('devices');
    expect(devicesMap.has('peer-A')).toBe(false);

    // Fast-forward past the 10s timeout gate
    vi.advanceTimersByTime(10005);

    // Should bypass peer-B and write anyway
    expect(devicesMap.has('peer-A')).toBe(true);
    expect(devicesMap.get('peer-A')?.status).toBe('connected');

    manager.destroy();
  });

  it('performs merge writes instead of full replacements, preserving coordinates', () => {
    const manager = new OmniRTCManager(
      'peer-A',
      'desktop',
      '123456',
      'ws://localhost:3000',
      doc,
      awareness
    );

    const devicesMap = doc.getMap<Device>('devices');
    
    // Set pre-calibrated coordinates in Yjs
    devicesMap.set('peer-A', {
      id: 'peer-A',
      name: 'OldName',
      width: 800,
      height: 600,
      dpiScale: 1,
      x: 100, // Calibrated X
      y: 200, // Calibrated Y
      status: 'disconnected',
      type: 'desktop',
    });

    // Run connection and unblock
    manager.connect();
    vi.advanceTimersByTime(20);

    // Empty roster -> immediate write
    const socketInstance = (manager as any).ws;
    socketInstance.onmessage({
      data: JSON.stringify({
        type: 'room-roster',
        senderPeerId: 'server',
        payload: { peers: ['peer-A'] },
      }),
    });

    vi.advanceTimersByTime(20);

    const self = devicesMap.get('peer-A');
    expect(self?.status).toBe('connected');
    expect(self?.x).toBe(100); // Intact!
    expect(self?.y).toBe(200); // Intact!
    expect(self?.width).toBe(1440); // Updated screen bounds
    
    manager.destroy();
  });

  it('resiliently schedules grace timers on coordinator startup or transition', () => {
    // Register A and B in Yjs. B is disconnected.
    const devicesMap = doc.getMap<Device>('devices');
    devicesMap.set('peer-A', {
      id: 'peer-A',
      name: 'A',
      width: 800,
      height: 600,
      dpiScale: 1,
      x: 0,
      y: 0,
      status: 'connected',
      type: 'desktop',
    });

    const now = Date.now();
    devicesMap.set('peer-B', {
      id: 'peer-B',
      name: 'B',
      width: 800,
      height: 600,
      dpiScale: 1,
      x: 1000,
      y: 0,
      status: 'disconnected',
      disconnectedAt: now - 30000, // Disconnected 30 seconds ago (90 seconds remaining)
      type: 'mobile',
    });

    // Start manager for A. Since A is lexicographically lowest ('peer-A' < 'peer-B'), A is coordinator.
    const manager = new OmniRTCManager(
      'peer-A',
      'desktop',
      '123456',
      'ws://localhost:3000',
      doc,
      awareness
    );

    // Trigger connection so it binds to doc
    manager.connect();
    
    // Force evaluate coordinator grace-check loop
    (manager as any).recheckGracePeriods();

    // Verify timer scheduled. Check that B is still in map after 45s.
    vi.advanceTimersByTime(45000);
    expect(devicesMap.has('peer-B')).toBe(true);

    // Fast-forward another 50s (95s total, exceeding the 90s remaining)
    vi.advanceTimersByTime(50000);
    expect(devicesMap.has('peer-B')).toBe(false); // Deleted!

    manager.destroy();
  });
});
