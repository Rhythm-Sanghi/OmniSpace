import React, { useRef } from 'react';
import { motion, type PanInfo } from 'framer-motion';
import { Maximize2, Minimize2 } from 'lucide-react';
import { Device, WindowInstance } from 'core';

export type DragEvent = MouseEvent | TouchEvent | PointerEvent;

interface MockOSWindowProps {
  localDeviceId: string;
  localDevice: Device;
  windowState: WindowInstance;
  onDragStart: (windowId: string, event: DragEvent) => void;
  onDrag: (windowId: string, event: DragEvent, info: PanInfo) => void;
  onDragEnd: (windowId: string, event: DragEvent, info: PanInfo) => void;
  onResize?: (windowId: string, width: number, height: number) => void;
  onToggleMaximize?: (windowId: string) => void;
}

export const MockOSWindow: React.FC<MockOSWindowProps> = ({
  localDeviceId,
  localDevice,
  windowState,
  onDragStart,
  onDrag,
  onDragEnd,
  onResize,
  onToggleMaximize,
}) => {
  const dragRef = useRef<HTMLDivElement>(null);
  const isOwner = windowState.owningDeviceId === localDeviceId;

  // Calculate if the window overlaps this device's screen geometry
  const overlapsDevice =
    windowState.x + windowState.width > localDevice.x &&
    windowState.x < localDevice.x + localDevice.width &&
    windowState.y + windowState.height > localDevice.y &&
    windowState.y < localDevice.y + localDevice.height;

  // Render nothing if it is not owned and doesn't overlap
  if (!isOwner && !overlapsDevice) {
    return null;
  }

  // Calculate local coordinates on our device
  const lx = windowState.x - localDevice.x;
  const ly = windowState.y - localDevice.y;

  return (
    <motion.div
      ref={dragRef}
      role="application"
      aria-label={`Window: ${windowState.title}`}
      aria-roledescription="Virtual OS Window"
      drag={isOwner}
      dragMomentum={false}
      dragElastic={0}
      onDragStart={(e) => onDragStart(windowState.id, e)}
      onDrag={(e, info) => onDrag(windowState.id, e, info)}
      onDragEnd={(e, info) => onDragEnd(windowState.id, e, info)}
      style={{
        position: 'absolute',
        left: lx,
        top: ly,
        width: windowState.width,
        height: windowState.height,
        zIndex: isOwner ? 1000 : 500,
        pointerEvents: isOwner ? 'auto' : 'none', // Block input on non-owners
        opacity: isOwner ? 1 : 0.85,
      }}
      transition={isOwner ? { type: 'spring', stiffness: 300, damping: 25 } : { duration: 0 }}
    >
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: 'rgba(30, 41, 59, 0.75)',
          backdropFilter: 'blur(16px)',
          borderRadius: '12px',
          border: isOwner
            ? '1.5px solid rgba(168, 85, 247, 0.4)'
            : '1px dashed rgba(255, 255, 255, 0.15)',
          boxShadow: isOwner
            ? '0 20px 25px -5px rgba(0, 0, 0, 0.4), 0 0 15px rgba(168, 85, 247, 0.15)'
            : '0 10px 15px -3px rgba(0, 0, 0, 0.3)',
          overflow: 'hidden',
          transition: 'border-color 0.2s, box-shadow 0.2s',
        }}
      >
        {/* Title bar */}
        <div
          className="window-titlebar"
          style={{
            height: '38px',
            backgroundColor: 'rgba(15, 23, 42, 0.6)',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            display: 'flex',
            alignItems: 'center',
            padding: '0 12px',
            cursor: isOwner ? 'grab' : 'default',
            userSelect: 'none',
          }}
        >
          {/* Mac-style Window Controls */}
          <div aria-hidden="true" style={{ display: 'flex', gap: '6px', marginRight: '16px' }}>
            <div
              style={{
                width: '11px',
                height: '11px',
                borderRadius: '50%',
                backgroundColor: '#ef4444',
                opacity: 0.8,
              }}
            />
            <div
              style={{
                width: '11px',
                height: '11px',
                borderRadius: '50%',
                backgroundColor: '#f59e0b',
                opacity: 0.8,
              }}
            />
            <div
              style={{
                width: '11px',
                height: '11px',
                borderRadius: '50%',
                backgroundColor: '#10b981',
                opacity: 0.8,
              }}
            />
          </div>

          <div
            style={{
              color: '#94a3b8',
              fontSize: '11px',
              fontWeight: 600,
              flex: 1,
              textAlign: 'center',
              marginRight: '60px', // Balance controls
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {windowState.title}
          </div>

          {/* Owner badge & controls */}
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            {isOwner && (
              <div
                style={{
                  backgroundColor: 'rgba(168, 85, 247, 0.2)',
                  border: '1px solid rgba(168, 85, 247, 0.4)',
                  color: '#c084fc',
                  fontSize: '9px',
                  fontWeight: 700,
                  padding: '1px 6px',
                  borderRadius: '4px',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                Local
              </div>
            )}
            {isOwner && onToggleMaximize && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleMaximize(windowState.id);
                }}
                className="p-1 hover:bg-white/10 rounded transition-colors text-slate-300 hover:text-white cursor-pointer"
                aria-label={windowState.isMaximized ? 'Restore window' : 'Maximize window'}
                title={windowState.isMaximized ? 'Restore window' : 'Maximize window'}
              >
                {windowState.isMaximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
              </button>
            )}
          </div>
        </div>

        {/* Content body */}
        <div
          style={{
            flex: 1,
            padding: '16px',
            color: '#cbd5e1',
            fontSize: '12px',
            fontFamily: 'monospace',
            backgroundColor: 'rgba(15, 23, 42, 0.3)',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            userSelect: 'none',
          }}
        >
          {(() => {
            const titleLower = windowState.title.toLowerCase();
            if (titleLower.includes('editor') || titleLower.includes('code')) {
              return (
                <>
                  <div style={{ color: '#6366f1' }}>// Omni-Space Code Editor</div>
                  <div style={{ color: '#a855f7' }}>import &#123; WebRTC &#125; from &apos;omni-space&apos;;</div>
                  <div>const coordinates = getSharedPlane();</div>
                  <div style={{ color: '#eab308' }}>console.log(&quot;Device connected:&quot;, coordinates);</div>
                </>
              );
            }
            if (titleLower.includes('note') || titleLower.includes('todo')) {
              return (
                <>
                  <div style={{ color: '#10b981' }}># Todo List</div>
                  <div>[x] Scaffold workspaces</div>
                  <div>[x] Coordinate math logic</div>
                  <div style={{ color: '#f43f5e' }}>[/] Multi-device drag tests</div>
                </>
              );
            }
            return (
              <>
                <div style={{ color: '#64748b' }}>System diagnostics:</div>
                <div>Window: {windowState.title}</div>
                <div>DPI Scale: {localDevice.dpiScale}</div>
                <div>Position: ({Math.round(windowState.x)}, {Math.round(windowState.y)})</div>
              </>
            );
          })()}
        </div>

        {/* Resize handle (bottom-right corner) */}
        {isOwner && onResize && !windowState.isMaximized && (
          <div
            role="slider"
            aria-label="Resize window"
            tabIndex={-1}
            onPointerDown={(e) => {
              e.stopPropagation();
              const startX = e.clientX;
              const startY = e.clientY;
              const startW = windowState.width;
              const startH = windowState.height;

              const onPointerMove = (moveEvent: PointerEvent) => {
                const newW = Math.max(180, startW + (moveEvent.clientX - startX));
                const newH = Math.max(120, startH + (moveEvent.clientY - startY));
                onResize(windowState.id, newW, newH);
              };

              const onPointerUp = () => {
                window.removeEventListener('pointermove', onPointerMove);
                window.removeEventListener('pointerup', onPointerUp);
              };

              window.addEventListener('pointermove', onPointerMove);
              window.addEventListener('pointerup', onPointerUp);
            }}
            style={{
              position: 'absolute',
              right: 2,
              bottom: 2,
              width: 16,
              height: 16,
              cursor: 'nwse-resize',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 30,
              touchAction: 'none',
            }}
          >
            <div style={{ width: 6, height: 6, borderRight: '2px solid rgba(255,255,255,0.4)', borderBottom: '2px solid rgba(255,255,255,0.4)' }} />
          </div>
        )}
      </div>
    </motion.div>
  );
};
