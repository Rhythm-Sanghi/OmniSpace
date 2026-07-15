import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import { Device, WindowInstance, SignalingPayload } from './types.js';
import { reassignDisconnectedDeviceWindows } from './handoffEngine.js';

// Message types prefix for binary data channel multiplexing
export const MSG_DOC_UPDATE = 0;
export const MSG_STATE_VECTOR = 1;
export const MSG_DOC_DIFF = 2;
export const MSG_AWARENESS = 3;
export const MSG_PING = 4;
export const MSG_PONG = 5;
export const MSG_QUALITY_FEEDBACK = 6;
import { MSG_MOUSE_INPUT, MSG_KEYBOARD_INPUT } from './inputProtocol.js';

// Define a type for Vite env to prevent compile errors
declare global {
  interface Window {
    debugIgnorePeerIds?: string[];
  }
}

export class OmniRTCManager {
  private ws: WebSocket | null = null;
  private peerConnections: Map<
    string,
    {
      pc: RTCPeerConnection;
      docChannel: RTCDataChannel;
      awarenessChannel: RTCDataChannel;
      missedPings: number;
      pingInterval?: any;
      handshakeResolved: boolean;
    }
  > = new Map();

  private pendingHandshakes: Set<string> = new Set();
  private handshakeTimer: any = null;
  private graceTimers: Map<string, any> = new Map();
  private isDestroyed = false;
  private iceServers: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  public onRemoteTrackReceived?: (peerId: string, stream: MediaStream) => void;
  public onQualityFeedbackReceived?: (
    peerId: string,
    feedback: { windowId: string; maxBitrate?: number; maxFramerate?: number }
  ) => void;
  public onMouseInputReceived?: (peerId: string, event: any) => void;
  public onKeyboardInputReceived?: (peerId: string, event: any) => void;

  constructor(
    public readonly localDeviceId: string,
    public readonly deviceType: 'desktop' | 'mobile',
    public readonly roomPin: string,
    public readonly signalingUrl: string,
    public readonly doc: Y.Doc,
    public readonly awareness: awarenessProtocol.Awareness
  ) {
    // Bind Yjs Doc updates to transmit over WebRTC doc data channels
    this.doc.on('update', (update: Uint8Array, origin: any) => {
      if (origin !== 'remote') {
        const payload = new Uint8Array(update.length + 1);
        payload[0] = MSG_DOC_UPDATE;
        payload.set(update, 1);
        this.broadcastDocChannel(payload);
      }
    });

    // Bind Yjs Awareness updates
    this.awareness.on('update', ({ added, updated, removed }: any) => {
      const changedClients = [...added, ...updated, ...removed];
      if (changedClients.length > 0) {
        const update = awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients);
        const payload = new Uint8Array(update.length + 1);
        payload[0] = MSG_AWARENESS;
        payload.set(update, 1);
        this.broadcastAwarenessChannel(payload);
      }
    });

    // Setup periodic coordinator grace check interval
    setInterval(() => {
      if (this.isDestroyed) return;
      this.recheckGracePeriods();
    }, 5000);
  }

  public connect() {
    fetch(
      'https://flash-speaker.metered.live/api/v1/turn/credentials?apiKey=e1f1ec7096e60451ff79174eba025c2ecd46'
    )
      .then((response) => {
        if (!response.ok) return null;
        return response.json();
      })
      .then((credentials) => {
        if (Array.isArray(credentials) && credentials.length > 0) {
          this.iceServers = credentials;
        }
      })
      .catch((err) => {
        console.warn('Failed to fetch dynamic TURN credentials, using default STUN:', err);
      });

    this.ws = new WebSocket(this.signalingUrl);

    this.ws.onopen = () => {
      this.ws?.send(
        JSON.stringify({
          type: 'join-room',
          senderPeerId: this.localDeviceId,
          payload: { roomPin: this.roomPin },
        })
      );
    };

    this.ws.onmessage = async (event) => {
      const msg: SignalingPayload = JSON.parse(event.data);

      // Dev-only test seam check (Vite strips this in production dead-code elimination)
      if ((import.meta as any).env?.DEV && typeof window !== 'undefined' && window.debugIgnorePeerIds?.includes(msg.senderPeerId)) {
        return;
      }

      switch (msg.type) {
        case 'room-roster':
          this.handleRoomRoster(msg.payload.peers);
          break;
        case 'peer-joined':
          // Existing peer expects a connection but does not initiate (glare resolution)
          this.handlePeerJoined(msg.payload.peerId);
          break;
        case 'peer-left':
          this.handlePeerLeft(msg.payload.peerId);
          break;
        case 'offer':
          this.handleOffer(msg.senderPeerId, msg.payload.offer);
          break;
        case 'answer':
          this.handleAnswer(msg.senderPeerId, msg.payload.answer);
          break;
        case 'ice-candidate':
          this.handleIceCandidate(msg.senderPeerId, msg.payload.candidate);
          break;
      }
    };

    this.ws.onclose = () => {
      if (!this.isDestroyed) {
        // Reconnect after 3s delay
        setTimeout(() => this.connect(), 3000);
      }
    };
  }

  private handleRoomRoster(peers: string[]) {
    // The newly joined peer always initiates offers to existing peers in the roster snapshot
    const activePeers = peers.filter((p) => p !== this.localDeviceId);

    if (activePeers.length === 0) {
      // Empty roster trivially satisfies handshake and writes dimensions immediately
      this.reportDimensions();
      return;
    }

    // Set up handshake gating for all peers in the roster
    activePeers.forEach((peerId) => {
      this.pendingHandshakes.add(peerId);
      this.initiateConnection(peerId);
    });

    // Setup 10-second timeout to unblock dimension reporting if a peer fails to connect
    this.handshakeTimer = setTimeout(() => {
      if (this.pendingHandshakes.size > 0) {
        this.pendingHandshakes.clear();
        this.reportDimensions();
      }
    }, 10000);
  }

  private handlePeerJoined(peerId: string) {
    // Existing peer: clean up old stale connections if they exist before receiving new offer
    this.closePeerConnection(peerId);
  }

  private handlePeerLeft(peerId: string) {
    this.closePeerConnection(peerId);
    this.pendingHandshakes.delete(peerId);
    this.checkHandshakesComplete();
    this.pruneDisconnectedPeer(peerId);
  }

  private closePeerConnection(peerId: string) {
    const peer = this.peerConnections.get(peerId);
    if (peer) {
      clearInterval(peer.pingInterval);
      peer.pc.close();
      this.peerConnections.delete(peerId);
    }
  }

  private async initiateConnection(targetPeerId: string) {
    // Initiator disposal of previous connections
    this.closePeerConnection(targetPeerId);

    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
    });

    // Create reliable/ordered data channel for Yjs
    const docChannel = pc.createDataChannel('omni-doc', {
      ordered: true,
    });

    // Create unreliable/unordered data channel for cursors
    const awarenessChannel = pc.createDataChannel('omni-awareness', {
      ordered: false,
      maxRetransmits: 0,
    });

    this.peerConnections.set(targetPeerId, {
      pc,
      docChannel,
      awarenessChannel,
      missedPings: 0,
      handshakeResolved: false,
    });

    this.setupDataChannelListeners(docChannel, awarenessChannel, targetPeerId);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.ws?.send(
          JSON.stringify({
            type: 'ice-candidate',
            senderPeerId: this.localDeviceId,
            targetPeerId,
            payload: { candidate: event.candidate },
          })
        );
      }
    };

    pc.onnegotiationneeded = async () => {
      try {
        const offer = await pc.createOffer();
        const mungedOffer = prioritizeHardwareCodecs(offer);
        await pc.setLocalDescription(mungedOffer);
        this.ws?.send(
          JSON.stringify({
            type: 'offer',
            senderPeerId: this.localDeviceId,
            targetPeerId,
            payload: { offer: mungedOffer },
          })
        );
      } catch (err) {
        console.error('Renegotiation offer error:', err);
      }
    };

    pc.ontrack = (event) => {
      if (this.onRemoteTrackReceived && event.streams[0]) {
        this.onRemoteTrackReceived(targetPeerId, event.streams[0]);
      }
    };

    const offer = await pc.createOffer();
    const mungedOffer = prioritizeHardwareCodecs(offer);
    await pc.setLocalDescription(mungedOffer);

    this.ws?.send(
      JSON.stringify({
        type: 'offer',
        senderPeerId: this.localDeviceId,
        targetPeerId,
        payload: { offer: mungedOffer },
      })
    );
  }

  private async handleOffer(senderPeerId: string, offer: any) {
    // Callee disposal of old connection
    this.closePeerConnection(senderPeerId);

    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
    });

    const peerState = {
      pc,
      docChannel: null as any,
      awarenessChannel: null as any,
      missedPings: 0,
      handshakeResolved: false,
    };
    this.peerConnections.set(senderPeerId, peerState);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.ws?.send(
          JSON.stringify({
            type: 'ice-candidate',
            senderPeerId: this.localDeviceId,
            targetPeerId: senderPeerId,
            payload: { candidate: event.candidate },
          })
        );
      }
    };

    pc.onnegotiationneeded = async () => {
      try {
        const offer = await pc.createOffer();
        const mungedOffer = prioritizeHardwareCodecs(offer);
        await pc.setLocalDescription(mungedOffer);
        this.ws?.send(
          JSON.stringify({
            type: 'offer',
            senderPeerId: this.localDeviceId,
            targetPeerId: senderPeerId,
            payload: { offer: mungedOffer },
          })
        );
      } catch (err) {
        console.error('Renegotiation offer error:', err);
      }
    };

    pc.ontrack = (event) => {
      if (this.onRemoteTrackReceived && event.streams[0]) {
        this.onRemoteTrackReceived(senderPeerId, event.streams[0]);
      }
    };

    pc.ondatachannel = (event) => {
      const channel = event.channel;
      if (channel.label === 'omni-doc') {
        peerState.docChannel = channel;
      } else if (channel.label === 'omni-awareness') {
        peerState.awarenessChannel = channel;
      }

      if (peerState.docChannel && peerState.awarenessChannel) {
        this.setupDataChannelListeners(
          peerState.docChannel,
          peerState.awarenessChannel,
          senderPeerId
        );
      }
    };

    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    const mungedAnswer = prioritizeHardwareCodecs(answer);
    await pc.setLocalDescription(mungedAnswer);

    this.ws?.send(
      JSON.stringify({
        type: 'answer',
        senderPeerId: this.localDeviceId,
        targetPeerId: senderPeerId,
        payload: { answer: mungedAnswer },
      })
    );
  }

  private async handleAnswer(senderPeerId: string, answer: any) {
    const peer = this.peerConnections.get(senderPeerId);
    if (peer) {
      await peer.pc.setRemoteDescription(new RTCSessionDescription(answer));
    }
  }

  private handleIceCandidate(senderPeerId: string, candidate: any) {
    const peer = this.peerConnections.get(senderPeerId);
    if (peer) {
      peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
  }

  private setupDataChannelListeners(
    docChannel: RTCDataChannel,
    awarenessChannel: RTCDataChannel,
    peerId: string
  ) {
    // 1. Setup Document Sync Channel
    docChannel.binaryType = 'arraybuffer';
    docChannel.onopen = () => {
      // Trigger initial Yjs state-vector request diff sync handshake
      const stateVector = Y.encodeStateVector(this.doc);
      const payload = new Uint8Array(stateVector.length + 1);
      payload[0] = MSG_STATE_VECTOR;
      payload.set(stateVector, 1);
      docChannel.send(payload);

      // Start ping/pong heartbeat pings every 3s
      const peer = this.peerConnections.get(peerId);
      if (peer) {
        peer.pingInterval = setInterval(() => this.sendPing(peerId), 3000);
      }
    };

    docChannel.onmessage = (event) => {
      const buffer = new Uint8Array(event.data);
      const msgType = buffer[0];
      const payload = buffer.subarray(1);

      switch (msgType) {
        case MSG_STATE_VECTOR: {
          const diff = Y.encodeStateAsUpdate(this.doc, payload);
          const response = new Uint8Array(diff.length + 1);
          response[0] = MSG_DOC_DIFF;
          response.set(diff, 1);
          docChannel.send(response);
          break;
        }
        case MSG_DOC_DIFF:
        case MSG_DOC_UPDATE: {
          Y.applyUpdate(this.doc, payload, 'remote');
          if (msgType === MSG_DOC_DIFF) {
            // Handshake resolved for this peer
            const peer = this.peerConnections.get(peerId);
            if (peer) {
              peer.handshakeResolved = true;
              this.pendingHandshakes.delete(peerId);
              this.checkHandshakesComplete();
            }
          }
          break;
        }
        case MSG_PING: {
          const pong = new Uint8Array(1);
          pong[0] = MSG_PONG;
          docChannel.send(pong);
          break;
        }
        case MSG_PONG: {
          const peer = this.peerConnections.get(peerId);
          if (peer) {
            peer.missedPings = 0;
          }
          break;
        }
        case MSG_QUALITY_FEEDBACK: {
          try {
            const text = new TextDecoder().decode(payload);
            const feedback = JSON.parse(text);
            if (this.onQualityFeedbackReceived) {
              this.onQualityFeedbackReceived(peerId, feedback);
            }
          } catch (err) {
            console.error('Failed to parse quality feedback packet:', err);
          }
          break;
        }
        case MSG_KEYBOARD_INPUT: {
          try {
            const text = new TextDecoder().decode(payload);
            const envelope = JSON.parse(text);
            if (this.onKeyboardInputReceived) {
              this.onKeyboardInputReceived(peerId, envelope);
            }
          } catch (err) {
            console.error('Failed to parse keyboard input packet:', err);
          }
          break;
        }
      }
    };

    docChannel.onclose = () => {
      this.handlePeerLeft(peerId);
    };

    // 2. Setup Awareness Channel
    awarenessChannel.binaryType = 'arraybuffer';
    awarenessChannel.onopen = () => {
      // Sync initial awareness presence status
      const state = awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.awareness.clientID]);
      const payload = new Uint8Array(state.length + 1);
      payload[0] = MSG_AWARENESS;
      payload.set(state, 1);
      awarenessChannel.send(payload);
    };

    awarenessChannel.onmessage = (event) => {
      const buffer = new Uint8Array(event.data);
      const msgType = buffer[0];
      const payload = buffer.subarray(1);

      if (msgType === MSG_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(this.awareness, payload, 'remote');
      } else if (msgType === MSG_MOUSE_INPUT) {
        try {
          const text = new TextDecoder().decode(payload);
          const envelope = JSON.parse(text);
          if (this.onMouseInputReceived) {
            this.onMouseInputReceived(peerId, envelope);
          }
        } catch (err) {
          console.error('Failed to parse mouse input packet:', err);
        }
      }
    };
  }

  public sendMouseInput(targetPeerId: string, envelope: any) {
    const peer = this.peerConnections.get(targetPeerId);
    if (!peer || peer.awarenessChannel.readyState !== 'open') return;

    const text = JSON.stringify(envelope);
    const textBytes = new TextEncoder().encode(text);
    const payload = new Uint8Array(textBytes.length + 1);
    payload[0] = MSG_MOUSE_INPUT;
    payload.set(textBytes, 1);

    peer.awarenessChannel.send(payload);
  }

  public sendKeyboardInput(targetPeerId: string, envelope: any) {
    const peer = this.peerConnections.get(targetPeerId);
    if (!peer || peer.docChannel.readyState !== 'open') return;

    const text = JSON.stringify(envelope);
    const textBytes = new TextEncoder().encode(text);
    const payload = new Uint8Array(textBytes.length + 1);
    payload[0] = MSG_KEYBOARD_INPUT;
    payload.set(textBytes, 1);

    peer.docChannel.send(payload);
  }

  private sendPing(peerId: string) {
    const peer = this.peerConnections.get(peerId);
    if (!peer) return;

    if (peer.missedPings >= 3) {
      // Heartbeat timeout: declare offline
      this.handlePeerLeft(peerId);
      return;
    }

    peer.missedPings++;
    const ping = new Uint8Array(1);
    ping[0] = MSG_PING;
    if (peer.docChannel.readyState === 'open') {
      peer.docChannel.send(ping);
    }
  }

  private checkHandshakesComplete() {
    if (this.pendingHandshakes.size === 0) {
      if (this.handshakeTimer) {
        clearTimeout(this.handshakeTimer);
        this.handshakeTimer = null;
      }
      this.reportDimensions();
    }
  }

  private reportDimensions() {
    const devicesMap = this.doc.getMap<Device>('devices');

    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : 'NodeDevice';
    const sWidth = typeof window !== 'undefined' && window.screen ? window.screen.width : (typeof screen !== 'undefined' ? screen.width : 1920);
    const sHeight = typeof window !== 'undefined' && window.screen ? window.screen.height : (typeof screen !== 'undefined' ? screen.height : 1080);
    const sDpi = typeof window !== 'undefined' ? window.devicePixelRatio : 1;

    this.doc.transact(() => {
      const existing = devicesMap.get(this.localDeviceId);
      if (existing) {
        // Merge - preserve positions
        devicesMap.set(this.localDeviceId, {
          ...existing,
          name: ua,
          width: sWidth,
          height: sHeight,
          dpiScale: sDpi,
          status: 'connected',
          disconnectedAt: undefined,
        });
      } else {
        // Create new
        devicesMap.set(this.localDeviceId, {
          id: this.localDeviceId,
          name: ua,
          width: sWidth,
          height: sHeight,
          dpiScale: sDpi,
          x: 0,
          y: 0,
          status: 'connected',
          type: this.deviceType,
        });
      }
    });
  }

  private pruneDisconnectedPeer(peerId: string) {
    // 1. Instant awareness cleanup
    // Find all clientIds associated with this deviceId in awareness states
    const states = this.awareness.getStates();
    const clientIdsToPrune: number[] = [];
    for (const [clientId, state] of states.entries()) {
      if (state.user?.deviceId === peerId || state.deviceId === peerId) {
        clientIdsToPrune.push(clientId);
      }
    }
    if (clientIdsToPrune.length > 0) {
      awarenessProtocol.removeAwarenessStates(this.awareness, clientIdsToPrune, 'disconnect');
    }

    // 2. Evaluate coordinator cleanup role
    this.evaluateCoordinator(peerId);
  }

  private evaluateCoordinator(disconnectedPeerId?: string) {
    const devicesMap = this.doc.getMap<Device>('devices');
    const devices = Array.from(devicesMap.values());
    const activePeers = devices.filter((d) => d.status === 'connected' && d.id !== disconnectedPeerId);

    if (activePeers.length === 0) return;

    // Sort active peers lexicographically to find the coordinator
    const sorted = [...activePeers].sort((a, b) => a.id.localeCompare(b.id));
    const coordinator = sorted[0];

    // Strictly write only if this client is the coordinator
    if (coordinator.id === this.localDeviceId) {
      this.doc.transact(() => {
        // Mark disconnected device
        if (disconnectedPeerId) {
          const dev = devicesMap.get(disconnectedPeerId);
          if (dev && dev.status === 'connected') {
            devicesMap.set(disconnectedPeerId, {
              ...dev,
              status: 'disconnected',
              disconnectedAt: Date.now(),
            });

            // Reassign windows
            reassignDisconnectedDeviceWindows(disconnectedPeerId, devicesMap, this.doc.getMap<WindowInstance>('windows'));
          }
        }

        // Resiliently schedule/evaluate all grace window timers
        this.recheckGracePeriods();
      });
    }
  }

  private recheckGracePeriods() {
    // Coordinator check only
    const devicesMap = this.doc.getMap<Device>('devices');
    const devices = Array.from(devicesMap.values());
    const activePeers = devices.filter((d) => d.status === 'connected');
    if (activePeers.length === 0) return;

    const sorted = [...activePeers].sort((a, b) => a.id.localeCompare(b.id));
    if (sorted[0].id !== this.localDeviceId) {
      // Not coordinator, cancel any local grace timers we hold
      this.graceTimers.forEach((timer) => clearTimeout(timer));
      this.graceTimers.clear();
      return;
    }

    const now = Date.now();
    devices.forEach((dev) => {
      if (dev.status !== 'disconnected' || !dev.disconnectedAt) {
        if (this.graceTimers.has(dev.id)) {
          clearTimeout(this.graceTimers.get(dev.id));
          this.graceTimers.delete(dev.id);
        }
        return;
      }

      const elapsed = now - dev.disconnectedAt;
      if (elapsed >= 120000) {
        // Grace period expired: prune
        devicesMap.delete(dev.id);
        if (this.graceTimers.has(dev.id)) {
          clearTimeout(this.graceTimers.get(dev.id));
          this.graceTimers.delete(dev.id);
        }
      } else if (!this.graceTimers.has(dev.id)) {
        // Schedule remaining grace window timeout
        const remaining = 120000 - elapsed;
        const timer = setTimeout(() => {
          this.doc.transact(() => {
            devicesMap.delete(dev.id);
          });
          this.graceTimers.delete(dev.id);
        }, remaining);
        this.graceTimers.set(dev.id, timer);
      }
    });
  }

  private broadcastDocChannel(payload: Uint8Array) {
    this.peerConnections.forEach((peer) => {
      if (peer.docChannel.readyState === 'open') {
        peer.docChannel.send(payload as any);
      }
    });
  }

  private broadcastAwarenessChannel(payload: Uint8Array) {
    this.peerConnections.forEach((peer) => {
      if (peer.awarenessChannel.readyState === 'open') {
        peer.awarenessChannel.send(payload as any);
      }
    });
  }

  public destroy() {
    this.isDestroyed = true;
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.graceTimers.forEach((timer) => clearTimeout(timer));
    this.graceTimers.clear();
    this.peerConnections.forEach((peer) => {
      clearInterval(peer.pingInterval);
      peer.pc.close();
    });
    this.peerConnections.clear();
    this.ws?.close();
  }

  public sendQualityFeedback(
    peerId: string,
    feedback: { windowId: string; maxBitrate?: number; maxFramerate?: number }
  ) {
    const peer = this.peerConnections.get(peerId);
    if (peer && peer.docChannel.readyState === 'open') {
      const text = JSON.stringify(feedback);
      const packet = new TextEncoder().encode(text);
      const payload = new Uint8Array(packet.length + 1);
      payload[0] = MSG_QUALITY_FEEDBACK;
      payload.set(packet, 1);
      peer.docChannel.send(payload as any);
    }
  }

  public getPeerConnection(peerId: string): RTCPeerConnection | undefined {
    return this.peerConnections.get(peerId)?.pc;
  }
}

function prioritizeHardwareCodecs(desc: RTCSessionDescriptionInit): RTCSessionDescriptionInit {
  if (!desc.sdp) return desc;

  const lines = desc.sdp.split('\r\n');
  let videoLineIdx = -1;
  const hardwarePayloads: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('m=video ')) {
      videoLineIdx = i;
    }
    if (line.startsWith('a=rtpmap:')) {
      const match = line.match(/^a=rtpmap:(\d+)\s+(H264|H265|AV1)\//i);
      if (match) {
        hardwarePayloads.push(match[1]);
      }
    }
  }

  if (videoLineIdx !== -1 && hardwarePayloads.length > 0) {
    const parts = lines[videoLineIdx].split(' ');
    const header = parts.slice(0, 3);
    const payloads = parts.slice(3);

    const prioritized = payloads.filter(p => hardwarePayloads.includes(p));
    const remaining = payloads.filter(p => !hardwarePayloads.includes(p));
    const newPayloads = [...prioritized, ...remaining];

    lines[videoLineIdx] = [...header, ...newPayloads].join(' ');
  }

  return {
    type: desc.type,
    sdp: lines.join('\r\n'),
  };
}
