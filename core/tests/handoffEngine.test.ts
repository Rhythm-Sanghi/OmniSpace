import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import {
  Device,
  WindowInstance,
  claimWindowOwnership,
  updateWindowPosition,
  handleWindowDrag,
  reassignDisconnectedDeviceWindows,
} from '../src/index.js';

describe('Handoff Engine and Ownership Controls', () => {
  it('correctly manages window ownership locks', () => {
    const doc = new Y.Doc();
    const windowsMap = doc.getMap<WindowInstance>('windows');

    const win: WindowInstance = {
      id: 'window-1',
      title: 'Mock Editor',
      width: 300,
      height: 200,
      x: 50,
      y: 50,
      owningDeviceId: null, // Unowned
    };
    windowsMap.set(win.id, win);

    // Peer A claims
    const claimA = claimWindowOwnership(win.id, 'peer-A', windowsMap);
    expect(claimA).toBe(true);
    expect(windowsMap.get(win.id)?.owningDeviceId).toBe('peer-A');

    // Peer B tries to claim but fails (peer-A owns it)
    const claimB = claimWindowOwnership(win.id, 'peer-B', windowsMap);
    expect(claimB).toBe(false);
    expect(windowsMap.get(win.id)?.owningDeviceId).toBe('peer-A');

    // Peer A updates position
    const moveSuccess = updateWindowPosition(win.id, 120, 150, 'peer-A', windowsMap);
    expect(moveSuccess).toBe(true);
    expect(windowsMap.get(win.id)?.x).toBe(120);

    // Peer B tries to update position but fails
    const moveFail = updateWindowPosition(win.id, 300, 300, 'peer-B', windowsMap);
    expect(moveFail).toBe(false);
    expect(windowsMap.get(win.id)?.x).toBe(120); // Retains A's position
  });

  it('triggers window handoffs upon border crossings', () => {
    const doc = new Y.Doc();
    const windowsMap = doc.getMap<WindowInstance>('windows');

    const localDevice: Device = {
      id: 'peer-A',
      name: 'Primary Screen',
      width: 1000,
      height: 600,
      dpiScale: 1,
      x: 0,
      y: 0,
      status: 'connected',
      type: 'desktop',
    };

    const rightDevice: Device = {
      id: 'peer-B',
      name: 'Right Screen',
      width: 1000,
      height: 600,
      dpiScale: 1,
      x: 1000,
      y: 0,
      status: 'connected',
      type: 'desktop',
    };

    const devices = [localDevice, rightDevice];

    const win: WindowInstance = {
      id: 'window-1',
      title: 'Editor',
      width: 300,
      height: 200,
      x: 800,
      y: 100,
      owningDeviceId: 'peer-A',
    };
    windowsMap.set(win.id, win);

    // Drag cursor past local border into peer-B space (x=1100)
    const targetId = handleWindowDrag('window-1', 1100, 200, 'peer-A', devices, windowsMap);
    expect(targetId).toBe('peer-B');
    expect(windowsMap.get('window-1')?.owningDeviceId).toBe('peer-B');
  });

  it('orchestrates window reassignments on peer disconnects based on priority rules', () => {
    const doc = new Y.Doc();
    const devicesMap = doc.getMap<Device>('devices');
    const windowsMap = doc.getMap<WindowInstance>('windows');

    const disconnectedPeer: Device = {
      id: 'peer-disconnected',
      name: 'Mobile Client',
      width: 500,
      height: 800,
      dpiScale: 2,
      x: 0,
      y: 1000,
      status: 'disconnected',
      type: 'mobile',
    };

    const overlappingPeer: Device = {
      id: 'peer-overlap',
      name: 'Overlapping Tablet',
      width: 800,
      height: 1000,
      dpiScale: 2,
      x: 1000,
      y: 0,
      status: 'connected',
      type: 'mobile',
    };

    const desktopFallback: Device = {
      id: 'peer-desktop-fallback',
      name: 'Desktop Host',
      width: 1920,
      height: 1080,
      dpiScale: 1,
      x: 2000,
      y: 2000,
      status: 'connected',
      type: 'desktop',
    };

    devicesMap.set(disconnectedPeer.id, disconnectedPeer);
    devicesMap.set(overlappingPeer.id, overlappingPeer);
    devicesMap.set(desktopFallback.id, desktopFallback);

    // Window 1: Overlaps peer-overlap bounds
    const win1: WindowInstance = {
      id: 'win-1',
      title: 'Notes',
      width: 300,
      height: 200,
      x: 1200, // Inside peer-overlap
      y: 100,
      owningDeviceId: 'peer-disconnected',
    };

    // Window 2: Does not overlap, should fall back to desktopFallback
    const win2: WindowInstance = {
      id: 'win-2',
      title: 'Editor',
      width: 300,
      height: 200,
      x: 5000, // Out of bounds
      y: 5000,
      owningDeviceId: 'peer-disconnected',
    };

    windowsMap.set(win1.id, win1);
    windowsMap.set(win2.id, win2);

    // Run reassignment
    reassignDisconnectedDeviceWindows('peer-disconnected', devicesMap, windowsMap);

    // Assert win-1 reassigned to overlapping peer
    expect(windowsMap.get('win-1')?.owningDeviceId).toBe('peer-overlap');
    // Assert win-2 reassigned to desktop fallback
    expect(windowsMap.get('win-2')?.owningDeviceId).toBe('peer-desktop-fallback');
  });

  it('deletes windows captured by the disconnected device but reassigns windows only owned by it', () => {
    const doc = new Y.Doc();
    const devicesMap = doc.getMap<Device>('devices');
    const windowsMap = doc.getMap<WindowInstance>('windows');

    const disconnectedPeer: Device = {
      id: 'peer-disconnected',
      name: 'Old Screen',
      width: 1000,
      height: 600,
      dpiScale: 1,
      x: 0,
      y: 0,
      status: 'disconnected',
      type: 'desktop',
    };

    const remainingPeer: Device = {
      id: 'peer-remaining',
      name: 'Safe Screen',
      width: 1000,
      height: 600,
      dpiScale: 1,
      x: 1000,
      y: 0,
      status: 'connected',
      type: 'desktop',
    };

    devicesMap.set(disconnectedPeer.id, disconnectedPeer);
    devicesMap.set(remainingPeer.id, remainingPeer);

    // Window A: Captured by disconnected device (must be deleted)
    const winA: WindowInstance = {
      id: 'win-A',
      title: 'Captured by disconnected',
      width: 300,
      height: 200,
      x: 100,
      y: 100,
      owningDeviceId: 'peer-disconnected',
      capturingDeviceId: 'peer-disconnected',
      hasActiveCapture: true,
    };

    // Window B: Captured by remaining peer, but currently owned/focused by disconnected peer (must be reassigned)
    const winB: WindowInstance = {
      id: 'win-B',
      title: 'Owned by disconnected but captured by remaining',
      width: 300,
      height: 200,
      x: 1100,
      y: 100,
      owningDeviceId: 'peer-disconnected',
      capturingDeviceId: 'peer-remaining',
      hasActiveCapture: true,
    };

    windowsMap.set(winA.id, winA);
    windowsMap.set(winB.id, winB);

    // Run reassignment
    reassignDisconnectedDeviceWindows('peer-disconnected', devicesMap, windowsMap);

    // Win A must be deleted completely
    expect(windowsMap.has('win-A')).toBe(false);
    // Win B must be reassigned to remaining peer
    expect(windowsMap.get('win-B')?.owningDeviceId).toBe('peer-remaining');
  });
});
