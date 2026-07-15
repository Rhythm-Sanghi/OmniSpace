import { useEffect, useRef } from 'react';
import * as Y from 'yjs';
import {
  WindowInstance,
  Device,
  OmniRTCManager,
  translateToRealCoordinates,
  InputEventEnvelope,
  getFocusedWindowId,
} from 'core';

export function useInputCapture(
  localDeviceId: string,
  rtcManager: OmniRTCManager | null,
  windowState: WindowInstance,
  devicesMap: Y.Map<Device>,
  containerRef: React.RefObject<HTMLDivElement | null>
) {
  const lastMouseMoveTimeRef = useRef<number>(0);

  // 1. Mouse Event Handlers (attached to <video> container)
  const handleMouseEvent = (
    type: 'mousedown' | 'mousemove' | 'mouseup',
    e: React.MouseEvent<HTMLDivElement>
  ) => {
    if (!rtcManager || !containerRef.current) return;
    if (windowState.capturingDeviceId === localDeviceId) return; // Self-captured is handled locally

    const container = containerRef.current;
    const rect = container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Rate-limit mouse moves to 60fps (~16ms)
    if (type === 'mousemove') {
      const now = Date.now();
      if (now - lastMouseMoveTimeRef.current < 16) {
        return;
      }
      lastMouseMoveTimeRef.current = now;
    }

    const capturingDevice = devicesMap.get(windowState.capturingDeviceId);
    if (!capturingDevice) return;

    const translated = translateToRealCoordinates(
      { x, y },
      { width: rect.width, height: rect.height },
      windowState,
      capturingDevice
    );

    if (translated) {
      const envelope: InputEventEnvelope = {
        targetWindowId: windowState.id,
        event: {
          type,
          data: {
            x: translated.x,
            y: translated.y,
            button: e.button,
          },
        } as any,
        timestamp: Date.now(),
      };
      rtcManager.sendMouseInput(windowState.capturingDeviceId, envelope);
    }
  };

  // Scroll/Wheel Event Handler
  const handleWheelEvent = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!rtcManager || !containerRef.current) return;
    if (windowState.capturingDeviceId === localDeviceId) return;

    const container = containerRef.current;
    const rect = container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const capturingDevice = devicesMap.get(windowState.capturingDeviceId);
    if (!capturingDevice) return;

    const translated = translateToRealCoordinates(
      { x, y },
      { width: rect.width, height: rect.height },
      windowState,
      capturingDevice
    );

    if (translated) {
      const envelope: InputEventEnvelope = {
        targetWindowId: windowState.id,
        event: {
          type: 'scroll',
          data: {
            x: translated.x,
            y: translated.y,
            deltaX: e.deltaX,
            deltaY: e.deltaY,
          },
        },
        timestamp: Date.now(),
      };
      rtcManager.sendMouseInput(windowState.capturingDeviceId, envelope);
    }
  };

  // 2. Global Keyboard Event Hook (listens to global window context if focused)
  useEffect(() => {
    if (!rtcManager) return;

    const handleKeyboard = (type: 'keydown' | 'keyup', e: KeyboardEvent) => {
      // Focus gating checks
      const focusedId = getFocusedWindowId(rtcManager.doc);
      if (focusedId !== windowState.id) return;
      if (windowState.owningDeviceId !== localDeviceId) return;
      if (windowState.capturingDeviceId === localDeviceId) return;

      // Prevent system keys (e.g. Tab, spacebar) from scrolling page
      e.preventDefault();

      const envelope: InputEventEnvelope = {
        targetWindowId: windowState.id,
        event: {
          type,
          data: {
            code: e.code,
            key: e.key,
          },
        },
        timestamp: Date.now(),
      };

      rtcManager.sendKeyboardInput(windowState.capturingDeviceId, envelope);
    };

    const onKeyDown = (e: KeyboardEvent) => handleKeyboard('keydown', e);
    const onKeyUp = (e: KeyboardEvent) => handleKeyboard('keyup', e);

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [rtcManager, windowState, localDeviceId]);

  return {
    onMouseDown: (e: React.MouseEvent<HTMLDivElement>) => handleMouseEvent('mousedown', e),
    onMouseMove: (e: React.MouseEvent<HTMLDivElement>) => handleMouseEvent('mousemove', e),
    onMouseUp: (e: React.MouseEvent<HTMLDivElement>) => handleMouseEvent('mouseup', e),
    onWheel: handleWheelEvent,
  };
}
