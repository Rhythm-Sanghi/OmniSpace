import * as Y from 'yjs';
import { WindowInstance } from './types.js';
import { OmniRTCManager } from './rtc.js';
import { OmniCaptureManager } from './captureManager.js';

export class OmniMediaTransportManager {
  private activeSenders: Map<string, RTCRtpSender> = new Map(); // key = "windowId:peerId" -> RTCRtpSender
  private windowOwners: Map<string, string | null> = new Map(); // windowId -> owningDeviceId

  constructor(
    private rtcManager: OmniRTCManager,
    private captureManager: OmniCaptureManager,
    private windowsMap: Y.Map<WindowInstance>
  ) {
    // Listen to Yjs windows map updates
    this.windowsMap.observe((event) => {
      this.windowsMap.doc?.transact(() => {
        event.keys.forEach((change, key) => {
          const win = this.windowsMap.get(key);
          if (change.action === 'delete') {
            this.handleWindowDeleted(key);
          } else if (win) {
            this.handleWindowUpdated(win);
          }
        });
      }, 'media-transport');
    });

    // Populate initial state
    Array.from(this.windowsMap.values()).forEach((win) => {
      this.windowOwners.set(win.id, win.owningDeviceId);
      this.handleWindowUpdated(win);
    });
  }

  private handleWindowUpdated(win: WindowInstance) {
    const oldOwner = this.windowOwners.get(win.id) ?? null;
    const newOwner = win.owningDeviceId;

    if (oldOwner === newOwner) return;

    this.windowOwners.set(win.id, newOwner);

    // Only route tracks if this device is the capture source
    if (win.capturingDeviceId !== this.rtcManager.localDeviceId) {
      return;
    }

    // 1. Remove track from old owner if it was a remote peer
    if (oldOwner && oldOwner !== this.rtcManager.localDeviceId) {
      this.removeTrackFromPeer(win.id, oldOwner);
    }

    // 2. Add track to new owner if it is a remote peer
    if (newOwner && newOwner !== this.rtcManager.localDeviceId) {
      this.addTrackToPeer(win.id, newOwner);
    }
  }

  private handleWindowDeleted(windowId: string) {
    const oldOwner = this.windowOwners.get(windowId);
    if (oldOwner && oldOwner !== this.rtcManager.localDeviceId) {
      this.removeTrackFromPeer(windowId, oldOwner);
    }
    this.windowOwners.delete(windowId);
  }

  private addTrackToPeer(windowId: string, peerId: string) {
    const pc = this.rtcManager.getPeerConnection(peerId);
    if (!pc) return;

    const stream = this.captureManager.getLocalStream(windowId);
    if (!stream) return;

    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) return;

    const senderKey = `${windowId}:${peerId}`;
    if (this.activeSenders.has(senderKey)) return;

    try {
      // Add track to connection, triggering renegotiation automatically
      const sender = pc.addTrack(videoTrack, stream);
      this.activeSenders.set(senderKey, sender);
    } catch (err) {
      console.error(`Failed to add track to peer ${peerId} for window ${windowId}:`, err);
    }
  }

  private removeTrackFromPeer(windowId: string, peerId: string) {
    const senderKey = `${windowId}:${peerId}`;
    const sender = this.activeSenders.get(senderKey);
    if (!sender) return;

    const pc = this.rtcManager.getPeerConnection(peerId);
    if (pc) {
      try {
        // Remove track from connection, triggering renegotiation
        pc.removeTrack(sender);
      } catch (err) {
        console.error(`Failed to remove track from peer ${peerId} for window ${windowId}:`, err);
      }
    }
    this.activeSenders.delete(senderKey);
  }

  public getSender(windowId: string, peerId: string): RTCRtpSender | undefined {
    return this.activeSenders.get(`${windowId}:${peerId}`);
  }

  public destroy() {
    this.activeSenders.forEach((sender, key) => {
      const [_windowId, peerId] = key.split(':');
      const pc = this.rtcManager.getPeerConnection(peerId);
      if (pc) {
        try {
          pc.removeTrack(sender);
        } catch (_e) {}
      }
    });
    this.activeSenders.clear();
    this.windowOwners.clear();
  }
}
