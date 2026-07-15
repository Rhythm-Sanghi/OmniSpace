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
  const dragOffsetRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    if (!activeWindowId) return;

    const observeWindows = (event: Y.YMapEvent<WindowInstance>) => {
      if (event.transaction.origin === 'remote') {
        const win = windowsMap.get(activeWindowId);
        if (win && win.owningDeviceId !== localDeviceId) {
          // Ownership hijacked. Abort local drag.
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

    const success = claimWindowOwnership(windowId, localDeviceId, windowsMap);
    if (!success) return;

    const win = windowsMap.get(windowId);
    if (!win) return;

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

    const cursorLx = info.point.x;
    const cursorLy = info.point.y;

    const newWinGx = cursorLx - dragOffsetRef.current.x + localDevice.x;
    const newWinGy = cursorLy - dragOffsetRef.current.y + localDevice.y;

    updateWindowPosition(windowId, newWinGx, newWinGy, localDeviceId, windowsMap);

    const cursorGx = cursorLx + localDevice.x;
    const cursorGy = cursorLy + localDevice.y;

    const targetPeerId = handleWindowDrag(
      windowId,
      cursorGx,
      cursorGy,
      localDeviceId,
      devices,
      windowsMap
    );

    if (targetPeerId) {
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
