import { describe, it, expect, vi } from 'vitest';
import {
  encodeDiscoveryBeacon,
  decodeDiscoveryBeacon,
  LocalDiscoveryManager,
  LocalDiscoveryBeacon,
} from '../src/index.js';

describe('Local Network Beacon Discovery Protocol', () => {
  const sampleBeacon: LocalDiscoveryBeacon = {
    service: 'omni-space',
    version: 1,
    deviceId: 'peer-desktop-1',
    deviceName: 'MacBook Pro',
    deviceType: 'desktop',
    roomPin: '492815',
    port: 8080,
    timestamp: Date.now(),
  };

  it('encodes and decodes valid discovery beacons', () => {
    const encoded = encodeDiscoveryBeacon(sampleBeacon);
    expect(typeof encoded).toBe('string');

    const decoded = decodeDiscoveryBeacon(encoded);
    expect(decoded).toEqual(sampleBeacon);

    // Also supports Uint8Array buffer input
    const buffer = new TextEncoder().encode(encoded);
    const decodedFromBuffer = decodeDiscoveryBeacon(buffer);
    expect(decodedFromBuffer).toEqual(sampleBeacon);
  });

  it('rejects invalid or malformed beacons', () => {
    // Malformed JSON
    expect(decodeDiscoveryBeacon('not-json')).toBeNull();

    // Wrong service name
    expect(
      decodeDiscoveryBeacon(
        JSON.stringify({ ...sampleBeacon, service: 'other-service' })
      )
    ).toBeNull();

    // Wrong version
    expect(
      decodeDiscoveryBeacon(JSON.stringify({ ...sampleBeacon, version: 2 }))
    ).toBeNull();

    // Missing deviceId
    expect(
      decodeDiscoveryBeacon(JSON.stringify({ ...sampleBeacon, deviceId: '' }))
    ).toBeNull();

    // Invalid port
    expect(
      decodeDiscoveryBeacon(
        JSON.stringify({ ...sampleBeacon, port: 999999 })
      )
    ).toBeNull();
  });

  it('rejects expired/stale beacons', () => {
    const oldTimestamp = Date.now() - 70_000; // 70 seconds ago
    const staleBeacon = { ...sampleBeacon, timestamp: oldTimestamp };
    const encoded = encodeDiscoveryBeacon(staleBeacon);

    expect(decodeDiscoveryBeacon(encoded, 60_000)).toBeNull();
  });

  it('manages peer discovery, self-filtering, and stale eviction', () => {
    const manager = new LocalDiscoveryManager('local-me', 1000); // 1s timeout
    const discoveredSpy = vi.fn();
    const lostSpy = vi.fn();

    manager.onPeerDiscovered = discoveredSpy;
    manager.onPeerLost = lostSpy;

    // 1. Self beacon should be ignored
    const selfBeacon: LocalDiscoveryBeacon = {
      ...sampleBeacon,
      deviceId: 'local-me',
      timestamp: Date.now(),
    };
    const selfResult = manager.handleIncomingDatagram(encodeDiscoveryBeacon(selfBeacon));
    expect(selfResult).toBe(false);
    expect(discoveredSpy).not.toHaveBeenCalled();

    // 2. Remote beacon should be discovered
    const remoteBeacon: LocalDiscoveryBeacon = {
      ...sampleBeacon,
      deviceId: 'remote-peer-1',
      timestamp: Date.now(),
    };
    const remoteResult = manager.handleIncomingDatagram(encodeDiscoveryBeacon(remoteBeacon));
    expect(remoteResult).toBe(true);
    expect(discoveredSpy).toHaveBeenCalledTimes(1);
    expect(discoveredSpy).toHaveBeenCalledWith(remoteBeacon);
    expect(manager.getDiscoveredPeers().length).toBe(1);

    // 3. Repeat beacon should update lastSeen without triggering duplicate discovery
    manager.handleIncomingDatagram(encodeDiscoveryBeacon(remoteBeacon));
    expect(discoveredSpy).toHaveBeenCalledTimes(1);

    // 4. Stale peer pruning
    // Fast-forward time on peer entry
    const peers = (manager as any).peers;
    peers.get('remote-peer-1').lastSeen = Date.now() - 2000;

    manager.pruneStalePeers();
    expect(lostSpy).toHaveBeenCalledWith('remote-peer-1');
    expect(manager.getDiscoveredPeers().length).toBe(0);

    manager.destroy();
  });
});
