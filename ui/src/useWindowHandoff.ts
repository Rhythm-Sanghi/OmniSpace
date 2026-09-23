import { useState, useRef, useEffect, useCallback } from 'react';
import type { PanInfo } from 'framer-motion';
import * as Y from 'yjs';
import { Device, WindowInstance, claimWindowOwnership, updateWindowPosition, handleWindowDrag } from 'core';

export function useWindowHandoff(
  localDeviceId: string,
  localDevice: Device | null,
  devices: Device[],
  windowsMap?: Y.Map<WindowInstance> | null,
  visualScale: number = 1
) {
  const [activeWindowId, setActiveWindowId] = useState<string | null>(null);
  const activeWindowIdRef = useRef<string | null>(null);

  const setTrackedActiveWindowId = useCallback((id: string | null) => {
    activeWindowIdRef.current = id;
    setActiveWindowId(id);
  }, []);
  
  // Track offset of cursor/touch relative to window top-left at start of drag
  const dragOffsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // Safety net: Observe Yjs windows map to clear local active dragging if ownership is revoked remotely
  useEffect(() => {
    if (!windowsMap) return;

    const observeWindows = () => {
      const currentActiveId = activeWindowIdRef.current;
      if (currentActiveId) {
        const win = windowsMap.get(currentActiveId);
        if (win && win.owningDeviceId !== localDeviceId) {
          // Ownership was revoked/reassigned remotely. Cancel active drag.
          setTrackedActiveWindowId(null);
        }
      }
    };

    windowsMap.observe(observeWindows);
    return () => {
      windowsMap.unobserve(observeWindows);
    };
  }, [localDeviceId, windowsMap, setTrackedActiveWindowId]);

  const handleDragStart = useCallback((windowId: string, event: MouseEvent | TouchEvent | PointerEvent) => {
    if (!localDevice || !windowsMap) return;

    // Try to claim ownership first
    const success = claimWindowOwnership(windowId, localDeviceId, windowsMap);
    if (!success) {
      // Failed to claim ownership (locked by another peer). Abort.
      return;
    }

    const win = windowsMap.get(windowId);
    if (!win) return;

    const scale = visualScale > 0 ? visualScale : 1;

    // Calculate cursor/touch local offset relative to window top-left in device pixels
    const anyEvent = event as any;
    const rawX = anyEvent.clientX !== undefined ? anyEvent.clientX : anyEvent.touches?.[0]?.clientX;
    const rawY = anyEvent.clientY !== undefined ? anyEvent.clientY : anyEvent.touches?.[0]?.clientY;
    const clientX = (typeof rawX === 'number' && Number.isFinite(rawX) ? rawX : 0) / scale;
    const clientY = (typeof rawY === 'number' && Number.isFinite(rawY) ? rawY : 0) / scale;

    const winLocalX = win.x - localDevice.x;
    const winLocalY = win.y - localDevice.y;

    dragOffsetRef.current = {
      x: clientX - winLocalX,
      y: clientY - winLocalY,
    };

    setTrackedActiveWindowId(windowId);
  }, [localDevice, windowsMap, visualScale, localDeviceId, setTrackedActiveWindowId]);

  const handleDrag = useCallback((windowId: string, _event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    if (!localDevice || !windowsMap || activeWindowIdRef.current !== windowId) return;

    const scale = visualScale > 0 ? visualScale : 1;

    // Calculate new global coordinates of the window based on pointer position in device pixels
    const cursorLx = info.point.x / scale;
    const cursorLy = info.point.y / scale;

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
      setTrackedActiveWindowId(null);
    }
  }, [localDevice, windowsMap, visualScale, localDeviceId, devices, setTrackedActiveWindowId]);

  const handleDragEnd = useCallback((windowId: string, _event: MouseEvent | TouchEvent | PointerEvent, _info?: PanInfo) => {
    if (activeWindowIdRef.current === windowId) {
      setTrackedActiveWindowId(null);
    }
  }, [setTrackedActiveWindowId]);

  return {
    activeWindowId,
    handleDragStart,
    handleDrag,
    handleDragEnd,
  };
}
