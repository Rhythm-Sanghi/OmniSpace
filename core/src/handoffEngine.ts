import * as Y from 'yjs';
import { Device, WindowInstance } from './types.js';
import { findTargetDevice } from './edgeDetection.js';
import { clearFocusIfMatches } from './focusManager.js';

export function claimWindowOwnership(
  windowId: string,
  localDeviceId: string,
  windowsMap: Y.Map<WindowInstance>
): boolean {
  const win = windowsMap.get(windowId);
  if (!win) return false;

  // Claim if unowned or already owned
  if (win.owningDeviceId === null || win.owningDeviceId === localDeviceId) {
    const updated = { ...win, owningDeviceId: localDeviceId };
    windowsMap.set(windowId, updated);
    return true;
  }

  return false;
}

export function updateWindowPosition(
  windowId: string,
  gx: number,
  gy: number,
  localDeviceId: string,
  windowsMap: Y.Map<WindowInstance>
): boolean {
  const win = windowsMap.get(windowId);
  if (!win) return false;

  if (win.owningDeviceId === localDeviceId) {
    const updated = { ...win, x: gx, y: gy };
    windowsMap.set(windowId, updated);
    return true;
  }

  return false;
}

export function handleWindowDrag(
  windowId: string,
  cursorGx: number,
  cursorGy: number,
  localDeviceId: string,
  devices: Device[],
  windowsMap: Y.Map<WindowInstance>
): string | null {
  const win = windowsMap.get(windowId);
  if (!win || win.owningDeviceId !== localDeviceId) {
    return null;
  }

  // Find if cursor is crossing into an adjacent device
  const targetDevice = findTargetDevice(cursorGx, cursorGy, devices, localDeviceId);
  if (targetDevice) {
    const updated = { ...win, owningDeviceId: targetDevice.id };
    windowsMap.set(windowId, updated);
    if (windowsMap.doc) {
      clearFocusIfMatches(windowsMap.doc, windowId);
    }
    return targetDevice.id;
  }

  return null;
}

/**
 * Executes reassignment of windows owned by a disconnected peer.
 * Must only be called by the cleanup coordinator.
 */
export function reassignDisconnectedDeviceWindows(
  disconnectedId: string,
  devicesMap: Y.Map<Device>,
  windowsMap: Y.Map<WindowInstance>
) {
  // First pass: Delete any windows captured by the disconnected device
  for (const [key, win] of windowsMap.entries()) {
    if (win.capturingDeviceId === disconnectedId) {
      windowsMap.delete(key);
    }
  }

  const devices = Array.from(devicesMap.values());
  const activePeers = devices.filter((d) => d.status === 'connected' && d.id !== disconnectedId);

  if (activePeers.length === 0) {
    // No active peers left to reassign to
    for (const [key, win] of windowsMap.entries()) {
      if (win.owningDeviceId === disconnectedId) {
        windowsMap.set(key, { ...win, owningDeviceId: null });
      }
    }
    return;
  }

  for (const [key, win] of windowsMap.entries()) {
    if (win.owningDeviceId !== disconnectedId) {
      continue;
    }

    // 1. Try to find overlapping device
    let targetPeer = activePeers.find((peer) => {
      return (
        win.x >= peer.x &&
        win.x < peer.x + peer.width &&
        win.y >= peer.y &&
        win.y < peer.y + peer.height
      );
    });

    // 2. Fall back to desktop-type peers, sorted lexicographically
    if (!targetPeer) {
      const desktopPeers = activePeers
        .filter((peer) => peer.type === 'desktop')
        .sort((a, b) => a.id.localeCompare(b.id));
      if (desktopPeers.length > 0) {
        targetPeer = desktopPeers[0];
      }
    }

    // 3. Fall back to mobile-type peers, sorted lexicographically
    if (!targetPeer) {
      const mobilePeers = activePeers
        .filter((peer) => peer.type === 'mobile')
        .sort((a, b) => a.id.localeCompare(b.id));
      if (mobilePeers.length > 0) {
        targetPeer = mobilePeers[0];
      }
    }

    // Apply the reassignment
    const targetId = targetPeer ? targetPeer.id : null;
    windowsMap.set(key, { ...win, owningDeviceId: targetId });
    if (windowsMap.doc) {
      clearFocusIfMatches(windowsMap.doc, key);
    }
  }
}
