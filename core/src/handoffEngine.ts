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
    if (windowsMap.doc) {
      windowsMap.doc.transact(() => {
        windowsMap.set(windowId, updated);
      }, 'window-handoff');
    } else {
      windowsMap.set(windowId, updated);
    }
    console.log(`[HandoffEngine] Device ${localDeviceId} claimed ownership of window ${windowId}`);
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
    if (windowsMap.doc) {
      windowsMap.doc.transact(() => {
        windowsMap.set(windowId, updated);
      }, 'window-handoff');
    } else {
      windowsMap.set(windowId, updated);
    }
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
    let transferred = false;
    const mutate = () => {
      const currentWin = windowsMap.get(windowId);
      if (!currentWin || currentWin.owningDeviceId !== localDeviceId) {
        return;
      }
      const updated = { ...currentWin, owningDeviceId: targetDevice.id };
      windowsMap.set(windowId, updated);
      if (windowsMap.doc) {
        clearFocusIfMatches(windowsMap.doc, windowId);
      }
      transferred = true;
    };

    if (windowsMap.doc) {
      windowsMap.doc.transact(mutate, 'window-handoff');
    } else {
      mutate();
    }

    if (transferred) {
      console.log(`[HandoffEngine] Window ${windowId} handed off from ${localDeviceId} to ${targetDevice.id}`);
      return targetDevice.id;
    }
    return null;
  }

  return null;
}

function findFallbackPeer(peers: Device[], type: 'desktop' | 'mobile'): Device | undefined {
  return peers
    .filter((peer) => peer.type === type)
    .sort((a, b) => a.id.localeCompare(b.id))[0];
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
  const executeReassign = () => {
    // First pass: Collect keys to delete for windows captured by the disconnected device
    const keysToDelete: string[] = [];
    for (const [key, win] of windowsMap.entries()) {
      if (win.capturingDeviceId === disconnectedId) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      windowsMap.delete(key);
      console.log(`[HandoffEngine] Deleted captured window ${key} from disconnected device ${disconnectedId}`);
    }

    const devices = Array.from(devicesMap.values());
    const activePeers = devices.filter((d) => d.status === 'connected' && d.id !== disconnectedId);

    const remainingEntries = Array.from(windowsMap.entries()).filter(([key]) => !keysToDelete.includes(key));
    if (activePeers.length === 0) {
      // No active peers left to reassign to: stage and apply resets
      const resetUpdates: Array<{ key: string; win: WindowInstance }> = [];
      for (const [key, win] of remainingEntries) {
        if (win.owningDeviceId === disconnectedId) {
          resetUpdates.push({ key, win: { ...win, owningDeviceId: null } });
        }
      }
      for (const { key, win } of resetUpdates) {
        windowsMap.set(key, win);
        console.log(`[HandoffEngine] Reset ownership of window ${key} to null (no active peers)`);
      }
      return;
    }

    // Collect all planned reassignments before applying mutations
    const plannedUpdates: Array<{ key: string; updated: WindowInstance }> = [];

    for (const [key, win] of remainingEntries) {
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
        targetPeer = findFallbackPeer(activePeers, 'desktop');
      }

      // 3. Fall back to mobile-type peers, sorted lexicographically
      if (!targetPeer) {
        targetPeer = findFallbackPeer(activePeers, 'mobile');
      }

      const targetId = targetPeer ? targetPeer.id : null;
      plannedUpdates.push({
        key,
        updated: { ...win, owningDeviceId: targetId },
      });
    }

    // Secondary pass: Apply staged reassignments
    for (const { key, updated } of plannedUpdates) {
      windowsMap.set(key, updated);
      console.log(`[HandoffEngine] Reassigned window ${key} from disconnected peer ${disconnectedId} to ${updated.owningDeviceId || 'null'}`);
      if (windowsMap.doc) {
        clearFocusIfMatches(windowsMap.doc, key);
      }
    }
  };

  if (windowsMap.doc) {
    windowsMap.doc.transact(executeReassign, 'window-reassign');
  } else {
    executeReassign();
  }
}

export function updateWindowSize(
  windowId: string,
  width: number,
  height: number,
  localDeviceId: string,
  windowsMap: Y.Map<WindowInstance>,
  minWidth = 180,
  minHeight = 120
): boolean {
  const win = windowsMap.get(windowId);
  if (!win) return false;

  if (win.owningDeviceId === localDeviceId) {
    const clampedWidth = Math.max(minWidth, Math.round(width));
    const clampedHeight = Math.max(minHeight, Math.round(height));
    const updated = { ...win, width: clampedWidth, height: clampedHeight, isMaximized: false };
    if (windowsMap.doc) {
      windowsMap.doc.transact(() => {
        windowsMap.set(windowId, updated);
      }, 'window-resize');
    } else {
      windowsMap.set(windowId, updated);
    }
    return true;
  }
  return false;
}

export function toggleWindowMaximize(
  windowId: string,
  localDeviceId: string,
  device: Device,
  windowsMap: Y.Map<WindowInstance>
): boolean {
  const win = windowsMap.get(windowId);
  if (!win) return false;

  if (win.owningDeviceId === localDeviceId) {
    let updated: WindowInstance;
    if (win.isMaximized) {
      const bounds = win.preMaximizedBounds || {
        x: device.x + 40,
        y: device.y + 40,
        width: 320,
        height: 220,
      };
      updated = {
        ...win,
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        isMaximized: false,
      };
    } else {
      const margin = 10;
      updated = {
        ...win,
        preMaximizedBounds: {
          x: win.x,
          y: win.y,
          width: win.width,
          height: win.height,
        },
        x: device.x + margin,
        y: device.y + margin,
        width: Math.max(200, device.width - margin * 2),
        height: Math.max(150, device.height - margin * 2),
        isMaximized: true,
      };
    }

    if (windowsMap.doc) {
      windowsMap.doc.transact(() => {
        windowsMap.set(windowId, updated);
      }, 'window-maximize');
    } else {
      windowsMap.set(windowId, updated);
    }
    return true;
  }
  return false;
}

export function computeSnapPosition(
  gx: number,
  gy: number,
  width: number,
  height: number,
  device: Device,
  snapThreshold = 20
): { x: number; y: number } {
  let snappedX = gx;
  let snappedY = gy;

  // Snap to left border
  if (Math.abs(gx - device.x) <= snapThreshold) {
    snappedX = device.x;
  }
  // Snap to right border
  else if (Math.abs(gx + width - (device.x + device.width)) <= snapThreshold) {
    snappedX = device.x + device.width - width;
  }

  // Snap to top border
  if (Math.abs(gy - device.y) <= snapThreshold) {
    snappedY = device.y;
  }
  // Snap to bottom border
  else if (Math.abs(gy + height - (device.y + device.height)) <= snapThreshold) {
    snappedY = device.y + device.height - height;
  }

  return { x: snappedX, y: snappedY };
}
