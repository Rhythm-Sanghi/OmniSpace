import React, { useState, useRef, useEffect, useCallback } from 'react';
import { motion, PanInfo } from 'framer-motion';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import { Monitor, Smartphone, Laptop, Tablet, Plus, Tv, QrCode, Sliders, Check, Copy } from 'lucide-react';
import { Device, WindowInstance, OmniRTCManager, updateWindowPosition, handleWindowDrag, claimWindowOwnership } from 'core';
import { CursorOverlay } from 'ui';

interface WorkspaceViewportProps {
  localDeviceId: string;
  localDevice: Device | null;
  devices: Device[];
  awareness: awarenessProtocol.Awareness | null;
  windows: WindowInstance[];
  remoteStreams: { [streamId: string]: MediaStream };
  focusedWindowId: string | null;
  rtcManager?: OmniRTCManager | null;
  devicesMap?: Y.Map<Device>;
  windowsMap: Y.Map<WindowInstance> | null;
  handleFocusClick: (windowId: string) => void;
  onCreateWindow: () => void;
  onShareScreen: () => void;
  onOpenQR: () => void;
  onOpenCalibration: () => void;
  roomPin: string | null;
  onResize?: (windowId: string, width: number, height: number) => void;
  onToggleMaximize?: (windowId: string) => void;
  onFileDrop?: (targetPeerId: string, file: File) => void;
}

export const WorkspaceViewport: React.FC<WorkspaceViewportProps> = ({
  localDeviceId,
  localDevice,
  devices,
  awareness,
  windows,
  remoteStreams,
  focusedWindowId,
  windowsMap,
  handleFocusClick,
  onCreateWindow,
  onShareScreen,
  onOpenQR,
  onOpenCalibration,
  roomPin,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState<{ width: number; height: number }>({
    width: 900,
    height: 550,
  });
  const [copiedPin, setCopiedPin] = useState(false);

  // ResizeObserver to dynamically adapt scale to container
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setContainerSize({
          width: Math.max(400, entry.contentRect.width),
          height: Math.max(300, entry.contentRect.height),
        });
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // Compute spatial bounds of all connected devices
  const activeDevices = devices.filter((d) => d.status === 'connected');
  const displayDevices = activeDevices.length > 0 ? activeDevices : (localDevice ? [localDevice] : []);

  const minX = displayDevices.reduce((min, d) => Math.min(min, d.x), 0);
  const maxX = displayDevices.reduce((max, d) => Math.max(max, d.x + d.width), 1920);
  const minY = displayDevices.reduce((min, d) => Math.min(min, d.y), 0);
  const maxY = displayDevices.reduce((max, d) => Math.max(max, d.y + d.height), 1080);

  const totalWorldWidth = Math.max(1200, maxX - minX);
  const totalWorldHeight = Math.max(800, maxY - minY);

  // Auto-fit scale factor with padding
  const padding = 40;
  const availW = containerSize.width - padding * 2;
  const availH = containerSize.height - padding * 2;
  const scale = Math.min(0.7, Math.max(0.25, Math.min(availW / totalWorldWidth, availH / totalWorldHeight)));

  const deskWidth = totalWorldWidth * scale;
  const deskHeight = totalWorldHeight * scale;

  // Window drag handlers on spatial canvas
  const handleWindowDragStart = useCallback((windowId: string) => {
    if (!windowsMap) return;
    claimWindowOwnership(windowId, localDeviceId, windowsMap);
    handleFocusClick(windowId);
  }, [windowsMap, localDeviceId, handleFocusClick]);

  const handleSpatialWindowDrag = useCallback((windowId: string, _event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    if (!windowsMap || !localDevice) return;
    const win = windowsMap.get(windowId);
    if (!win || win.owningDeviceId !== localDeviceId) return;

    // Convert pixel delta on scaled canvas to global coordinates
    const deltaGx = info.delta.x / scale;
    const deltaGy = info.delta.y / scale;

    const newGx = Math.round(win.x + deltaGx);
    const newGy = Math.round(win.y + deltaGy);

    updateWindowPosition(windowId, newGx, newGy, localDeviceId, windowsMap);

    // Compute pointer global position
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const deskLeft = (containerSize.width - deskWidth) / 2;
      const deskTop = (containerSize.height - deskHeight) / 2;
      const canvasPointerX = info.point.x - rect.left - deskLeft;
      const canvasPointerY = info.point.y - rect.top - deskTop;

      const cursorGx = minX + canvasPointerX / scale;
      const cursorGy = minY + canvasPointerY / scale;

      handleWindowDrag(windowId, cursorGx, cursorGy, localDeviceId, devices, windowsMap);
    }
  }, [windowsMap, localDevice, localDeviceId, scale, containerSize, deskWidth, deskHeight, minX, minY, devices]);

  const copyRoomPin = () => {
    if (!roomPin) return;
    navigator.clipboard?.writeText(roomPin).then(() => {
      setCopiedPin(true);
      setTimeout(() => setCopiedPin(false), 2000);
    }).catch(() => {});
  };

  const getDeviceIcon = (type: 'desktop' | 'mobile', name: string) => {
    const isTablet = name.toLowerCase().includes('ipad') || name.toLowerCase().includes('tablet');
    if (type === 'desktop') {
      return name.toLowerCase().includes('mac') || name.toLowerCase().includes('laptop') ? (
        <Laptop size={14} className="text-purple-400" />
      ) : (
        <Monitor size={14} className="text-purple-400" />
      );
    }
    return isTablet ? <Tablet size={14} className="text-emerald-400" /> : <Smartphone size={14} className="text-emerald-400" />;
  };

  const otherConnectedDevices = displayDevices.filter((d) => d.id !== localDeviceId);

  return (
    <div
      ref={containerRef}
      className="w-full h-full flex flex-col items-center justify-center relative overflow-hidden bg-slate-950 select-none p-4"
    >
      {/* Top Workspace Toolbar */}
      <div className="absolute top-4 inset-x-6 z-30 flex items-center justify-between pointer-events-auto">
        <div className="flex items-center gap-2 bg-slate-900/90 backdrop-blur border border-slate-800 p-1.5 rounded-xl shadow-xl">
          <button
            type="button"
            onClick={onCreateWindow}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold shadow-md shadow-purple-600/30 transition"
          >
            <Plus size={14} />
            <span>New Window</span>
          </button>

          <button
            type="button"
            onClick={onShareScreen}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium border border-slate-700 transition"
          >
            <Tv size={14} className="text-indigo-400" />
            <span>Share Screen</span>
          </button>

          <button
            type="button"
            onClick={onOpenCalibration}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium border border-slate-700 transition"
          >
            <Sliders size={14} className="text-amber-400" />
            <span>Arrange Screens</span>
          </button>

          <button
            type="button"
            onClick={onOpenQR}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium border border-slate-700 transition"
          >
            <QrCode size={14} className="text-purple-400" />
            <span>Pair Mobile</span>
          </button>
        </div>

        {/* Connected Roster Pill */}
        <div className="flex items-center gap-2 bg-slate-900/90 backdrop-blur border border-slate-800 px-3 py-1.5 rounded-xl text-xs shadow-xl">
          <div className="flex items-center gap-1.5 text-slate-300">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="font-semibold text-slate-200">
              {displayDevices.length} {displayDevices.length === 1 ? 'Screen' : 'Screens'} Active
            </span>
          </div>

          <div className="h-3 w-[1px] bg-slate-800 mx-1" />

          <button
            onClick={copyRoomPin}
            className="flex items-center gap-1 text-slate-400 hover:text-purple-300 font-mono text-[11px] transition"
            title="Click to copy room code"
          >
            <span>PIN: {roomPin}</span>
            {copiedPin ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
          </button>
        </div>
      </div>

      {/* Spatial Desk Coordinate Board */}
      <div
        style={{
          width: `${deskWidth}px`,
          height: `${deskHeight}px`,
          position: 'relative',
        }}
        className="rounded-3xl border border-slate-800/80 bg-slate-900/30 shadow-2xl backdrop-blur-sm transition-all duration-300"
      >
        {/* Render Each Screen Frame */}
        {displayDevices.map((device) => {
          const isLocal = device.id === localDeviceId;
          const left = (device.x - minX) * scale;
          const top = (device.y - minY) * scale;
          const width = device.width * scale;
          const height = device.height * scale;

          return (
            <div
              key={device.id}
              style={{
                position: 'absolute',
                left: `${left}px`,
                top: `${top}px`,
                width: `${width}px`,
                height: `${height}px`,
              }}
              className={`rounded-2xl border-2 transition-all duration-200 overflow-hidden ${
                isLocal
                  ? 'border-purple-500/50 bg-slate-950/90 shadow-2xl shadow-purple-950/30'
                  : 'border-emerald-500/50 bg-slate-950/80 shadow-2xl shadow-emerald-950/20'
              }`}
            >
              {/* Screen Bezel Header */}
              <div
                className={`px-3 py-1.5 flex items-center justify-between border-b text-[10px] font-semibold tracking-wide ${
                  isLocal
                    ? 'bg-purple-950/40 border-purple-500/30 text-purple-200'
                    : 'bg-emerald-950/40 border-emerald-500/30 text-emerald-200'
                }`}
              >
                <div className="flex items-center gap-1.5">
                  {getDeviceIcon(device.type, device.name)}
                  <span>{isLocal ? '💻 This Laptop (Host)' : `📱 ${device.name || 'Companion'}`}</span>
                </div>
                <span className="font-mono opacity-70 text-[9px]">
                  {device.width} × {device.height}
                </span>
              </div>

              {/* Screen Interior Background */}
              <div className="w-full h-full relative grid-overlay opacity-30 pointer-events-none" />

              {/* Seam Indicator when neighboring screen aligns */}
              <div
                className={`absolute inset-y-0 right-0 w-[3px] pointer-events-none ${
                  isLocal ? 'bg-purple-500/40' : 'bg-emerald-500/40'
                }`}
              />
            </div>
          );
        })}

        {/* Prompt Card if Only Host Screen is Active */}
        {otherConnectedDevices.length === 0 && (
          <div
            style={{
              position: 'absolute',
              right: '24px',
              top: '50%',
              transform: 'translateY(-50%)',
              maxWidth: '260px',
            }}
            className="p-4 rounded-2xl bg-slate-900/90 border border-purple-500/30 shadow-2xl text-center flex flex-col items-center gap-3 backdrop-blur z-10"
          >
            <div className="w-10 h-10 rounded-xl bg-purple-600/20 border border-purple-500/40 flex items-center justify-center text-purple-300">
              <Smartphone size={20} />
            </div>
            <div>
              <h4 className="text-xs font-bold text-slate-200">Connect Companion Phone</h4>
              <p className="text-[11px] text-slate-400 mt-1 leading-snug">
                Scan the QR code to connect your phone. Its screen will appear right here beside this laptop!
              </p>
            </div>
            <button
              onClick={onOpenQR}
              className="w-full py-2 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold shadow-md shadow-purple-600/30 transition flex items-center justify-center gap-1.5"
            >
              <QrCode size={13} />
              <span>Show Pairing QR Code</span>
            </button>
          </div>
        )}

        {/* Remote Cursors Overlay */}
        <CursorOverlay
          localDeviceId={localDeviceId}
          localDevice={localDevice}
          awareness={awareness}
        />

        {/* Render Draggable Windows on the Spatial Canvas */}
        {windows.map((win) => {
          const isOwner = win.owningDeviceId === localDeviceId;
          const left = (win.x - minX) * scale;
          const top = (win.y - minY) * scale;
          const width = win.width * scale;
          const height = win.height * scale;

          return (
            <motion.div
              key={win.id}
              drag={isOwner}
              dragMomentum={false}
              dragElastic={0}
              onDragStart={() => handleWindowDragStart(win.id)}
              onDrag={(e, info) => handleSpatialWindowDrag(win.id, e, info)}
              style={{
                position: 'absolute',
                left: `${left}px`,
                top: `${top}px`,
                width: `${width}px`,
                height: `${height}px`,
                zIndex: isOwner ? 100 : 50,
                cursor: isOwner ? 'grab' : 'default',
              }}
              whileDrag={{ scale: 1.02, zIndex: 200, cursor: 'grabbing' }}
              className="select-none"
            >
              <div
                onClick={() => handleFocusClick(win.id)}
                className={`w-full h-full flex flex-col rounded-xl overflow-hidden border shadow-2xl backdrop-blur-md transition-shadow ${
                  focusedWindowId === win.id
                    ? 'border-purple-400 ring-2 ring-purple-500/30 shadow-purple-900/40'
                    : isOwner
                    ? 'border-purple-500/40 shadow-slate-950/60'
                    : 'border-slate-700/60 opacity-90'
                } bg-slate-900/90`}
              >
                {/* Window Title Bar */}
                <div className="h-7 bg-slate-950/70 border-b border-slate-800 px-2.5 flex items-center justify-between text-[10px]">
                  <div className="flex items-center gap-1.5">
                    <div className="w-2.5 h-2.5 rounded-full bg-rose-500/80" />
                    <div className="w-2.5 h-2.5 rounded-full bg-amber-500/80" />
                    <div className="w-2.5 h-2.5 rounded-full bg-emerald-500/80" />
                  </div>

                  <span className="font-semibold text-slate-200 truncate max-w-[140px] text-[10px]">
                    {win.title}
                  </span>

                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300 font-mono">
                    {win.owningDeviceId === localDeviceId ? 'Local' : 'Companion'}
                  </span>
                </div>

                {/* Window Content */}
                <div className="flex-1 p-3 text-[11px] font-mono text-slate-300 flex flex-col gap-1.5 overflow-hidden bg-slate-950/50">
                  {win.hasActiveCapture && win.streamId && remoteStreams[win.streamId] ? (
                    <video
                      autoPlay
                      playsInline
                      muted
                      ref={(el) => {
                        if (el && win.streamId && remoteStreams[win.streamId]) {
                          el.srcObject = remoteStreams[win.streamId];
                        }
                      }}
                      className="w-full h-full object-cover rounded"
                    />
                  ) : (
                    <>
                      <div className="text-purple-400 font-bold">✨ Interactive Window</div>
                      <div className="text-slate-400 text-[10px] leading-tight">
                        Drag this window across the screen border to hand it over to your phone!
                      </div>
                      <div className="mt-auto pt-2 border-t border-slate-800/80 flex items-center justify-between text-[9px] text-slate-500">
                        <span>Pos: ({Math.round(win.x)}, {Math.round(win.y)})</span>
                        <span>Size: {win.width}×{win.height}</span>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </motion.div>
          );
        })}
      </div>

      {/* Floating Bottom Helper Hint */}
      <div className="absolute bottom-3 inset-x-0 flex justify-center pointer-events-none">
        <div className="px-4 py-1.5 rounded-full bg-slate-900/80 border border-slate-800 text-[11px] text-slate-400 backdrop-blur shadow-lg flex items-center gap-2">
          <span className="text-purple-400">💡 Tip:</span>
          <span>Click and drag any window across the border between screens to transfer it to your other device</span>
        </div>
      </div>
    </div>
  );
};
