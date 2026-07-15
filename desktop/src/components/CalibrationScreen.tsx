import React from 'react';
import { motion } from 'framer-motion';
import * as Y from 'yjs';
import { Monitor, Laptop, Tablet, Smartphone } from 'lucide-react';
import { Device } from 'core';

interface CalibrationScreenProps {
  localDeviceId: string;
  devices: Device[];
  devicesMap: Y.Map<Device>;
}

export const CalibrationScreen: React.FC<CalibrationScreenProps> = ({
  localDeviceId,
  devices,
  devicesMap,
}) => {
  // Scale factor to map screen pixels to calibration canvas pixels (e.g. 1px on canvas = 10px on screen)
  const SCALE = 0.08;

  // Center offset to make (0,0) global plane sit nicely in the calibration board
  const OFFSET_X = 250;
  const OFFSET_Y = 150;

  const handleDeviceDragEnd = (device: Device, info: any) => {
    // Calculate new global position based on drag offset delta
    const deltaX = Math.round(info.offset.x / SCALE);
    const deltaY = Math.round(info.offset.y / SCALE);

    const newX = device.x + deltaX;
    const newY = device.y + deltaY;

    // Update in Yjs map
    const existing = devicesMap.get(device.id);
    if (existing) {
      devicesMap.set(device.id, {
        ...existing,
        x: newX,
        y: newY,
      });
    }
  };

  const getDeviceIcon = (type: 'desktop' | 'mobile', name: string) => {
    const isTablet = name.toLowerCase().includes('ipad') || name.toLowerCase().includes('tablet');

    if (type === 'desktop') {
      return name.toLowerCase().includes('mac') || name.toLowerCase().includes('laptop') ? (
        <Laptop size={18} />
      ) : (
        <Monitor size={18} />
      );
    }
    return isTablet ? <Tablet size={18} /> : <Smartphone size={18} />;
  };

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b border-slate-800 bg-slate-900/40">
        <h2 className="text-lg font-semibold text-slate-200">Arrange Displays</h2>
        <p className="text-xs text-slate-400 mt-1">
          Drag and arrange screens to match the physical layout of your desk. Windows and cursors will transition across adjacent borders.
        </p>
      </div>

      {/* Grid Canvas */}
      <div className="flex-1 relative overflow-hidden bg-slate-950 grid-overlay flex items-center justify-center min-h-[350px]">
        {/* Origin marker */}
        <div
          style={{
            position: 'absolute',
            left: OFFSET_X,
            top: OFFSET_Y,
            width: '6px',
            height: '6px',
            backgroundColor: '#a855f7',
            borderRadius: '50%',
            filter: 'drop-shadow(0 0 4px #a855f7)',
          }}
        />

        {devices.map((device) => {
          const isLocal = device.id === localDeviceId;
          const isDisconnected = device.status === 'disconnected';

          // Convert global coordinates to visual canvas coordinates
          const left = device.x * SCALE + OFFSET_X;
          const top = device.y * SCALE + OFFSET_Y;
          const width = device.width * SCALE;
          const height = device.height * SCALE;

          return (
            <motion.div
              key={device.id}
              drag
              dragMomentum={false}
              dragElastic={0}
              onDragEnd={(_, info) => handleDeviceDragEnd(device, info)}
              style={{
                position: 'absolute',
                left,
                top,
                width,
                height,
                cursor: 'move',
              }}
              whileDrag={{ scale: 1.02, zIndex: 100 }}
            >
              <div
                style={{
                  width: '100%',
                  height: '100%',
                  display: 'flex',
                  flexDirection: 'column',
                  borderRadius: '8px',
                  backgroundColor: isDisconnected
                    ? 'rgba(15, 23, 42, 0.25)'
                    : isLocal
                    ? 'rgba(168, 85, 247, 0.15)'
                    : 'rgba(30, 41, 59, 0.45)',
                  backdropFilter: 'blur(10px)',
                  border: isDisconnected
                    ? '1.5px dashed rgba(255, 255, 255, 0.1)'
                    : isLocal
                    ? '2px solid #a855f7'
                    : '1.5px solid rgba(255, 255, 255, 0.15)',
                  boxShadow: isDisconnected
                    ? 'none'
                    : isLocal
                    ? '0 0 15px rgba(168, 85, 247, 0.2)'
                    : '0 4px 6px -1px rgba(0, 0, 0, 0.2)',
                  color: isDisconnected ? '#64748b' : '#cbd5e1',
                  overflow: 'hidden',
                  userSelect: 'none',
                }}
              >
                {/* Visual screen titlebar */}
                <div
                  style={{
                    fontSize: '9px',
                    fontWeight: 700,
                    padding: '4px 8px',
                    backgroundColor: isDisconnected
                      ? 'rgba(15, 23, 42, 0.4)'
                      : isLocal
                      ? 'rgba(168, 85, 247, 0.25)'
                      : 'rgba(15, 23, 42, 0.5)',
                    borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {isLocal ? 'This Device' : device.name.split(' ')[0] || 'Remote'}
                  </span>
                  {isDisconnected ? (
                    <span style={{ color: '#f43f5e', fontSize: '8px' }}>Disconnected</span>
                  ) : (
                    <span
                      style={{
                        width: '6px',
                        height: '6px',
                        borderRadius: '50%',
                        backgroundColor: '#10b981',
                      }}
                    />
                  )}
                </div>

                {/* Display icon and dimensions */}
                <div
                  style={{
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '4px',
                    fontSize: '8px',
                  }}
                >
                  {getDeviceIcon(device.type, device.name)}
                  <span>
                    {device.width} × {device.height}
                  </span>
                </div>
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
};
