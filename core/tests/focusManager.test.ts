import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { focusWindow, blurWindow, getFocusedWindowId, clearFocusIfMatches } from '../src/focusManager.js';

describe('Yjs Focus Manager', () => {
  it('correctly sets, gets, and blurs window focus in Yjs shared state', () => {
    const doc = new Y.Doc();

    expect(getFocusedWindowId(doc)).toBeNull();

    focusWindow(doc, 'win-1');
    expect(getFocusedWindowId(doc)).toBe('win-1');

    blurWindow(doc);
    expect(getFocusedWindowId(doc)).toBeNull();
  });

  it('clears focus only if it matches the target window ID', () => {
    const doc = new Y.Doc();

    focusWindow(doc, 'win-1');
    
    // Clear mismatch -> should retain focus
    clearFocusIfMatches(doc, 'win-2');
    expect(getFocusedWindowId(doc)).toBe('win-1');

    // Clear match -> should blur
    clearFocusIfMatches(doc, 'win-1');
    expect(getFocusedWindowId(doc)).toBeNull();
  });

  it('automatically blurs focus during drag handoffs and coordinator reassignments', () => {
    const doc = new Y.Doc();
    const devicesMap = doc.getMap<Device>('devices');
    const windowsMap = doc.getMap<WindowInstance>('windows');

    const peerA: Device = {
      id: 'peer-A',
      name: 'Screen A',
      width: 1000,
      height: 600,
      dpiScale: 1,
      x: 0,
      y: 0,
      status: 'connected',
      type: 'desktop',
    };

    const peerB: Device = {
      id: 'peer-B',
      name: 'Screen B',
      width: 1000,
      height: 600,
      dpiScale: 1,
      x: 1000, // Adjacent right
      y: 0,
      status: 'connected',
      type: 'desktop',
    };

    devicesMap.set(peerA.id, peerA);
    devicesMap.set(peerB.id, peerB);

    const win: WindowInstance = {
      id: 'win-1',
      title: 'Real Editor',
      width: 800,
      height: 600,
      x: 0,
      y: 0,
      owningDeviceId: 'peer-A',
      capturingDeviceId: 'peer-A',
      hasActiveCapture: true,
    };
    windowsMap.set(win.id, win);

    // 1. Focus the window
    focusWindow(doc, 'win-1');
    expect(getFocusedWindowId(doc)).toBe('win-1');

    // 2. Perform border crossing handoff
    // Drag window cursor across seam (x = 1050)
    import('../src/handoffEngine.js').then(({ handleWindowDrag, reassignDisconnectedDeviceWindows }) => {
      handleWindowDrag('win-1', 1050, 300, 'peer-A', [peerA, peerB], windowsMap);
      
      // Ownership is now peer-B, and focus must be cleared (null)
      expect(windowsMap.get('win-1')?.owningDeviceId).toBe('peer-B');
      expect(getFocusedWindowId(doc)).toBeNull();

      // Refocus window
      focusWindow(doc, 'win-1');
      expect(getFocusedWindowId(doc)).toBe('win-1');

      // 3. Perform coordinator reassignment on disconnect
      devicesMap.set('peer-B', { ...peerB, status: 'disconnected' });
      reassignDisconnectedDeviceWindows('peer-B', devicesMap, windowsMap);

      // Ownership should shift back to A (since B disconnected), and focus cleared again
      expect(windowsMap.get('win-1')?.owningDeviceId).toBe('peer-A');
      expect(getFocusedWindowId(doc)).toBeNull();
    });
  });
});
