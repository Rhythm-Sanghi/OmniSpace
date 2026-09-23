import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import { Device, WindowInstance, SignalingPayload } from './types.js';
import { reassignDisconnectedDeviceWindows } from './handoffEngine.js';
import {
  MSG_MOUSE_INPUT,
  MSG_KEYBOARD_INPUT,
  MSG_FILE_TRANSFER,
  isValidInputEventEnvelope,
  isValidQualityFeedback,
  isValidFileTransferPayload,
  InputEventEnvelope,
  QualityFeedback,
} from './inputProtocol.js';
import {
  FileTransferSender,
  FileTransferReceiver,
  TransferProgress,
  ReceivedFile,
} from './fileTransfer.js';

// Message types prefix for binary data channel multiplexing
export const MSG_DOC_UPDATE = 0;
export const MSG_STATE_VECTOR = 1;
export const MSG_DOC_DIFF = 2;
export const MSG_AWARENESS = 3;
export const MSG_PING = 4;
export const MSG_PONG = 5;
export const MSG_QUALITY_FEEDBACK = 6;
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

export { MSG_MOUSE_INPUT, MSG_KEYBOARD_INPUT, MSG_FILE_TRANSFER };

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
      docChannel: RTCDataChannel | null;
      awarenessChannel: RTCDataChannel | null;
      missedPings: number;
      pingInterval?: ReturnType<typeof setInterval>;
      handshakeResolved: boolean;
      candidateQueue: RTCIceCandidateInit[];
      isMakingOffer: boolean;
    }
  > = new Map();

  private pendingHandshakes: Set<string> = new Set();
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private graceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private graceCheckInterval: ReturnType<typeof setInterval> | null = null;
  private isDestroyed = false;
  private isConnecting = false;
  private sessionToken: string | null = null;
  private iceServers: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];
  private iceServersPromise: Promise<void> | null = null;
  private docUpdateListener: (update: Uint8Array, origin: any) => void;
  private awarenessUpdateListener: (args: any) => void;

  public onRemoteTrackReceived?: (peerId: string, stream: MediaStream) => void;
  public onRemoteTrackRemoved?: (peerId: string, streamId: string) => void;
  public onQualityFeedbackReceived?: (
    peerId: string,
    feedback: QualityFeedback
  ) => void;
  public onMouseInputReceived?: (peerId: string, envelope: InputEventEnvelope) => void;
  public onKeyboardInputReceived?: (peerId: string, envelope: InputEventEnvelope) => void;
  public onSignalingError?: (error: { message: string }) => void;
  public onFileTransferProgress?: (peerId: string, progress: TransferProgress) => void;
  public onFileReceived?: (peerId: string, file: ReceivedFile) => void;
  public onFileTransferAbort?: (peerId: string, transferId: string, reason?: string) => void;

  private fileReceiver = new FileTransferReceiver();
  private fileSender = new FileTransferSender();

  constructor(
    public readonly localDeviceId: string,
    public readonly deviceType: 'desktop' | 'mobile',
    public readonly roomPin: string,
    public readonly signalingUrl: string,
    public readonly doc: Y.Doc,
    public readonly awareness: awarenessProtocol.Awareness
  ) {
    this.docUpdateListener = (update: Uint8Array, origin: any) => {
      // Avoid echo loops: don't broadcast updates that came from remote peers
      if (origin !== 'remote' && origin !== 'handshake-sync') {
        const payload = new Uint8Array(update.length + 1);
        payload[0] = MSG_DOC_UPDATE;
        payload.set(update, 1);
        this.broadcastDocChannel(payload);
      }
    };
    this.doc.on('update', this.docUpdateListener);

    this.awarenessUpdateListener = ({ added, updated, removed }: any) => {
      const changedClients = [...added, ...updated, ...removed];
      const update = awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients);
      const payload = new Uint8Array(update.length + 1);
      payload[0] = MSG_AWARENESS;
      payload.set(update, 1);
      this.broadcastAwarenessChannel(payload);
    };
    this.awareness.on('update', this.awarenessUpdateListener);

    // Initial check for any devices currently disconnected with un-expired grace windows
    this.recheckGracePeriods();

    // Check periodically for grace period expiry
    this.graceCheckInterval = setInterval(() => {
      if (this.isDestroyed) return;
      this.recheckGracePeriods();
    }, 5000);
  }

  /**
   * Connects to signaling server and resolves dynamic TURN credentials.
   */
  public connect(): void {
    if (this.isDestroyed || this.isConnecting) return;
    this.isConnecting = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Start dynamic TURN configuration retrieval
    this.iceServersPromise = this.initIceServers().catch((err) => {
      console.warn('[RTC] Failed to initialize dynamic TURN servers, falling back to default STUN:', err);
    }).finally(() => {
      this.isConnecting = false;
    });

    if (this.isDestroyed) {
      this.isConnecting = false;
      return;
    }

    this.initWebSocket();
  }

  private async initIceServers(): Promise<void> {
    // In test environments where WebSocket or RTCPeerConnection is mocked, do not perform unmocked HTTP fetch
    if (typeof process !== 'undefined' && process.env && process.env.NODE_ENV === 'test') {
      return;
    }

    // Resolve HTTP relay URL from signaling WebSocket URL (e.g. ws://host:port -> http://host:port/api/turn-credentials)
    let relayUrl: string | null = null;
    try {
      const wsUrl = new URL(this.signalingUrl);
      const httpProtocol = wsUrl.protocol === 'wss:' ? 'https:' : 'http:';
      relayUrl = `${httpProtocol}//${wsUrl.host}/api/turn-credentials`;
    } catch {
      relayUrl = null;
    }

    if (relayUrl && typeof fetch === 'function') {
      try {
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timeoutId = controller ? setTimeout(() => controller.abort(), 4000) : null;

        const res = await fetch(relayUrl, {
          signal: controller ? controller.signal : undefined,
        });

        if (timeoutId) clearTimeout(timeoutId);

        if (res.ok) {
          const data = await res.json();
          if (data && Array.isArray(data.iceServers) && data.iceServers.length > 0) {
            this.iceServers = data.iceServers;
            return;
          }
        }
      } catch (err: any) {
        console.debug('[RTC] Signaling server TURN relay query did not complete, using defaults:', err?.message || err);
      }
    }
  }

  private reconnectAttempts = 0;

  private initWebSocket() {
    if (this.isDestroyed) return;

    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Socket already closed
      }
      this.ws = null;
    }

    this.ws = new WebSocket(this.signalingUrl);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.ws?.send(
        JSON.stringify({
          type: 'join-room',
          senderPeerId: this.localDeviceId,
          payload: { roomPin: this.roomPin, sessionToken: this.sessionToken },
        })
      );
    };

    this.ws.onmessage = async (event) => {
      let msg: SignalingPayload;
      try {
        msg = JSON.parse(event.data);
      } catch (err) {
        console.error('[RTC] Malformed signaling payload:', err);
        return;
      }

      // Dev-only test seam check (Vite strips this in production dead-code elimination)
      if ((import.meta as any).env?.DEV && typeof window !== 'undefined' && window.debugIgnorePeerIds?.includes(msg.senderPeerId)) {
        return;
      }

      switch (msg.type) {
        case 'room-roster':
          if (msg.payload && (msg.payload as any).sessionToken) {
            this.sessionToken = (msg.payload as any).sessionToken;
          }
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
        case 'error':
          console.error('[RTC] Signaling server error:', msg.payload?.message || msg.payload);
          this.onSignalingError?.(msg.payload || { message: 'Unknown signaling error' });
          break;
      }
    };

    this.ws.onclose = () => {
      if (!this.isDestroyed) {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        // Jittered exponential backoff
        const baseDelay = 1000;
        const maxDelay = 30000;
        const factor = 1.5;
        const expDelay = Math.min(maxDelay, baseDelay * Math.pow(factor, this.reconnectAttempts));
        const jitter = (Math.random() - 0.5) * 500;
        const delay = Math.max(baseDelay, Math.floor(expDelay + jitter));
        this.reconnectAttempts++;

        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          if (!this.isDestroyed) {
            this.connect();
          }
        }, delay);
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
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
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
    if (this.isDestroyed) return;
    this.closePeerConnection(peerId);
    this.pendingHandshakes.delete(peerId);
    this.checkHandshakesComplete();
    this.pruneDisconnectedPeer(peerId);
  }

  private closePeerConnection(peerId: string) {
    const peer = this.peerConnections.get(peerId);
    if (peer) {
      clearInterval(peer.pingInterval);
      peer.candidateQueue = [];
      try {
        peer.pc.close();
      } catch (err) {
        console.debug('Error closing peer connection:', err);
      }
      this.peerConnections.delete(peerId);
      if (this.onRemoteTrackRemoved) {
        this.onRemoteTrackRemoved(peerId, '');
      }
    }
  }

  private _createPeerConnection(peerId: string) {
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
    });

    const peerState = {
      pc,
      docChannel: null as RTCDataChannel | null,
      awarenessChannel: null as RTCDataChannel | null,
      missedPings: 0,
      handshakeResolved: false,
      candidateQueue: [] as RTCIceCandidateInit[],
      isMakingOffer: false,
    };
    this.peerConnections.set(peerId, peerState);

    pc.oniceconnectionstatechange = () => {
      console.log(`[RTC ICE] Peer ${peerId} connectionState: ${pc.iceConnectionState}`);
    };
    pc.onsignalingstatechange = () => {
      console.log(`[RTC Signaling] Peer ${peerId} signalingState: ${pc.signalingState}`);
    };

    // Apply dynamic TURN credentials if promise resolves later
    if (this.iceServersPromise) {
      this.iceServersPromise.then(() => {
        if (!this.isDestroyed && this.peerConnections.get(peerId) === peerState) {
          if (typeof (pc as any).setConfiguration === 'function') {
            (pc as any).setConfiguration({ iceServers: this.iceServers });
          }
        }
      }).catch(() => {});
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.ws?.send(
          JSON.stringify({
            type: 'ice-candidate',
            senderPeerId: this.localDeviceId,
            targetPeerId: peerId,
            payload: { candidate: event.candidate },
          })
        );
      }
    };

    pc.ontrack = (event) => {
      const stream = event.streams[0] || new MediaStream([event.track]);
      if (this.onRemoteTrackReceived) {
        this.onRemoteTrackReceived(peerId, stream);
      }
      event.track.onended = () => {
        if (this.onRemoteTrackRemoved) {
          this.onRemoteTrackRemoved(peerId, stream.id);
        }
      };
    };

    return { pc, peerState };
  }

  private async initiateConnection(targetPeerId: string) {
    if (this.isDestroyed) return;

    // Initiator disposal of previous connections
    this.closePeerConnection(targetPeerId);

    const { pc, peerState } = this._createPeerConnection(targetPeerId);

    // Create reliable/ordered data channel for Yjs
    const docChannel = pc.createDataChannel('omni-doc', {
      ordered: true,
    });

    // Create unreliable/unordered data channel for cursors
    const awarenessChannel = pc.createDataChannel('omni-awareness', {
      ordered: false,
      maxRetransmits: 0,
    });

    peerState.docChannel = docChannel;
    peerState.awarenessChannel = awarenessChannel;

    this.setupDataChannelListeners(docChannel, awarenessChannel, targetPeerId);

    // Single source of truth for ongoing renegotiation (e.g. tracks added/removed)
    pc.onnegotiationneeded = async () => {
      if (peerState.isMakingOffer || pc.signalingState !== 'stable') return;
      if (this.isDestroyed || this.peerConnections.get(targetPeerId) !== peerState) return;
      try {
        peerState.isMakingOffer = true;
        const offer = await pc.createOffer();
        if (pc.signalingState !== 'stable' || this.peerConnections.get(targetPeerId) !== peerState) return;
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
      } finally {
        peerState.isMakingOffer = false;
      }
    };

    // Initial connection offer dispatch
    try {
      peerState.isMakingOffer = true;
      const offer = await pc.createOffer();
      if (this.isDestroyed || this.peerConnections.get(targetPeerId) !== peerState) return;
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
      console.error('Failed to create initial offer:', err);
    } finally {
      peerState.isMakingOffer = false;
    }
  }

  private async handleOffer(senderPeerId: string, offer: RTCSessionDescriptionInit) {
    if (this.isDestroyed) return;

    const peerEntry = this.peerConnections.get(senderPeerId);
    let pc: RTCPeerConnection;
    let peerState: NonNullable<typeof peerEntry>;

    // If an active connection already exists, reuse it for renegotiation
    if (peerEntry && peerEntry.pc.signalingState !== 'closed') {
      pc = peerEntry.pc;
      peerState = peerEntry;
    } else {
      this.closePeerConnection(senderPeerId);
      const created = this._createPeerConnection(senderPeerId);
      pc = created.pc;
      peerState = created.peerState;

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
    }

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      if (this.isDestroyed || this.peerConnections.get(senderPeerId) !== peerState) return;

      // Flush any queued early-arrived ICE candidates
      await this.flushCandidateQueue(senderPeerId);
      if (this.isDestroyed || this.peerConnections.get(senderPeerId) !== peerState) return;

      const answer = await pc.createAnswer();
      if (this.isDestroyed || this.peerConnections.get(senderPeerId) !== peerState) return;

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
    } catch (err) {
      console.error('Failed to handle incoming offer:', err);
    }
  }

  private async handleAnswer(senderPeerId: string, answer: RTCSessionDescriptionInit) {
    if (this.isDestroyed) return;
    const peer = this.peerConnections.get(senderPeerId);
    if (peer) {
      try {
        await peer.pc.setRemoteDescription(new RTCSessionDescription(answer));
        // Flush any queued early-arrived ICE candidates
        await this.flushCandidateQueue(senderPeerId);
      } catch (err) {
        console.error('Failed to set remote answer description:', err);
      }
    }
  }

  private async handleIceCandidate(senderPeerId: string, candidate: RTCIceCandidateInit) {
    const peer = this.peerConnections.get(senderPeerId);
    if (!peer) return;

    // Buffer candidate if remoteDescription has not been applied yet
    if (!peer.pc.remoteDescription) {
      peer.candidateQueue.push(candidate);
      return;
    }

    try {
      await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.warn('Failed to add incoming ICE candidate:', err);
    }
  }

  private async flushCandidateQueue(peerId: string) {
    const peer = this.peerConnections.get(peerId);
    if (!peer || peer.candidateQueue.length === 0) return;

    const queued = [...peer.candidateQueue];
    peer.candidateQueue = [];

    for (const cand of queued) {
      try {
        await peer.pc.addIceCandidate(new RTCIceCandidate(cand));
      } catch (err) {
        console.warn('Failed to add queued ICE candidate:', err);
      }
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
            const text = textDecoder.decode(payload);
            const feedback = JSON.parse(text);
            if (isValidQualityFeedback(feedback)) {
              if (this.onQualityFeedbackReceived) {
                this.onQualityFeedbackReceived(peerId, feedback);
              }
            } else {
              console.warn('[RTC Security] Dropping malformed quality feedback packet from peer', peerId);
            }
          } catch (err) {
            console.error('Failed to parse quality feedback packet:', err);
          }
          break;
        }
        case MSG_KEYBOARD_INPUT: {
          try {
            const text = textDecoder.decode(payload);
            const envelope = JSON.parse(text);
            if (isValidInputEventEnvelope(envelope)) {
              if (this.onKeyboardInputReceived) {
                this.onKeyboardInputReceived(peerId, envelope);
              }
            } else {
              console.warn('[RTC Security] Dropping malformed keyboard input packet from peer', peerId);
            }
          } catch (err) {
            console.error('Failed to parse keyboard input packet:', err);
          }
          break;
        }
        case MSG_FILE_TRANSFER: {
          try {
            const text = textDecoder.decode(payload);
            const transferPayload = JSON.parse(text);
            if (isValidFileTransferPayload(transferPayload)) {
              this.fileReceiver.handlePayload(
                transferPayload,
                (prog) => this.onFileTransferProgress?.(peerId, prog),
                (file) => this.onFileReceived?.(peerId, file),
                (tid, reason) => this.onFileTransferAbort?.(peerId, tid, reason)
              );
            } else {
              console.warn('[RTC Security] Dropping malformed file transfer packet from peer', peerId);
            }
          } catch (err) {
            console.error('Failed to parse file transfer packet:', err);
          }
          break;
        }
      }
    };

    docChannel.onclose = () => {
      queueMicrotask(() => {
        if (!this.isDestroyed) {
          this.handlePeerLeft(peerId);
        }
      });
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
          const text = textDecoder.decode(payload);
          const envelope = JSON.parse(text);
          if (isValidInputEventEnvelope(envelope)) {
            if (this.onMouseInputReceived) {
              this.onMouseInputReceived(peerId, envelope);
            }
          } else {
            console.warn('[RTC Security] Dropping malformed mouse input packet from peer', peerId);
          }
        } catch (err) {
          console.error('Failed to parse mouse input packet:', err);
        }
      }
    };
  }

  public sendMouseInput(targetPeerId: string, envelope: InputEventEnvelope) {
    const peer = this.peerConnections.get(targetPeerId);
    if (!peer || !peer.awarenessChannel || peer.awarenessChannel.readyState !== 'open') return;

    const text = JSON.stringify(envelope);
    const textBytes = textEncoder.encode(text);
    const payload = new Uint8Array(textBytes.length + 1);
    payload[0] = MSG_MOUSE_INPUT;
    payload.set(textBytes, 1);

    peer.awarenessChannel.send(payload);
  }

  public sendKeyboardInput(targetPeerId: string, envelope: InputEventEnvelope) {
    const peer = this.peerConnections.get(targetPeerId);
    if (!peer || !peer.docChannel || peer.docChannel.readyState !== 'open') return;

    const text = JSON.stringify(envelope);
    const textBytes = textEncoder.encode(text);
    const payload = new Uint8Array(textBytes.length + 1);
    payload[0] = MSG_KEYBOARD_INPUT;
    payload.set(textBytes, 1);

    peer.docChannel.send(payload);
  }

  public async sendFile(
    targetPeerId: string,
    file: { name: string; size: number; mimeType?: string; data: Uint8Array },
    onProgress?: (progress: TransferProgress) => void
  ): Promise<string> {
    const peer = this.peerConnections.get(targetPeerId);
    if (!peer || !peer.docChannel || peer.docChannel.readyState !== 'open') {
      throw new Error(`Data channel to peer ${targetPeerId} is not open`);
    }

    return this.fileSender.sendFile(
      file,
      (payload) => {
        const text = JSON.stringify(payload);
        const textBytes = textEncoder.encode(text);
        const buffer = new Uint8Array(textBytes.length + 1);
        buffer[0] = MSG_FILE_TRANSFER;
        buffer.set(textBytes, 1);
        peer.docChannel!.send(buffer);
      },
      onProgress
    );
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
    if (peer.docChannel && peer.docChannel.readyState === 'open') {
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
        let initialX = 0;
        let initialY = 0;
        const otherDevices = Array.from(devicesMap.values()).filter(
          (d) => d.id !== this.localDeviceId && d.status === 'connected'
        );
        if (otherDevices.length > 0) {
          const rightmost = otherDevices.reduce(
            (max, d) => Math.max(max, d.x + d.width),
            0
          );
          initialX = rightmost;
        }

        devicesMap.set(this.localDeviceId, {
          id: this.localDeviceId,
          name: ua,
          width: sWidth,
          height: sHeight,
          dpiScale: sDpi,
          x: initialX,
          y: initialY,
          status: 'connected',
          type: this.deviceType,
        });
      }
    });
  }

  private pruneDisconnectedPeer(peerId: string) {
    // 1. Evaluate coordinator cleanup role first to persist CRDT disconnect status
    this.evaluateCoordinator(peerId);

    // 2. Instant awareness cleanup
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
      });

      // Resiliently schedule/evaluate all grace window timers OUTSIDE the transaction
      this.recheckGracePeriods();
    }
  }

  private recheckGracePeriods() {
    // Coordinator check only
    const devicesMap = this.doc.getMap<Device>('devices');
    let minConnectedId: string | null = null;

    for (const dev of devicesMap.values()) {
      if (dev.status === 'connected') {
        if (minConnectedId === null || dev.id.localeCompare(minConnectedId) < 0) {
          minConnectedId = dev.id;
        }
      }
    }

    if (!minConnectedId || minConnectedId !== this.localDeviceId) {
      // Not coordinator, cancel any local grace timers we hold
      if (this.graceTimers.size > 0) {
        this.graceTimers.forEach((timer) => clearTimeout(timer));
        this.graceTimers.clear();
      }
      return;
    }

    const now = Date.now();
    for (const dev of devicesMap.values()) {
      if (dev.status !== 'disconnected' || !dev.disconnectedAt) {
        const activeTimer = this.graceTimers.get(dev.id);
        if (activeTimer) {
          clearTimeout(activeTimer);
          this.graceTimers.delete(dev.id);
        }
        continue;
      }

      const elapsed = now - dev.disconnectedAt;
      if (elapsed >= 120000) {
        // Clear active timer if present
        const activeTimer = this.graceTimers.get(dev.id);
        if (activeTimer) {
          clearTimeout(activeTimer);
          this.graceTimers.delete(dev.id);
        }
        // Grace period expired: prune
        this.doc.transact(() => {
          devicesMap.delete(dev.id);
        });
      } else if (!this.graceTimers.has(dev.id)) {
        // Schedule remaining grace window timeout
        const remaining = 120000 - elapsed;
        const timer = setTimeout(() => {
          this.graceTimers.delete(dev.id);
          this.doc.transact(() => {
            devicesMap.delete(dev.id);
          });
        }, remaining);
        this.graceTimers.set(dev.id, timer);
      }
    }
  }

  private broadcastDocChannel(payload: Uint8Array) {
    this.peerConnections.forEach((peer) => {
      if (peer.docChannel && peer.docChannel.readyState === 'open') {
        peer.docChannel.send(payload as any);
      }
    });
  }

  private broadcastAwarenessChannel(payload: Uint8Array) {
    this.peerConnections.forEach((peer) => {
      if (peer.awarenessChannel && peer.awarenessChannel.readyState === 'open') {
        peer.awarenessChannel.send(payload as any);
      }
    });
  }

  /**
   * Destroys all active peer connections, data channels, heartbeat timers, and WebSocket handles.
   */
  public destroy() {
    this.isDestroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.docUpdateListener) {
      this.doc.off('update', this.docUpdateListener);
    }
    if (this.awarenessUpdateListener) {
      this.awareness.off('update', this.awarenessUpdateListener);
    }
    if (this.graceCheckInterval) {
      clearInterval(this.graceCheckInterval);
      this.graceCheckInterval = null;
    }
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

  /**
   * Dispatches receiver-side adaptive bitrate and framerate feedback to the capturing peer.
   *
   * @param peerId - The target peer identifier streaming the video.
   * @param feedback - Target window ID and bounded bitrate/framerate recommendations.
   */
  public sendQualityFeedback(
    peerId: string,
    feedback: { windowId: string; maxBitrate?: number; maxFramerate?: number }
  ) {
    const peer = this.peerConnections.get(peerId);
    if (peer && peer.docChannel && peer.docChannel.readyState === 'open') {
      const text = JSON.stringify(feedback);
      const packet = textEncoder.encode(text);
      const payload = new Uint8Array(packet.length + 1);
      payload[0] = MSG_QUALITY_FEEDBACK;
      payload.set(packet, 1);
      peer.docChannel.send(payload as any);
    }
  }

  /**
   * Retrieves the raw RTCPeerConnection instance for an active peer, if established.
   *
   * @param peerId - The remote peer ID.
   */
  public getPeerConnection(peerId: string): RTCPeerConnection | undefined {
    return this.peerConnections.get(peerId)?.pc;
  }
}

function prioritizeHardwareCodecs(desc: RTCSessionDescriptionInit): RTCSessionDescriptionInit {
  if (!desc.sdp) return desc;

  const lines = desc.sdp.split('\r\n');
  const videoLineIndices: number[] = [];
  const hardwarePayloads: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('m=video ')) {
      videoLineIndices.push(i);
    }
    if (line.startsWith('a=rtpmap:')) {
      const match = line.match(/^a=rtpmap:(\d+)\s+(H264|H265|AV1)\//i);
      if (match) {
        hardwarePayloads.push(match[1]);
      }
    }
  }

  if (videoLineIndices.length > 0 && hardwarePayloads.length > 0) {
    for (const idx of videoLineIndices) {
      const parts = lines[idx].split(' ');
      const header = parts.slice(0, 3);
      const payloads = parts.slice(3);

      const prioritized = payloads.filter((p) => hardwarePayloads.includes(p));
      const remaining = payloads.filter((p) => !hardwarePayloads.includes(p));
      const newPayloads = [...prioritized, ...remaining];

      lines[idx] = [...header, ...newPayloads].join(' ');
    }
  }

  return {
    type: desc.type,
    sdp: lines.join('\r\n'),
  };
}
