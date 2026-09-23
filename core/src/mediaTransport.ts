import * as Y from 'yjs';
import { WindowInstance } from './types.js';
import { OmniRTCManager } from './rtc.js';
import { OmniCaptureManager } from './captureManager.js';

export class OmniMediaTransportManager {
  // Nested map: windowId -> (peerId -> RTCRtpSender[]) to store both video and audio senders
  private activeSenders: Map<string, Map<string, RTCRtpSender[]>> = new Map();
  private windowOwners: Map<string, string | null> = new Map(); // windowId -> owningDeviceId
  private windowsObserver: ((event: Y.YMapEvent<WindowInstance>) => void) | null = null;

  constructor(
    private rtcManager: OmniRTCManager,
    private captureManager: OmniCaptureManager,
    private windowsMap: Y.Map<WindowInstance>
  ) {
    // Listen to Yjs windows map updates
    this.windowsObserver = (event) => {
      event.keys.forEach((change, key) => {
        const win = this.windowsMap.get(key);
        if (change.action === 'delete') {
          this.handleWindowDeleted(key);
        } else if (win) {
          this.handleWindowUpdated(win);
        }
      });
    };
    this.windowsMap.observe(this.windowsObserver);

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
    const windowSenders = this.activeSenders.get(windowId);
    if (windowSenders) {
      for (const peerId of Array.from(windowSenders.keys())) {
        this.removeTrackFromPeer(windowId, peerId);
      }
      this.activeSenders.delete(windowId);
    }
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

    let windowSenders = this.activeSenders.get(windowId);
    if (!windowSenders) {
      windowSenders = new Map();
      this.activeSenders.set(windowId, windowSenders);
    }

    if (windowSenders.has(peerId)) return;

    try {
      const senders: RTCRtpSender[] = [];
      // 1. Add video track to connection
      senders.push(pc.addTrack(videoTrack, stream));

      // 2. Add audio track if present (e.g. system/window sound)
      const audioTrack = stream.getAudioTracks ? stream.getAudioTracks()[0] : undefined;
      if (audioTrack) {
        senders.push(pc.addTrack(audioTrack, stream));
      }

      windowSenders.set(peerId, senders);
    } catch (err) {
      windowSenders.delete(peerId);
      console.error(`Failed to add track to peer ${peerId} for window ${windowId}:`, err);
    }
  }

  private removeTrackFromPeer(windowId: string, peerId: string) {
    const windowSenders = this.activeSenders.get(windowId);
    if (!windowSenders) return;

    const senders = windowSenders.get(peerId);
    if (!senders) return;

    windowSenders.delete(peerId);
    if (windowSenders.size === 0) {
      this.activeSenders.delete(windowId);
    }

    const pc = this.rtcManager.getPeerConnection(peerId);
    if (pc) {
      for (const sender of senders) {
        try {
          pc.removeTrack(sender);
        } catch (err) {
          console.error(`Failed to remove track from peer ${peerId} for window ${windowId}:`, err);
        }
      }
    }
  }

  public getSender(windowId: string, peerId: string): RTCRtpSender | undefined {
    return this.activeSenders.get(windowId)?.get(peerId)?.[0];
  }

  public destroy() {
    if (this.windowsObserver) {
      this.windowsMap.unobserve(this.windowsObserver);
      this.windowsObserver = null;
    }
    for (const [, peerMap] of this.activeSenders.entries()) {
      for (const [peerId, senders] of peerMap.entries()) {
        const pc = this.rtcManager.getPeerConnection(peerId);
        if (pc) {
          for (const sender of senders) {
            try {
              pc.removeTrack(sender);
            } catch (err) {
              console.debug('Failed to remove track during media transport disposal:', err);
            }
          }
        }
      }
    }
    this.activeSenders.clear();
    this.windowOwners.clear();
  }
}
