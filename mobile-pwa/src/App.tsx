import React, { useState, useEffect, useRef } from 'react';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import { LogOut, Smartphone, Activity } from 'lucide-react';
import {
  getDeviceId,
  initOmniDoc,
  Device,
  WindowInstance,
  OmniRTCManager,
  OmniQualityController,
  focusWindow,
} from 'core';
import { CursorOverlay } from 'ui';
import { PairingScreen } from './components/PairingScreen.js';
import { useWindowHandoff } from './hooks/useWindowHandoff.js';
import { MobileWindowRenderer } from './components/MobileWindowRenderer.js';

export default function App() {
  const [localDeviceId] = useState(() => getDeviceId());
  const [roomPin, setRoomPin] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [focusedWindowId, setFocusedWindowId] = useState<string | null>(null);

  // Doc, Awareness, RTC Manager refs
  const docRef = useRef<Y.Doc | null>(null);
  const awarenessRef = useRef<awarenessProtocol.Awareness | null>(null);
  const rtcManagerRef = useRef<OmniRTCManager | null>(null);

  // CRDT list states
  const [devices, setDevices] = useState<Device[]>([]);
  const [windows, setWindows] = useState<WindowInstance[]>([]);
  const [remoteStreams, setRemoteStreams] = useState<{ [streamId: string]: MediaStream }>({});

  const qualityControllerRef = useRef<OmniQualityController | null>(null);

  const viewportRef = useRef<HTMLDivElement>(null);

  const signalingUrl = ((import.meta as any).env.VITE_SIGNALING_URL as string) || 'ws://localhost:3000';

  useEffect(() => {
    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);

    // Initial mobile awareness state
    const color = `#${Math.floor(Math.random() * 16777215).toString(16)}`;
    awareness.setLocalState({
      deviceId: localDeviceId,
      name: `Mobile-${localDeviceId.substring(0, 4)}`,
      color,
      cursor: { x: 0, y: 0, active: false },
    });

    docRef.current = doc;
    awarenessRef.current = awareness;

    const { devices: devicesMap, windows: windowsMap } = initOmniDoc(doc);

    const syncState = () => {
      setDevices(Array.from(devicesMap.values()));
      setWindows(Array.from(windowsMap.values()));
    };

    devicesMap.observe(syncState);
    windowsMap.observe(syncState);

    return () => {
      doc.destroy();
    };
  }, [localDeviceId]);

  // Synchronize incoming remote track stats polling declaratively
  useEffect(() => {
    if (!connected || !qualityControllerRef.current || !rtcManagerRef.current) return;
    const rtc = rtcManagerRef.current;
    const qc = qualityControllerRef.current;

    windows.forEach((win) => {
      if (
        win.owningDeviceId === localDeviceId &&
        win.capturingDeviceId !== localDeviceId &&
        win.hasActiveCapture &&
        win.streamId
      ) {
        const stream = remoteStreams[win.streamId];
        if (stream) {
          const pc = rtc.getPeerConnection(win.capturingDeviceId);
          if (pc) {
            qc.startStatsPolling(win.id, win.capturingDeviceId, pc);
          }
        }
      } else {
        // Stop stats polling if the window is no longer active on our viewport
        qc.stopStatsPolling(win.id);
      }
    });
  }, [windows, remoteStreams, connected, localDeviceId]);

  const handlePair = (pin: string) => {
    setErrorMessage(null);

    const doc = docRef.current!;
    const awareness = awarenessRef.current!;

    // Initialize WebRTC connection broker manager
    const rtcManager = new OmniRTCManager(
      localDeviceId,
      'mobile',
      pin,
      signalingUrl,
      doc,
      awareness
    );

    // Mobile is destination-only, so getSender returns undefined
    const qualityController = new OmniQualityController(
      rtcManager,
      () => undefined
    );
    qualityControllerRef.current = qualityController;

    // Handle remote video stream received
    rtcManager.onRemoteTrackReceived = (_peerId: string, stream: MediaStream) => {
      setRemoteStreams((prev) => ({
        ...prev,
        [stream.id]: stream,
      }));
    };

    rtcManagerRef.current = rtcManager;

    const devicesMap = doc.getMap<Device>('devices');
    const checkConnection = () => {
      const self = devicesMap.get(localDeviceId);
      if (self && self.status === 'connected') {
        setConnected(true);
        setRoomPin(pin);
        devicesMap.unobserve(checkConnection);
      }
    };
    devicesMap.observe(checkConnection);

    rtcManager.connect();
  };

  const handleDisconnect = () => {
    qualityControllerRef.current?.destroy();
    qualityControllerRef.current = null;

    rtcManagerRef.current?.destroy();
    rtcManagerRef.current = null;

    setRemoteStreams({});
    setConnected(false);
    setRoomPin(null);
  };

  const localDevice = devices.find((d) => d.id === localDeviceId) || null;

  // Handoff hook configuration
  const { handleDragStart, handleDrag, handleDragEnd } = useWindowHandoff(
    localDeviceId,
    localDevice,
    devices,
    docRef.current?.getMap<WindowInstance>('windows') || new Y.Map()
  );

  // Synchronize Yjs focus state to PWA React
  useEffect(() => {
    if (!docRef.current || !connected) return;
    const stateMap = docRef.current.getMap<any>('state');

    const updateFocus = () => {
      setFocusedWindowId(stateMap.get('focusedWindowId') || null);
    };

    stateMap.observe(updateFocus);
    updateFocus();

    return () => {
      stateMap.unobserve(updateFocus);
    };
  }, [connected]);

  const handleFocusClick = (windowId: string) => {
    if (docRef.current) {
      focusWindow(docRef.current, windowId);
    }
  };

  // Visual scaling to fit phone viewport (e.g. scale 1080px screen down to 350px container)
  const VIEWPORT_WIDTH = 340;
  const localDeviceWidth = localDevice?.width || window.screen.width;
  const localDeviceHeight = localDevice?.height || window.screen.height;
  const visualScale = VIEWPORT_WIDTH / localDeviceWidth;
  const viewportHeight = localDeviceHeight * visualScale;

  // Track touch moves inside simulated boundary and broadcast coordinates
  const handleTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!localDevice || !awarenessRef.current || e.touches.length === 0) return;

    const bounds = e.currentTarget.getBoundingClientRect();
    const touch = e.touches[0];
    const lxContainer = touch.clientX - bounds.left;
    const lyContainer = touch.clientY - bounds.top;

    const lx = lxContainer / visualScale;
    const ly = lyContainer / visualScale;

    const gx = lx + localDevice.x;
    const gy = ly + localDevice.y;

    awarenessRef.current.setLocalStateField('cursor', {
      x: gx,
      y: gy,
      active: true,
    });
  };

  const handleTouchEnd = () => {
    if (awarenessRef.current) {
      awarenessRef.current.setLocalStateField('cursor', {
        x: 0,
        y: 0,
        active: false,
      });
    }
  };

  if (!connected) {
    return (
      <PairingScreen
        onPair={handlePair}
        errorMessage={errorMessage}
        deviceId={localDeviceId}
      />
    );
  }

  return (
    <div className="flex flex-col h-screen w-screen bg-slate-950 font-sans select-none overflow-hidden touch-none">
      {/* Mobile Top Bar */}
      <header className="h-14 border-b border-slate-900 bg-slate-950 flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center gap-2">
          <Smartphone size={18} className="text-purple-500 animate-pulse" />
          <div className="flex flex-col">
            <span className="text-xs font-semibold text-slate-200">Mobile Companion</span>
            <span className="text-[9px] font-mono text-slate-500">Room {roomPin}</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded text-[10px] font-semibold">
            <Activity size={10} /> Active
          </div>
          <button
            onClick={handleDisconnect}
            className="text-slate-400 hover:text-slate-200 p-1.5 rounded-lg bg-slate-900 border border-slate-800 transition"
          >
            <LogOut size={14} />
          </button>
        </div>
      </header>

      {/* Main Workspace Simulator */}
      <main className="flex-1 flex flex-col items-center justify-center p-4 bg-slate-900/10 overflow-hidden">
        <div className="text-[10px] font-medium text-slate-400 mb-2 flex items-center gap-1 uppercase tracking-wider">
          Workspace Viewport ({localDeviceWidth}×{localDeviceHeight})
        </div>

        {/* Mobile Viewport Frame */}
        <div
          ref={viewportRef}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          style={{
            width: VIEWPORT_WIDTH,
            height: viewportHeight,
            position: 'relative',
            backgroundColor: '#0f172a', // Slate 900
            border: '4px solid #1e293b', // Frame
            borderRadius: '16px',
            boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5)',
            overflow: 'hidden',
          }}
          className="grid-overlay"
        >
          {/* Render remote soft-edge cursor overlays */}
          <CursorOverlay
            localDeviceId={localDeviceId}
            localDevice={localDevice}
            awareness={awarenessRef.current}
          />

          {/* Render mock windows overlapping this screen */}
          {windows.map((win) => (
            <MobileWindowRenderer
              key={win.id}
              localDeviceId={localDeviceId}
              localDevice={localDevice!}
              windowState={win}
              stream={win.streamId ? remoteStreams[win.streamId] || null : null}
              focusedWindowId={focusedWindowId}
              onDragStart={handleDragStart}
              onDrag={handleDrag}
              onDragEnd={handleDragEnd}
              rtcManager={rtcManagerRef.current}
              devicesMap={docRef.current?.getMap<Device>('devices') || new Y.Map()}
              onFocusClick={handleFocusClick}
            />
          ))}

          {/* Boundaries indicators */}
          <div className="absolute inset-y-0 left-0 w-[2px] bg-purple-500/10 pointer-events-none" />
          <div className="absolute inset-y-0 right-0 w-[2px] bg-purple-500/10 pointer-events-none" />
        </div>
      </main>
    </div>
  );
}
