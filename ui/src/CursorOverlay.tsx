import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Device } from 'core';

interface CursorInfo {
  id: string;
  name: string;
  color: string;
  lx: number;
  ly: number;
  active: boolean;
}

interface CursorOverlayProps {
  localDeviceId: string;
  localDevice: Device | null;
  awareness: any;
}

export const CursorOverlay: React.FC<CursorOverlayProps> = ({
  localDeviceId,
  localDevice,
  awareness,
}) => {
  const [remoteCursors, setRemoteCursors] = useState<CursorInfo[]>([]);

  useEffect(() => {
    if (!localDevice) return;

    const updateCursors = () => {
      const states = awareness.getStates();
      const cursors: CursorInfo[] = [];

      states.forEach((state: any, clientID: number) => {
        // Skip ourselves
        if (state.deviceId === localDeviceId) return;

        const cursor = state.cursor;
        if (!cursor || !cursor.active) return;

        const { x: gx, y: gy } = cursor;

        // Check if cursor overlaps our local device screen bounds
        if (
          gx >= localDevice.x &&
          gx < localDevice.x + localDevice.width &&
          gy >= localDevice.y &&
          gy < localDevice.y + localDevice.height
        ) {
          // Convert global coordinates to our local coordinates
          const lx = gx - localDevice.x;
          const ly = gy - localDevice.y;

          cursors.push({
            id: String(clientID),
            name: state.name || `Device-${clientID}`,
            color: state.color || '#a855f7', // Default purple glow
            lx,
            ly,
            active: true,
          });
        }
      });

      setRemoteCursors(cursors);
    };

    // Listen to changes in awareness
    awareness.on('change', updateCursors);
    updateCursors();

    return () => {
      awareness.off('change', updateCursors);
    };
  }, [localDeviceId, localDevice, awareness]);

  if (!localDevice) return null;

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 99999,
        overflow: 'hidden',
      }}
    >
      <AnimatePresence>
        {remoteCursors.map((cursor) => (
          <motion.div
            key={cursor.id}
            style={{
              position: 'absolute',
              x: cursor.lx,
              y: cursor.ly,
              left: 0,
              top: 0,
            }}
            transition={{
              type: 'spring',
              stiffness: 350,
              damping: 28,
              mass: 0.6,
            }}
          >
            {/* The cursor arrow/dot element */}
            <div style={{ position: 'relative' }}>
              {/* Soft radial glow */}
              <div
                style={{
                  position: 'absolute',
                  top: -12,
                  left: -12,
                  width: 24,
                  height: 24,
                  borderRadius: '50%',
                  backgroundColor: cursor.color,
                  filter: 'blur(8px)',
                  opacity: 0.6,
                }}
              />

              {/* Cursor shape: custom neon ring and pointer */}
              <svg
                width="18"
                height="18"
                viewBox="0 0 18 18"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                style={{
                  filter: `drop-shadow(0px 2px 4px rgba(0, 0, 0, 0.4))`,
                }}
              >
                <path
                  d="M0 0V15.5L4.5 11L8.5 18L11.5 16.5L7.5 9.5L13.5 9.5L0 0Z"
                  fill={cursor.color}
                  stroke="white"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
              </svg>

              {/* Cursor Label Badge */}
              <motion.div
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0 }}
                style={{
                  position: 'absolute',
                  left: 14,
                  top: 14,
                  backgroundColor: 'rgba(15, 23, 42, 0.85)',
                  border: `1px solid ${cursor.color}`,
                  color: '#f8fafc',
                  padding: '2px 8px',
                  borderRadius: '6px',
                  fontSize: '10px',
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                  backdropFilter: 'blur(4px)',
                  boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)',
                }}
              >
                {cursor.name}
              </motion.div>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
};
