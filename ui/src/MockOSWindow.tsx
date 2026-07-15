import React, { useRef } from 'react';
import { motion } from 'framer-motion';
import { Device, WindowInstance } from 'core';

interface MockOSWindowProps {
  localDeviceId: string;
  localDevice: Device;
  windowState: WindowInstance;
  onDragStart: (windowId: string, event: any) => void;
  onDrag: (windowId: string, event: any, info: any) => void;
  onDragEnd: (windowId: string, event: any, info: any) => void;
}

export const MockOSWindow: React.FC<MockOSWindowProps> = ({
  localDeviceId,
  localDevice,
  windowState,
  onDragStart,
  onDrag,
  onDragEnd,
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
      transition={{ type: 'spring', stiffness: 300, damping: 25 }}
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
          <div style={{ display: 'flex', gap: '6px', marginRight: '16px' }}>
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

          {/* Owner badge */}
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
          {windowState.title.includes('Editor') ? (
            <>
              <div style={{ color: '#6366f1' }}>// Omni-Space Code Editor</div>
              <div style={{ color: '#a855f7' }}>import &#123; WebRTC &#125; from 'omni-space';</div>
              <div>const coordinates = getSharedPlane();</div>
              <div style={{ color: '#eab308' }}>console.log("Device connected:", coordinates);</div>
            </>
          ) : windowState.title.includes('Notes') ? (
            <>
              <div style={{ color: '#10b981' }}># Todo List</div>
              <div>[x] Scaffold workspaces</div>
              <div>[x] Coordinate math logic</div>
              <div style={{ color: '#f43f5e' }}>[/] Multi-device drag tests</div>
            </>
          ) : (
            <>
              <div style={{ color: '#64748b' }}>System diagnostics:</div>
              <div>Coordinate space synchronized</div>
              <div>DPI Scale: {localDevice.dpiScale}</div>
              <div>Position: ({windowState.x}, {windowState.y})</div>
            </>
          )}
        </div>
      </div>
    </motion.div>
  );
};
