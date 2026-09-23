import React, { useState } from 'react';
import { motion, type PanInfo } from 'framer-motion';
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
  const [announcement, setAnnouncement] = useState('');
  const [pingedDeviceId, setPingedDeviceId] = useState<string | null>(null);

  // Scale factor to map screen pixels to calibration canvas pixels (e.g. 1px on canvas = 10px on screen)
  const SCALE = 0.08;

  // Center offset to make (0,0) global plane sit nicely in the calibration board
  const OFFSET_X = 250;
  const OFFSET_Y = 150;

  const handleDeviceDragEnd = (device: Device, info: PanInfo) => {
    const deltaX = Math.round(info.offset.x / SCALE);
    const deltaY = Math.round(info.offset.y / SCALE);

    let newX = device.x + deltaX;
    let newY = device.y + deltaY;

    // 2D Magnetic Screen-to-Screen Edge Snapping (threshold = 60px global)
    const SNAP_THRESHOLD = 60;
    const otherDevices = devices.filter((d) => d.id !== device.id && d.status !== 'disconnected');

    for (const other of otherDevices) {
      if (Math.abs(newX - (other.x + other.width)) <= SNAP_THRESHOLD) {
        newX = other.x + other.width;
      } else if (Math.abs(newX + device.width - other.x) <= SNAP_THRESHOLD) {
        newX = other.x - device.width;
      }

      if (Math.abs(newY - (other.y + other.height)) <= SNAP_THRESHOLD) {
        newY = other.y + other.height;
      } else if (Math.abs(newY + device.height - other.y) <= SNAP_THRESHOLD) {
        newY = other.y - device.height;
      }

      if (Math.abs(newY - other.y) <= SNAP_THRESHOLD) {
        newY = other.y;
      }
      if (Math.abs(newX - other.x) <= SNAP_THRESHOLD) {
        newX = other.x;
      }
    }

    const existing = devicesMap.get(device.id);
    if (existing) {
      const applyUpdate = () => {
        devicesMap.set(device.id, {
          ...existing,
          x: newX,
          y: newY,
        });
      };
      if (devicesMap.doc) {
        devicesMap.doc.transact(applyUpdate);
      } else {
        applyUpdate();
      }
      setAnnouncement(`${device.name} moved to X ${newX}, Y ${newY}`);
    }
  };

  const applyPreset = (preset: 'side-by-side' | 'stacked-above' | 'reset-origin') => {
    const local = devices.find((d) => d.id === localDeviceId);
    if (!local) return;

    const apply = () => {
      if (preset === 'reset-origin') {
        devicesMap.set(local.id, { ...local, x: 0, y: 0 });
        setAnnouncement('Reset local device to origin');
        return;
      }

      const others = devices.filter((d) => d.id !== localDeviceId);
      let currentX = local.x + local.width;
      let currentY = local.y - (others[0]?.height || 800);

      others.forEach((dev) => {
        if (preset === 'side-by-side') {
          devicesMap.set(dev.id, { ...dev, x: currentX, y: local.y });
          currentX += dev.width;
        } else if (preset === 'stacked-above') {
          devicesMap.set(dev.id, { ...dev, x: local.x, y: currentY });
          currentY -= dev.height;
        }
      });
      setAnnouncement(`Applied ${preset} display arrangement`);
    };

    if (devicesMap.doc) {
      devicesMap.doc.transact(apply);
    } else {
      apply();
    }
  };

  const pingDevice = (deviceId: string) => {
    setPingedDeviceId(deviceId);
    setTimeout(() => setPingedDeviceId(null), 1200);
  };

  const getDeviceIcon = (type: 'desktop' | 'mobile', name: string) => {
    const isTablet = name.toLowerCase().includes('ipad') || name.toLowerCase().includes('tablet');

    if (type === 'desktop') {
      return name.toLowerCase().includes('mac') || name.toLowerCase().includes('laptop') ? (
        <Laptop size={16} />
      ) : (
        <Monitor size={16} />
      );
    }
    return isTablet ? <Tablet size={16} /> : <Smartphone size={16} />;
  };

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b border-slate-800 bg-slate-900/40 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-slate-200">Arrange Displays</h2>
          <p className="text-[11px] text-slate-400 mt-0.5">
            Drag screens to match your desk. Screens magnetically snap along edges.
          </p>
        </div>

        {/* Layout Preset Buttons */}
        <div className="flex items-center gap-1 bg-slate-800/80 p-0.5 rounded-lg border border-slate-700/60 text-xs">
          <button
            type="button"
            onClick={() => applyPreset('side-by-side')}
            className="px-2 py-0.5 rounded text-slate-300 hover:text-white hover:bg-slate-700/60 transition font-medium text-[11px]"
          >
            Side-by-Side
          </button>
          <button
            type="button"
            onClick={() => applyPreset('stacked-above')}
            className="px-2 py-0.5 rounded text-slate-300 hover:text-white hover:bg-slate-700/60 transition font-medium text-[11px]"
          >
            Stacked
          </button>
          <button
            type="button"
            onClick={() => applyPreset('reset-origin')}
            className="px-2 py-0.5 rounded text-slate-400 hover:text-white hover:bg-slate-700/60 transition font-medium text-[11px]"
          >
            Reset
          </button>
        </div>
      </div>

      {/* Grid Canvas */}
      <div className="flex-1 relative overflow-hidden bg-slate-950 grid-overlay flex items-center justify-center min-h-[220px]">
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
          const isPinged = pingedDeviceId === device.id;

          const left = device.x * SCALE + OFFSET_X;
          const top = device.y * SCALE + OFFSET_Y;
          const width = Math.max(40, device.width * SCALE);
          const height = Math.max(30, device.height * SCALE);

          return (
            <motion.div
              key={device.id}
              tabIndex={0}
              role="button"
              aria-label={`Display: ${isLocal ? 'This Device' : device.name}`}
              onClick={() => pingDevice(device.id)}
              drag
              dragMomentum={false}
              dragElastic={0}
              animate={{
                x: 0,
                y: 0,
                scale: isPinged ? [1, 1.08, 1] : 1,
              }}
              transition={isPinged ? { repeat: 1, duration: 0.3 } : undefined}
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
                  borderRadius: '6px',
                  backgroundColor: isDisconnected
                    ? 'rgba(15, 23, 42, 0.25)'
                    : isLocal
                    ? 'rgba(168, 85, 247, 0.15)'
                    : 'rgba(30, 41, 59, 0.45)',
                  backdropFilter: 'blur(10px)',
                  border: isPinged
                    ? '2px solid #38bdf8'
                    : isDisconnected
                    ? '1.5px dashed rgba(255, 255, 255, 0.1)'
                    : isLocal
                    ? '2px solid #a855f7'
                    : '1.5px solid rgba(255, 255, 255, 0.15)',
                  boxShadow: isPinged
                    ? '0 0 20px rgba(56, 189, 248, 0.6)'
                    : isLocal
                    ? '0 0 15px rgba(168, 85, 247, 0.2)'
                    : '0 4px 6px -1px rgba(0, 0, 0, 0.2)',
                  color: isDisconnected ? '#64748b' : '#cbd5e1',
                  overflow: 'hidden',
                  userSelect: 'none',
                }}
              >
                <div
                  style={{
                    fontSize: '8px',
                    fontWeight: 700,
                    padding: '2px 4px',
                    backgroundColor: isLocal
                      ? 'rgba(168, 85, 247, 0.25)'
                      : 'rgba(15, 23, 42, 0.5)',
                    borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {isLocal ? 'This Screen' : device.name.split(' ')[0] || 'Remote'}
                  </span>
                  <span
                    style={{
                      width: '5px',
                      height: '5px',
                      borderRadius: '50%',
                      backgroundColor: isDisconnected ? '#f43f5e' : '#10b981',
                    }}
                  />
                </div>

                <div
                  style={{
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '2px',
                    fontSize: '7px',
                  }}
                >
                  {getDeviceIcon(device.type, device.name)}
                  <span>
                    {device.width}×{device.height}
                  </span>
                </div>
              </div>
            </motion.div>
          );
        })}
      </div>
      <div className="sr-only" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
};
