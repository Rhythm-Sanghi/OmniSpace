import React from 'react';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import { Monitor } from 'lucide-react';
import { Device, WindowInstance, OmniRTCManager } from 'core';
import { CursorOverlay } from 'ui';
import { DesktopWindowRenderer } from './DesktopWindowRenderer.js';

interface WorkspaceViewportProps {
  localDeviceId: string;
  localDevice: Device | null;
  localDeviceWidth: number;
  localDeviceHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  workspaceRef: React.RefObject<HTMLDivElement | null>;
  awareness: awarenessProtocol.Awareness | null;
  windows: WindowInstance[];
  remoteStreams: { [streamId: string]: MediaStream };
  focusedWindowId: string | null;
  handleDragStart: (windowId: string, event: any) => void;
  handleDrag: (windowId: string, event: any, info: any) => void;
  handleDragEnd: (windowId: string, event: any, info: any) => void;
  rtcManager: OmniRTCManager | null;
  devicesMap: Y.Map<Device>;
  handleFocusClick: (windowId: string) => void;
  handleMouseMove: (e: React.MouseEvent<HTMLDivElement>) => void;
  handleMouseLeave: () => void;
  onResize?: (windowId: string, width: number, height: number) => void;
  onToggleMaximize?: (windowId: string) => void;
  onFileDrop?: (targetPeerId: string, file: File) => void;
}

export const WorkspaceViewport: React.FC<WorkspaceViewportProps> = React.memo(({
  localDeviceId,
  localDevice,
  localDeviceWidth,
  localDeviceHeight,
  viewportWidth,
  viewportHeight,
  workspaceRef,
  awareness,
  windows,
  remoteStreams,
  focusedWindowId,
  handleDragStart,
  handleDrag,
  handleDragEnd,
  rtcManager,
  devicesMap,
  handleFocusClick,
  handleMouseMove,
  handleMouseLeave,
  onResize,
  onToggleMaximize,
  onFileDrop,
}) => {
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="text-xs font-medium text-slate-400 flex items-center gap-1.5">
        <Monitor size={13} /> Simulated Device Display Viewport ({localDeviceWidth}×{localDeviceHeight})
      </div>

      {/* Monitor Screen Frame */}
      <div
        ref={workspaceRef}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        style={{
          width: viewportWidth,
          height: viewportHeight,
          position: 'relative',
          backgroundColor: '#0f172a',
          border: '4px solid #1e293b',
          borderRadius: '12px',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
          overflow: 'hidden',
        }}
        className="grid-overlay select-none"
      >
        {/* Render remote cursor overlay */}
        <CursorOverlay
          localDeviceId={localDeviceId}
          localDevice={localDevice}
          awareness={awareness}
        />

        {/* Render mock/real application windows */}
        {windows.map((win) => (
          <DesktopWindowRenderer
            key={win.id}
            localDeviceId={localDeviceId}
            localDevice={localDevice!}
            windowState={win}
            stream={win.streamId ? remoteStreams[win.streamId] || null : null}
            focusedWindowId={focusedWindowId}
            onDragStart={handleDragStart}
            onDrag={handleDrag}
            onDragEnd={handleDragEnd}
            rtcManager={rtcManager}
            devicesMap={devicesMap}
            onFocusClick={handleFocusClick}
            onResize={onResize}
            onToggleMaximize={onToggleMaximize}
            peerConnection={win.capturingDeviceId ? rtcManager?.getPeerConnection(win.capturingDeviceId) : null}
            onFileDrop={onFileDrop}
          />
        ))}

        {/* Visual warning seam if no neighbor device aligns */}
        <div className="absolute inset-y-0 right-0 w-[3px] bg-purple-500/20 pointer-events-none" />
        <div className="absolute inset-y-0 left-0 w-[3px] bg-purple-500/20 pointer-events-none" />
      </div>
    </div>
  );
});
