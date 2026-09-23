export interface LocalDiscoveryBeacon {
  service: 'omni-space';
  version: 1;
  deviceId: string;
  deviceName: string;
  deviceType: 'desktop' | 'mobile';
  roomPin: string;
  port?: number;
  timestamp: number;
}

export function encodeDiscoveryBeacon(beacon: LocalDiscoveryBeacon): string {
  return JSON.stringify(beacon);
}

export function decodeDiscoveryBeacon(
  raw: string | Uint8Array,
  maxAgeMs = 60_000
): LocalDiscoveryBeacon | null {
  try {
    let text: string;
    if (typeof raw === 'string') {
      text = raw;
    } else {
      text = new TextDecoder().decode(raw);
    }

    const obj = JSON.parse(text);
    if (!obj || typeof obj !== 'object') return null;

    if (obj.service !== 'omni-space') return null;
    if (obj.version !== 1) return null;

    if (
      typeof obj.deviceId !== 'string' ||
      obj.deviceId.trim().length === 0 ||
      obj.deviceId.length > 128
    ) {
      return null;
    }

    if (
      typeof obj.deviceName !== 'string' ||
      obj.deviceName.trim().length === 0 ||
      obj.deviceName.length > 128
    ) {
      return null;
    }

    if (obj.deviceType !== 'desktop' && obj.deviceType !== 'mobile') {
      return null;
    }

    if (
      typeof obj.roomPin !== 'string' ||
      obj.roomPin.trim().length === 0 ||
      obj.roomPin.length > 64
    ) {
      return null;
    }

    if (
      typeof obj.timestamp !== 'number' ||
      isNaN(obj.timestamp) ||
      obj.timestamp <= 0
    ) {
      return null;
    }

    if (obj.port !== undefined) {
      if (typeof obj.port !== 'number' || isNaN(obj.port) || obj.port < 1 || obj.port > 65535) {
        return null;
      }
    }

    // Check freshness against current time
    const age = Math.abs(Date.now() - obj.timestamp);
    if (age > maxAgeMs) {
      return null;
    }

    return obj as LocalDiscoveryBeacon;
  } catch {
    return null;
  }
}

export class LocalDiscoveryManager {
  private peers = new Map<string, { beacon: LocalDiscoveryBeacon; lastSeen: number }>();
  private localDeviceId: string;
  private peerTimeoutMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  public onPeerDiscovered?: (beacon: LocalDiscoveryBeacon) => void;
  public onPeerLost?: (deviceId: string) => void;

  constructor(localDeviceId: string, peerTimeoutMs = 15_000) {
    this.localDeviceId = localDeviceId;
    this.peerTimeoutMs = peerTimeoutMs;

    this.cleanupTimer = setInterval(() => {
      this.pruneStalePeers();
    }, 5000);
  }

  public handleIncomingDatagram(datagram: string | Uint8Array): boolean {
    const beacon = decodeDiscoveryBeacon(datagram);
    if (!beacon) return false;

    // Ignore self-broadcasts
    if (beacon.deviceId === this.localDeviceId) return false;

    const existing = this.peers.get(beacon.deviceId);
    const now = Date.now();

    this.peers.set(beacon.deviceId, {
      beacon,
      lastSeen: now,
    });

    if (!existing && this.onPeerDiscovered) {
      this.onPeerDiscovered(beacon);
    }

    return true;
  }

  public getDiscoveredPeers(): LocalDiscoveryBeacon[] {
    return Array.from(this.peers.values()).map((p) => p.beacon);
  }

  public pruneStalePeers(): void {
    const now = Date.now();
    for (const [deviceId, entry] of this.peers.entries()) {
      if (now - entry.lastSeen > this.peerTimeoutMs) {
        this.peers.delete(deviceId);
        if (this.onPeerLost) {
          this.onPeerLost(deviceId);
        }
      }
    }
  }

  public destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.peers.clear();
  }
}
