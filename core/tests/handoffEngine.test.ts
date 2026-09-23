import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import {
  Device,
  WindowInstance,
  claimWindowOwnership,
  updateWindowPosition,
  handleWindowDrag,
  reassignDisconnectedDeviceWindows,
  updateWindowSize,
  toggleWindowMaximize,
  computeSnapPosition,
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
      capturingDeviceId: 'peer-A',
      hasActiveCapture: true,
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
      capturingDeviceId: 'peer-A',
      hasActiveCapture: true,
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
      capturingDeviceId: 'peer-other',
      hasActiveCapture: true,
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
      capturingDeviceId: 'peer-other',
      hasActiveCapture: true,
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

  it('updates window size correctly with min bounds and ownership enforcement', () => {
    const doc = new Y.Doc();
    const windowsMap = doc.getMap<WindowInstance>('windows');

    const win: WindowInstance = {
      id: 'win-size-1',
      title: 'Resizable Window',
      width: 400,
      height: 300,
      x: 100,
      y: 100,
      owningDeviceId: 'peer-owner',
      capturingDeviceId: 'peer-owner',
      hasActiveCapture: true,
    };
    windowsMap.set(win.id, win);

    // Non-owner cannot resize
    const nonOwnerResult = updateWindowSize('win-size-1', 600, 500, 'peer-intruder', windowsMap);
    expect(nonOwnerResult).toBe(false);
    expect(windowsMap.get('win-size-1')?.width).toBe(400);

    // Owner can resize
    const ownerResult = updateWindowSize('win-size-1', 500, 400, 'peer-owner', windowsMap);
    expect(ownerResult).toBe(true);
    expect(windowsMap.get('win-size-1')?.width).toBe(500);
    expect(windowsMap.get('win-size-1')?.height).toBe(400);

    // Enforces minimum bounds (default minWidth=180, minHeight=120)
    updateWindowSize('win-size-1', 50, 50, 'peer-owner', windowsMap);
    expect(windowsMap.get('win-size-1')?.width).toBe(180);
    expect(windowsMap.get('win-size-1')?.height).toBe(120);
  });

  it('toggles window maximize and restores pre-maximized bounds', () => {
    const doc = new Y.Doc();
    const windowsMap = doc.getMap<WindowInstance>('windows');

    const device: Device = {
      id: 'peer-1',
      name: 'Main Screen',
      width: 1920,
      height: 1080,
      dpiScale: 1,
      x: 0,
      y: 0,
      status: 'connected',
      type: 'desktop',
    };

    const win: WindowInstance = {
      id: 'win-max-1',
      title: 'Maximizable Window',
      width: 400,
      height: 300,
      x: 150,
      y: 120,
      owningDeviceId: 'peer-1',
      capturingDeviceId: 'peer-1',
      hasActiveCapture: true,
      isMaximized: false,
    };
    windowsMap.set(win.id, win);

    // Maximize
    const maxResult = toggleWindowMaximize('win-max-1', 'peer-1', device, windowsMap);
    expect(maxResult).toBe(true);
    const maximizedWin = windowsMap.get('win-max-1');
    expect(maximizedWin?.isMaximized).toBe(true);
    expect(maximizedWin?.x).toBe(10);
    expect(maximizedWin?.y).toBe(10);
    expect(maximizedWin?.width).toBe(1900); // 1920 - 20
    expect(maximizedWin?.height).toBe(1060); // 1080 - 20
    expect(maximizedWin?.preMaximizedBounds).toEqual({
      x: 150,
      y: 120,
      width: 400,
      height: 300,
    });

    // Restore
    const restoreResult = toggleWindowMaximize('win-max-1', 'peer-1', device, windowsMap);
    expect(restoreResult).toBe(true);
    const restoredWin = windowsMap.get('win-max-1');
    expect(restoredWin?.isMaximized).toBe(false);
    expect(restoredWin?.x).toBe(150);
    expect(restoredWin?.y).toBe(120);
    expect(restoredWin?.width).toBe(400);
    expect(restoredWin?.height).toBe(300);
  });

  it('computes snap positions to device boundaries within threshold', () => {
    const device: Device = {
      id: 'peer-1',
      name: 'Main Screen',
      width: 1000,
      height: 800,
      dpiScale: 1,
      x: 100,
      y: 100,
      status: 'connected',
      type: 'desktop',
    };

    // Snapping to left edge (device.x = 100, gx = 110, threshold = 20)
    const snapLeft = computeSnapPosition(110, 300, 200, 200, device, 20);
    expect(snapLeft.x).toBe(100);
    expect(snapLeft.y).toBe(300);

    // Snapping to top edge (device.y = 100, gy = 90, threshold = 20)
    const snapTop = computeSnapPosition(400, 90, 200, 200, device, 20);
    expect(snapTop.x).toBe(400);
    expect(snapTop.y).toBe(100);

    // Snapping to right edge (device.x + device.width = 1100, right edge = 1090)
    const snapRight = computeSnapPosition(890, 300, 200, 200, device, 20);
    expect(snapRight.x).toBe(900); // 1100 - 200

    // Outside threshold -> no snapping
    const noSnap = computeSnapPosition(300, 300, 200, 200, device, 20);
    expect(noSnap.x).toBe(300);
    expect(noSnap.y).toBe(300);
  });
});
