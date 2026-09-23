import React from 'react';
import { useInputCapture } from '../hooks/useInputCapture.js';
import { RemoteWindowRenderer, MockOSWindow } from 'ui';
import { WindowInstance, Device, OmniRTCManager } from 'core';
import * as Y from 'yjs';

interface DesktopWindowRendererProps {
  localDeviceId: string;
  localDevice: Device;
  windowState: WindowInstance;
  stream: MediaStream | null;
  focusedWindowId: string | null;
  onDragStart?: (windowId: string, event: any) => void;
  onDrag?: (windowId: string, event: any, info: any) => void;
  onDragEnd?: (windowId: string, event: any, info: any) => void;
  rtcManager: OmniRTCManager | null;
  devicesMap: Y.Map<Device>;
  onFocusClick: (windowId: string) => void;
  onResize?: (windowId: string, width: number, height: number) => void;
  onToggleMaximize?: (windowId: string) => void;
  peerConnection?: RTCPeerConnection | null;
  onFileDrop?: (targetPeerId: string, file: File) => void;
}

export const DesktopWindowRenderer: React.FC<DesktopWindowRendererProps> = React.memo((props) => {
  const inputCaptureListeners = useInputCapture(
    props.localDeviceId,
    props.rtcManager,
    props.windowState,
    props.devicesMap
  );

  if (!props.windowState.hasActiveCapture) {
    return (
      <MockOSWindow
        localDeviceId={props.localDeviceId}
        localDevice={props.localDevice}
        windowState={props.windowState}
        onDragStart={props.onDragStart || (() => {})}
        onDrag={props.onDrag || (() => {})}
        onDragEnd={props.onDragEnd || (() => {})}
        onResize={props.onResize}
        onToggleMaximize={props.onToggleMaximize}
      />
    );
  }

  return (
    <RemoteWindowRenderer
      localDeviceId={props.localDeviceId}
      localDevice={props.localDevice}
      windowState={props.windowState}
      stream={props.stream}
      focusedWindowId={props.focusedWindowId}
      onDragStart={props.onDragStart}
      onDrag={props.onDrag}
      onDragEnd={props.onDragEnd}
      inputCaptureListeners={inputCaptureListeners}
      onFocusClick={props.onFocusClick}
      onResize={props.onResize}
      onToggleMaximize={props.onToggleMaximize}
      peerConnection={props.peerConnection}
      onFileDrop={props.onFileDrop}
    />
  );
});
