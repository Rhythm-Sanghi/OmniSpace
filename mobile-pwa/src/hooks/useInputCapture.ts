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
  containerRef?: React.RefObject<HTMLDivElement | null>
) {
  const lastMouseMoveTimeRef = useRef<number>(0);
  const windowStateRef = useRef<WindowInstance>(windowState);
  windowStateRef.current = windowState;

  // 1. Mouse Event Handlers (attached to window container)
  const handleMouseEvent = (
    type: 'mousedown' | 'mousemove' | 'mouseup',
    e: React.MouseEvent<HTMLDivElement>
  ) => {
    if (!rtcManager) return;
    const currentWin = windowStateRef.current;
    if (currentWin.capturingDeviceId === localDeviceId) return; // Self-captured is handled locally

    const container = containerRef?.current || (e.currentTarget as HTMLDivElement);
    if (!container) return;
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

    const capturingDevice = devicesMap.get(currentWin.capturingDeviceId);
    if (!capturingDevice) return;

    const realCoords = translateToRealCoordinates(
      { x, y },
      { width: rect.width, height: rect.height },
      currentWin,
      capturingDevice
    );

    if (!realCoords) return;

    let eventPayload: InputEventEnvelope['event'];
    if (type === 'mousemove') {
      eventPayload = {
        type: 'mousemove',
        data: {
          x: realCoords.x,
          y: realCoords.y,
        },
      };
    } else {
      eventPayload = {
        type,
        data: {
          x: realCoords.x,
          y: realCoords.y,
          button: e.button,
        },
      };
    }

    const envelope: InputEventEnvelope = {
      targetWindowId: currentWin.id,
      event: eventPayload,
      timestamp: Date.now(),
    };

    rtcManager.sendMouseInput(currentWin.capturingDeviceId, envelope);
  };

  const handleWheelEvent = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!rtcManager) return;
    const currentWin = windowStateRef.current;
    if (currentWin.capturingDeviceId === localDeviceId) return;

    const container = containerRef?.current || (e.currentTarget as HTMLDivElement);
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const capturingDevice = devicesMap.get(currentWin.capturingDeviceId);
    if (!capturingDevice) return;

    const realCoords = translateToRealCoordinates(
      { x, y },
      { width: rect.width, height: rect.height },
      currentWin,
      capturingDevice
    );

    if (!realCoords) return;

    const envelope: InputEventEnvelope = {
      targetWindowId: currentWin.id,
      event: {
        type: 'scroll',
        data: {
          x: realCoords.x,
          y: realCoords.y,
          deltaX: e.deltaX,
          deltaY: e.deltaY,
        },
      },
      timestamp: Date.now(),
    };

    rtcManager.sendMouseInput(currentWin.capturingDeviceId, envelope);
  };

  // 2. Global Keyboard Event Hook (listens to global window context if focused)
  useEffect(() => {
    if (!rtcManager) return;

    const handleKeyboard = (type: 'keydown' | 'keyup', e: KeyboardEvent) => {
      const currentWin = windowStateRef.current;
      // Focus gating checks
      const focusedId = getFocusedWindowId(rtcManager.doc);
      if (focusedId !== currentWin.id) return;
      if (currentWin.owningDeviceId !== localDeviceId) return;
      if (currentWin.capturingDeviceId === localDeviceId) return;

      const isDevShortcut =
        e.key === 'F12' ||
        ((e.ctrlKey || e.metaKey) && ['r', 'R', 'i', 'I'].includes(e.key));
      if (!isDevShortcut) {
        e.preventDefault();
      }

      const envelope: InputEventEnvelope = {
        targetWindowId: currentWin.id,
        event: {
          type,
          data: {
            code: e.code,
            key: e.key,
          },
        },
        timestamp: Date.now(),
      };

      rtcManager.sendKeyboardInput(currentWin.capturingDeviceId, envelope);
    };

    const onKeyDown = (e: KeyboardEvent) => handleKeyboard('keydown', e);
    const onKeyUp = (e: KeyboardEvent) => handleKeyboard('keyup', e);

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [rtcManager, windowState.id, localDeviceId]);

  return {
    onMouseDown: (e: React.MouseEvent<HTMLDivElement>) => handleMouseEvent('mousedown', e),
    onMouseMove: (e: React.MouseEvent<HTMLDivElement>) => handleMouseEvent('mousemove', e),
    onMouseUp: (e: React.MouseEvent<HTMLDivElement>) => handleMouseEvent('mouseup', e),
    onWheel: handleWheelEvent,
  };
}
