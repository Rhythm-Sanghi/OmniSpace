import { useState, useRef, useEffect } from 'react';
import * as Y from 'yjs';
import { Device, WindowInstance, claimWindowOwnership, updateWindowPosition, handleWindowDrag } from 'core';

export function useWindowHandoff(
  localDeviceId: string,
  localDevice: Device | null,
  devices: Device[],
  windowsMap: Y.Map<WindowInstance>
) {
  const [activeWindowId, setActiveWindowId] = useState<string | null>(null);
  
  // Track offset of cursor relative to window top-left at start of drag
  const dragOffsetRef = useRef({ x: 0, y: 0 });

  // Listen to changes in the windows map. If we lose ownership mid-drag, abort dragging.
  useEffect(() => {
    if (!activeWindowId) return;

    const observeWindows = (event: Y.YMapEvent<WindowInstance>) => {
      // Find if our active window was updated by a remote peer
      if (event.transaction.origin === 'remote') {
        const win = windowsMap.get(activeWindowId);
        if (win && win.owningDeviceId !== localDeviceId) {
          // Ownership was hijacked by Yjs conflict resolution! Abort local drag.
          setActiveWindowId(null);
        }
      }
    };

    windowsMap.observe(observeWindows);
    return () => {
      windowsMap.unobserve(observeWindows);
    };
  }, [activeWindowId, localDeviceId, windowsMap]);

  const handleDragStart = (windowId: string, event: any) => {
    if (!localDevice) return;

    // Try to claim ownership first
    const success = claimWindowOwnership(windowId, localDeviceId, windowsMap);
    if (!success) {
      // Failed to claim ownership (locked by another peer). Abort.
      return;
    }

    const win = windowsMap.get(windowId);
    if (!win) return;

    // Calculate cursor local offset relative to window top-left
    const clientX = event.clientX || (event.touches && event.touches[0]?.clientX) || 0;
    const clientY = event.clientY || (event.touches && event.touches[0]?.clientY) || 0;

    const winLocalX = win.x - localDevice.x;
    const winLocalY = win.y - localDevice.y;

    dragOffsetRef.current = {
      x: clientX - winLocalX,
      y: clientY - winLocalY,
    };

    setActiveWindowId(windowId);
  };

  const handleDrag = (windowId: string, _event: any, info: any) => {
    if (!localDevice || activeWindowId !== windowId) return;

    // Calculate new global coordinates of the window based on cursor position
    const cursorLx = info.point.x;
    const cursorLy = info.point.y;

    const newWinGx = cursorLx - dragOffsetRef.current.x + localDevice.x;
    const newWinGy = cursorLy - dragOffsetRef.current.y + localDevice.y;

    // Update global position
    updateWindowPosition(windowId, newWinGx, newWinGy, localDeviceId, windowsMap);

    // Calculate cursor global coordinates
    const cursorGx = cursorLx + localDevice.x;
    const cursorGy = cursorLy + localDevice.y;

    // Run edge detection crossing to check if we should handoff
    const targetPeerId = handleWindowDrag(
      windowId,
      cursorGx,
      cursorGy,
      localDeviceId,
      devices,
      windowsMap
    );

    if (targetPeerId) {
      // Handoff successful! Abort local dragging state
      setActiveWindowId(null);
    }
  };

  const handleDragEnd = (windowId: string, _event: any, _info: any) => {
    if (activeWindowId === windowId) {
      setActiveWindowId(null);
    }
  };

  return {
    activeWindowId,
    handleDragStart,
    handleDrag,
    handleDragEnd,
  };
}
