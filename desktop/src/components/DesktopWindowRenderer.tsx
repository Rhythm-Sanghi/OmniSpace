import React, { useRef } from 'react';
import { useInputCapture } from '../hooks/useInputCapture.js';
import { RemoteWindowRenderer } from 'ui';
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
}

export const DesktopWindowRenderer: React.FC<DesktopWindowRendererProps> = (props) => {
  const containerRef = useRef<HTMLDivElement>(null);
  
  const inputCaptureListeners = useInputCapture(
    props.localDeviceId,
    props.rtcManager,
    props.windowState,
    props.devicesMap,
    containerRef as any
  );

  return (
    <div ref={containerRef} style={{ display: 'contents' }}>
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
      />
    </div>
  );
};
