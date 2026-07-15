import { useRef } from 'react';
import * as Y from 'yjs';
import {
  WindowInstance,
  Device,
  OmniRTCManager,
  translateToRealCoordinates,
  InputEventEnvelope,
} from 'core';

export function useTouchInputCapture(
  localDeviceId: string,
  rtcManager: OmniRTCManager | null,
  windowState: WindowInstance,
  devicesMap: Y.Map<Device>,
  containerRef: React.RefObject<HTMLDivElement | null>
) {
  const lastMouseMoveTimeRef = useRef<number>(0);

  const handleTouch = (type: 'mousedown' | 'mousemove' | 'mouseup', e: React.TouchEvent) => {
    if (!rtcManager || !containerRef.current) return;
    if (windowState.capturingDeviceId === localDeviceId) return; // Ignore if self-captured

    const container = containerRef.current;
    const rect = container.getBoundingClientRect();
    const touch = e.touches[0] || e.changedTouches[0];
    if (!touch) return;

    const x = touch.clientX - rect.left;
    const y = touch.clientY - rect.top;

    // Rate limit touchmove/mousemove to 60fps (~16ms)
    if (type === 'mousemove') {
      const now = Date.now();
      if (now - lastMouseMoveTimeRef.current < 16) {
        return;
      }
      lastMouseMoveTimeRef.current = now;
    }

    // Look up capturing device details to perform DPI mapping projections
    const capturingDevice = devicesMap.get(windowState.capturingDeviceId);
    if (!capturingDevice) return;

    // Perform video offset aspect-ratio coordinate translation
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
            button: 0, // Touch maps to left click (button 0)
          },
        } as any,
        timestamp: Date.now(),
      };

      rtcManager.sendMouseInput(windowState.capturingDeviceId, envelope);
    }
  };

  return {
    onTouchStart: (e: React.TouchEvent) => handleTouch('mousedown', e),
    onTouchMove: (e: React.TouchEvent) => handleTouch('mousemove', e),
    onTouchEnd: (e: React.TouchEvent) => handleTouch('mouseup', e),
  };
}
