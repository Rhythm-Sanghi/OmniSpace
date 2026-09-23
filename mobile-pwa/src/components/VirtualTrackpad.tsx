import React, { useRef, useState, useCallback } from 'react';
import { OmniRTCManager, WindowInstance, Device, InputEventEnvelope } from 'core';

interface VirtualTrackpadProps {
  rtcManager: OmniRTCManager | null;
  targetWindow: WindowInstance | null;
  capturingDevice: Device | null;
}

export const VirtualTrackpad: React.FC<VirtualTrackpadProps> = ({
  rtcManager,
  targetWindow,
  capturingDevice,
}) => {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [isPressing, setIsPressing] = useState(false);
  const [activeTouches, setActiveTouches] = useState(0);
  const [gestureNotice, setGestureNotice] = useState<string | null>(null);

  // Virtual cursor position in window local coordinates
  const cursorPosRef = useRef<{ x: number; y: number }>({
    x: targetWindow ? targetWindow.width / 2 : 400,
    y: targetWindow ? targetWindow.height / 2 : 300,
  });

  const touchStartRef = useRef<{
    time: number;
    count: number;
    x: number;
    y: number;
    totalMoved: number;
    initialDistance?: number;
    threeFingerStartX?: number;
    threeFingerStartY?: number;
  }>({
    time: 0,
    count: 0,
    x: 0,
    y: 0,
    totalMoved: 0,
  });

  const lastPosRef = useRef<{ x: number; y: number } | null>(null);
  const lastDistanceRef = useRef<number | null>(null);
  const lastMoveSentRef = useRef<number>(0);
  const gestureTriggeredRef = useRef<boolean>(false);

  const showGestureToast = (text: string) => {
    setGestureNotice(text);
    setTimeout(() => setGestureNotice(null), 1200);
  };

  const sendEvent = useCallback(
    (event: InputEventEnvelope['event']) => {
      if (!rtcManager || !targetWindow || !capturingDevice) return;

      const envelope: InputEventEnvelope = {
        targetWindowId: targetWindow.id,
        timestamp: Date.now(),
        event,
      };

      if (event.type === 'keydown' || event.type === 'keyup') {
        rtcManager.sendKeyboardInput(capturingDevice.id, envelope);
      } else {
        rtcManager.sendMouseInput(capturingDevice.id, envelope);
      }
    },
    [rtcManager, targetWindow, capturingDevice]
  );

  const triggerKeyShortcut = useCallback(
    (keys: Array<{ code: string; key: string }>) => {
      keys.forEach((k) => sendEvent({ type: 'keydown', data: k }));
      setTimeout(() => {
        keys.forEach((k) => sendEvent({ type: 'keyup', data: k }));
      }, 50);
    },
    [sendEvent]
  );

  const clampCoords = useCallback(
    (x: number, y: number) => {
      const maxX = targetWindow?.width ?? 800;
      const maxY = targetWindow?.height ?? 600;
      return {
        x: Math.max(0, Math.min(maxX, x)),
        y: Math.max(0, Math.min(maxY, y)),
      };
    },
    [targetWindow]
  );

  const handlePointerDown = (e: React.TouchEvent) => {
    const touches = e.touches;
    setActiveTouches(touches.length);
    setIsPressing(true);
    gestureTriggeredRef.current = false;

    const first = touches[0];
    let initialDist: number | undefined;
    if (touches.length === 2) {
      initialDist = Math.hypot(
        touches[0].clientX - touches[1].clientX,
        touches[0].clientY - touches[1].clientY
      );
      lastDistanceRef.current = initialDist;
    } else {
      lastDistanceRef.current = null;
    }

    let avg3X: number | undefined;
    let avg3Y: number | undefined;
    if (touches.length === 3) {
      avg3X = (touches[0].clientX + touches[1].clientX + touches[2].clientX) / 3;
      avg3Y = (touches[0].clientY + touches[1].clientY + touches[2].clientY) / 3;
    }

    touchStartRef.current = {
      time: Date.now(),
      count: touches.length,
      x: first.clientX,
      y: first.clientY,
      totalMoved: 0,
      initialDistance: initialDist,
      threeFingerStartX: avg3X,
      threeFingerStartY: avg3Y,
    };
    lastPosRef.current = { x: first.clientX, y: first.clientY };
  };

  const handlePointerMove = (e: React.TouchEvent) => {
    const touches = e.touches;
    setActiveTouches(touches.length);

    if (!lastPosRef.current) return;
    const now = Date.now();

    if (touches.length === 1) {
      // 1 Finger: Relative cursor movement
      const touch = touches[0];
      const dx = (touch.clientX - lastPosRef.current.x) * 1.5;
      const dy = (touch.clientY - lastPosRef.current.y) * 1.5;

      touchStartRef.current.totalMoved += Math.hypot(dx, dy);
      lastPosRef.current = { x: touch.clientX, y: touch.clientY };

      const newPos = clampCoords(
        cursorPosRef.current.x + dx,
        cursorPosRef.current.y + dy
      );
      cursorPosRef.current = newPos;

      if (now - lastMoveSentRef.current >= 16) {
        lastMoveSentRef.current = now;
        sendEvent({
          type: 'mousemove',
          data: { x: Math.round(newPos.x), y: Math.round(newPos.y) },
        });
      }
    } else if (touches.length === 2) {
      const currentDist = Math.hypot(
        touches[0].clientX - touches[1].clientX,
        touches[0].clientY - touches[1].clientY
      );
      const prevDist = lastDistanceRef.current ?? currentDist;
      const pinchDelta = currentDist - prevDist;

      // Pinch-to-zoom detection
      if (Math.abs(pinchDelta) > 4) {
        lastDistanceRef.current = currentDist;
        if (now - lastMoveSentRef.current >= 30) {
          lastMoveSentRef.current = now;
          // Synthesize Ctrl + wheel scroll for desktop browser/IDE zooming
          sendEvent({ type: 'keydown', data: { code: 'ControlLeft', key: 'Control' } });
          sendEvent({
            type: 'scroll',
            data: {
              x: Math.round(cursorPosRef.current.x),
              y: Math.round(cursorPosRef.current.y),
              deltaX: 0,
              deltaY: pinchDelta > 0 ? -40 : 40,
            },
          });
          setTimeout(() => {
            sendEvent({ type: 'keyup', data: { code: 'ControlLeft', key: 'Control' } });
          }, 30);
          showGestureToast(pinchDelta > 0 ? 'Zoom In' : 'Zoom Out');
        }
      } else {
        // 2 Fingers: Standard Vertical & horizontal scroll
        const touch = touches[0];
        const dx = (touch.clientX - lastPosRef.current.x) * 2;
        const dy = (touch.clientY - lastPosRef.current.y) * 2;

        touchStartRef.current.totalMoved += Math.hypot(dx, dy);
        lastPosRef.current = { x: touch.clientX, y: touch.clientY };

        if (now - lastMoveSentRef.current >= 24) {
          lastMoveSentRef.current = now;
          sendEvent({
            type: 'scroll',
            data: {
              x: Math.round(cursorPosRef.current.x),
              y: Math.round(cursorPosRef.current.y),
              deltaX: -Math.round(dx),
              deltaY: -Math.round(dy),
            },
          });
        }
      }
    } else if (touches.length === 3 && !gestureTriggeredRef.current) {
      // 3 Fingers: Swipe gestures
      const avgX = (touches[0].clientX + touches[1].clientX + touches[2].clientX) / 3;
      const avgY = (touches[0].clientY + touches[1].clientY + touches[2].clientY) / 3;
      const startX = touchStartRef.current.threeFingerStartX ?? avgX;
      const startY = touchStartRef.current.threeFingerStartY ?? avgY;

      const diffX = avgX - startX;
      const diffY = avgY - startY;

      if (diffY < -50) {
        // 3-Finger Swipe UP -> Task View
        gestureTriggeredRef.current = true;
        triggerKeyShortcut([
          { code: 'MetaLeft', key: 'Meta' },
          { code: 'Tab', key: 'Tab' },
        ]);
        showGestureToast('Task View');
      } else if (diffX < -50) {
        // 3-Finger Swipe LEFT -> Next Virtual Desktop
        gestureTriggeredRef.current = true;
        triggerKeyShortcut([
          { code: 'ControlLeft', key: 'Control' },
          { code: 'MetaLeft', key: 'Meta' },
          { code: 'ArrowRight', key: 'ArrowRight' },
        ]);
        showGestureToast('Next Desktop');
      } else if (diffX > 50) {
        // 3-Finger Swipe RIGHT -> Prev Virtual Desktop
        gestureTriggeredRef.current = true;
        triggerKeyShortcut([
          { code: 'ControlLeft', key: 'Control' },
          { code: 'MetaLeft', key: 'Meta' },
          { code: 'ArrowLeft', key: 'ArrowLeft' },
        ]);
        showGestureToast('Prev Desktop');
      }
    }
  };

  const handlePointerEnd = (e: React.TouchEvent) => {
    const remainingTouches = e.touches.length;
    setActiveTouches(remainingTouches);

    if (remainingTouches === 0) {
      setIsPressing(false);
      lastPosRef.current = null;
      lastDistanceRef.current = null;

      const duration = Date.now() - touchStartRef.current.time;
      const moved = touchStartRef.current.totalMoved;
      const initialFingerCount = touchStartRef.current.count;

      // Tap detection (under 300ms and minimal movement)
      if (duration < 300 && moved < 15 && !gestureTriggeredRef.current) {
        if (initialFingerCount === 1) {
          // 1 Finger Tap: Left Click
          triggerClick(0);
        } else if (initialFingerCount === 2) {
          // 2 Finger Tap: Right Click
          triggerClick(2);
        }
      }
    }
  };

  const triggerClick = (button: number) => {
    const { x, y } = cursorPosRef.current;
    sendEvent({
      type: 'mousedown',
      data: { x: Math.round(x), y: Math.round(y), button },
    });
    setTimeout(() => {
      sendEvent({
        type: 'mouseup',
        data: { x: Math.round(x), y: Math.round(y), button },
      });
    }, 50);
  };

  return (
    <div className="flex flex-col w-full h-full max-w-lg select-none">
      {/* Trackpad touch surface */}
      <div
        ref={surfaceRef}
        onTouchStart={handlePointerDown}
        onTouchMove={handlePointerMove}
        onTouchEnd={handlePointerEnd}
        onTouchCancel={handlePointerEnd}
        className={`relative flex-1 rounded-2xl border-2 transition-all flex flex-col items-center justify-center cursor-crosshair touch-none ${
          isPressing
            ? 'bg-purple-950/40 border-purple-500/70 shadow-inner'
            : 'bg-slate-900/60 border-slate-700/60 shadow-xl'
        }`}
      >
        <div className="text-center pointer-events-none opacity-40">
          <p className="text-xs uppercase tracking-widest font-mono text-purple-300">
            Precision Trackpad
          </p>
          <p className="text-[10px] text-slate-400 mt-1">
            1-Finger Drag: Move • Tap: Left Click
          </p>
          <p className="text-[10px] text-slate-400">
            2-Finger Drag: Scroll • 2-Finger Tap: Right Click
          </p>
        </div>

        {/* Status pill */}
        <div className="absolute top-3 right-3 text-[10px] font-mono px-2 py-0.5 rounded-full bg-slate-800/80 border border-slate-700 text-slate-400">
          {activeTouches > 0 ? `${activeTouches} Touch${activeTouches > 1 ? 'es' : ''}` : 'Ready'}
        </div>

        {/* Gesture feedback toast */}
        {gestureNotice && (
          <div className="absolute top-3 left-3 text-xs font-semibold px-2.5 py-1 rounded-full bg-purple-600/90 text-white shadow-lg shadow-purple-600/30 animate-pulse pointer-events-none">
            {gestureNotice}
          </div>
        )}
      </div>

      {/* Dedicated physical click bars at bottom */}
      <div className="flex gap-2 mt-2 h-14">
        <button
          type="button"
          onTouchStart={(e) => {
            e.stopPropagation();
            triggerClick(0);
          }}
          onClick={() => triggerClick(0)}
          className="flex-1 rounded-xl bg-slate-800/80 border border-slate-700 active:bg-purple-600 active:text-white text-slate-300 text-xs font-semibold uppercase tracking-wider transition"
        >
          Left Click
        </button>
        <button
          type="button"
          onTouchStart={(e) => {
            e.stopPropagation();
            triggerClick(2);
          }}
          onClick={() => triggerClick(2)}
          className="flex-1 rounded-xl bg-slate-800/80 border border-slate-700 active:bg-purple-600 active:text-white text-slate-300 text-xs font-semibold uppercase tracking-wider transition"
        >
          Right Click
        </button>
      </div>
    </div>
  );
};
