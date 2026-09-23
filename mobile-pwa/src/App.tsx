import React, { useState, useEffect, useRef } from 'react';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import { LogOut, Smartphone, Clipboard, Tv, Plus, QrCode, Sliders, Monitor, X } from 'lucide-react';
import {
  getDeviceId,
  initOmniDoc,
  Device,
  WindowInstance,
  OmniRTCManager,
  OmniQualityController,
  OmniCaptureManager,
  OmniMediaTransportManager,
  focusWindow,
  areWindowsEqual,
  areDevicesEqual,
  triggerBrowserDownload,
  ClipboardHistoryItem,
} from 'core';
import {
  CursorOverlay,
  ErrorBoundary,
  FileTransferHUD,
  InFlightTransferState,
  ClipboardHistoryDrawer,
} from 'ui';
import { PairingScreen } from './components/PairingScreen.js';
import { useWindowHandoff } from './hooks/useWindowHandoff.js';
import { MobileWindowRenderer } from './components/MobileWindowRenderer.js';
import { useMobileClipboardSync } from './hooks/useMobileClipboardSync.js';
import { ModifierKeyBar } from './components/ModifierKeyBar.js';
import { VirtualTrackpad } from './components/VirtualTrackpad.js';
import { WorkspaceViewport } from './components/WorkspaceViewport.js';
import { CalibrationScreen } from './components/CalibrationScreen.js';
import { PairingQRCodeModal } from './components/PairingQRCodeModal.js';

const EMPTY_DEVICES_MAP = new Y.Map<Device>();

export default function App() {
  const [localDeviceId] = useState(() => getDeviceId());
  const [roomPin, setRoomPin] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [focusedWindowId, setFocusedWindowId] = useState<string | null>(null);
  const [inputMode, setInputMode] = useState<'direct' | 'trackpad'>('direct');
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [inFlightTransfer, setInFlightTransfer] = useState<InFlightTransferState | null>(null);
  const [showClipboardDrawer, setShowClipboardDrawer] = useState(false);
  const [clipboardHistory, setClipboardHistory] = useState<ClipboardHistoryItem[]>([]);

  // Multi-Device Role & View State
  const [role, setRole] = useState<'host' | 'join'>(() => {
    if (typeof window !== 'undefined') {
      if (window.location.search.includes('pin=')) return 'join';
      if (window.innerWidth >= 768) return 'host';
    }
    return 'join';
  });
  const [viewMode, setViewMode] = useState<'desk' | 'companion'>('desk');
  const [showQRModal, setShowQRModal] = useState(false);
  const [showCalibration, setShowCalibration] = useState(false);
  const windowCounterRef = useRef<number>(0);

  useEffect(() => {
    const onUpdate = () => setUpdateAvailable(true);
    window.addEventListener('sw-update-available', onUpdate);

    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstall);

    return () => {
      window.removeEventListener('sw-update-available', onUpdate);
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
    };
  }, []);

  // Doc, Awareness, RTC Manager refs
  const docRef = useRef<Y.Doc | null>(null);
  const awarenessRef = useRef<awarenessProtocol.Awareness | null>(null);
  const rtcManagerRef = useRef<OmniRTCManager | null>(null);
  const checkConnectionObserverRef = useRef<(() => void) | null>(null);

  // CRDT list states
  const [devices, setDevices] = useState<Device[]>([]);
  const [windows, setWindows] = useState<WindowInstance[]>([]);
  const [remoteStreams, setRemoteStreams] = useState<{ [streamId: string]: MediaStream }>({});

  const qualityControllerRef = useRef<OmniQualityController | null>(null);
  const captureManagerRef = useRef<OmniCaptureManager | null>(null);
  const mediaTransportRef = useRef<OmniMediaTransportManager | null>(null);
  const polledWindowIdsRef = useRef<Set<string>>(new Set());

  const viewportRef = useRef<HTMLDivElement>(null);

  const signalingUrl = import.meta.env.VITE_SIGNALING_URL || 'wss://omnispace-322x.onrender.com';

  const [docInstance, setDocInstance] = useState<Y.Doc | null>(null);

  useEffect(() => {
    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);

    // Initial awareness state with high-contrast color
    const palette = ['#a855f7', '#ec4899', '#3b82f6', '#10b981', '#f59e0b', '#06b6d4', '#8b5cf6'];
    const color = palette[Math.floor(Math.random() * palette.length)];
    awareness.setLocalState({
      deviceId: localDeviceId,
      name: role === 'host' ? `Host-${localDeviceId.substring(0, 4)}` : `Mobile-${localDeviceId.substring(0, 4)}`,
      color,
      cursor: { x: 0, y: 0, active: false },
    });

    docRef.current = doc;
    awarenessRef.current = awareness;
    setDocInstance(doc);

    const { devices: devicesMap, windows: windowsMap } = initOmniDoc(doc);

    const syncState = () => {
      const nextDevices = Array.from(devicesMap.values());
      setDevices((prev) => (areDevicesEqual(prev, nextDevices) ? prev : nextDevices));

      const nextWindows = Array.from(windowsMap.values());
      setWindows((prev) => (areWindowsEqual(prev, nextWindows) ? prev : nextWindows));
    };

    devicesMap.observe(syncState);
    windowsMap.observe(syncState);

    return () => {
      devicesMap.unobserve(syncState);
      windowsMap.unobserve(syncState);
      doc.destroy();
    };
  }, [localDeviceId, role]);

  // Synchronize incoming remote track stats polling declaratively
  useEffect(() => {
    if (!connected || !qualityControllerRef.current || !rtcManagerRef.current) return;
    const rtc = rtcManagerRef.current;
    const qc = qualityControllerRef.current;
    const activePollingIds = new Set<string>();

    windows.forEach((win) => {
      const shouldPoll =
        win.owningDeviceId === localDeviceId &&
        win.capturingDeviceId !== localDeviceId &&
        win.hasActiveCapture &&
        Boolean(win.streamId && remoteStreams[win.streamId]);

      if (shouldPoll) {
        activePollingIds.add(win.id);
        if (!polledWindowIdsRef.current.has(win.id)) {
          const pc = rtc.getPeerConnection(win.capturingDeviceId);
          if (pc) {
            qc.startStatsPolling(win.id, win.capturingDeviceId, pc);
            polledWindowIdsRef.current.add(win.id);
          }
        }
      }
    });

    polledWindowIdsRef.current.forEach((winId) => {
      if (!activePollingIds.has(winId)) {
        qc.stopStatsPolling(winId);
        polledWindowIdsRef.current.delete(winId);
      }
    });
  }, [windows, remoteStreams, connected, localDeviceId]);

  // Clean up all active stats polling on component unmount
  useEffect(() => {
    const polledWindowIds = polledWindowIdsRef.current;
    return () => {
      const qc = qualityControllerRef.current;
      polledWindowIds.forEach((winId) => {
        qc?.stopStatsPolling(winId);
      });
      polledWindowIds.clear();
    };
  }, []);

  // Auto-pair if PIN is provided in URL query string (e.g. from scanned QR code)
  useEffect(() => {
    if (typeof window !== 'undefined' && window.location.search) {
      const params = new URLSearchParams(window.location.search);
      const pinParam = params.get('pin');
      if (pinParam && /^\d{6}$/.test(pinParam) && !connected && !isConnecting && !rtcManagerRef.current && docRef.current && awarenessRef.current) {
        handlePair(pinParam, 'join');
      }
    }
  }, [connected, isConnecting]);

  const handlePair = (pin: string, requestedRole?: 'host' | 'join') => {
    if (connected || isConnecting || rtcManagerRef.current) return;
    setIsConnecting(true);
    setErrorMessage(null);

    const activeRole = requestedRole || role;
    setRole(activeRole);
    setViewMode(activeRole === 'host' ? 'desk' : 'companion');

    const doc = docRef.current!;
    const awareness = awarenessRef.current!;

    const deviceType: 'desktop' | 'mobile' = activeRole === 'host' ? 'desktop' : 'mobile';

    // Update awareness user info
    awareness.setLocalStateField('name', `${activeRole === 'host' ? 'Host' : 'Companion'}-${localDeviceId.substring(0, 4)}`);

    // Initialize WebRTC connection broker manager
    const rtcManager = new OmniRTCManager(
      localDeviceId,
      deviceType,
      pin,
      signalingUrl,
      doc,
      awareness
    );

    rtcManager.onSignalingError = (err) => {
      setErrorMessage(`Signaling error: ${err.message}`);
      setIsConnecting(false);
    };

    // Initialize capture manager
    const captureManager = new OmniCaptureManager();
    captureManagerRef.current = captureManager;

    const windowsMap = doc.getMap<WindowInstance>('windows');

    // Initialize media transport manager
    const mediaTransport = new OmniMediaTransportManager(
      rtcManager,
      captureManager,
      windowsMap
    );
    mediaTransportRef.current = mediaTransport;

    // Quality controller with real media transport sender lookup
    const qualityController = new OmniQualityController(
      rtcManager,
      (winId, peerId) => mediaTransport.getSender(winId, peerId)
    );
    qualityControllerRef.current = qualityController;

    // Handle remote video stream received
    rtcManager.onRemoteTrackReceived = (_peerId: string, stream: MediaStream) => {
      setRemoteStreams((prev) => ({
        ...prev,
        [stream.id]: stream,
      }));
    };

    // Clean up ended or removed remote streams
    rtcManager.onRemoteTrackRemoved = (_peerId: string, streamId: string) => {
      setRemoteStreams((prev) => {
        const next = { ...prev };
        if (streamId && next[streamId]) {
          delete next[streamId];
        } else {
          for (const [id, s] of Object.entries(next)) {
            if (s.getTracks().every((t) => t.readyState === 'ended')) {
              delete next[id];
            }
          }
        }
        return next;
      });
    };

    // P2P Chunked File Transfer handlers
    rtcManager.onFileReceived = (_peerId, file) => {
      triggerBrowserDownload(file.name, file.data, file.mimeType);
      setInFlightTransfer(null);
    };

    rtcManager.onFileTransferProgress = (_peerId, prog) => {
      setInFlightTransfer((prev) => ({
        ...prog,
        type: prev?.type || 'download',
      }));
      if (prog.percentage >= 100) {
        setTimeout(() => setInFlightTransfer(null), 1500);
      }
    };

    rtcManager.onFileTransferAbort = () => {
      setInFlightTransfer(null);
    };

    rtcManagerRef.current = rtcManager;

    const devicesMap = doc.getMap<Device>('devices');
    if (checkConnectionObserverRef.current) {
      devicesMap.unobserve(checkConnectionObserverRef.current);
      checkConnectionObserverRef.current = null;
    }
    const checkConnection = () => {
      const self = devicesMap.get(localDeviceId);
      if (self && self.status === 'connected') {
        setConnected(true);
        setIsConnecting(false);
        setRoomPin(pin);
        devicesMap.unobserve(checkConnection);
        if (checkConnectionObserverRef.current === checkConnection) {
          checkConnectionObserverRef.current = null;
        }

        // Auto-create initial demo window if Host and no windows exist yet
        if (activeRole === 'host') {
          const winsMap = doc.getMap<WindowInstance>('windows');
          if (winsMap.size === 0) {
            const starterWinId = `win-${crypto.randomUUID()}`;
            windowCounterRef.current += 1;
            const starterWindow: WindowInstance = {
              id: starterWinId,
              title: '🚀 Drag Me to Your Phone!',
              width: 360,
              height: 240,
              x: 80,
              y: 80,
              owningDeviceId: localDeviceId,
              capturingDeviceId: localDeviceId,
              hasActiveCapture: false,
            };
            doc.transact(() => {
              winsMap.set(starterWinId, starterWindow);
            });
          }
        }
      }
    };
    checkConnectionObserverRef.current = checkConnection;
    devicesMap.observe(checkConnection);

    rtcManager.connect();
  };

  const handleDisconnect = () => {
    if (checkConnectionObserverRef.current && docRef.current) {
      const devicesMap = docRef.current.getMap<Device>('devices');
      devicesMap.unobserve(checkConnectionObserverRef.current);
      checkConnectionObserverRef.current = null;
    }

    mediaTransportRef.current?.destroy();
    mediaTransportRef.current = null;

    captureManagerRef.current?.destroy();
    captureManagerRef.current = null;

    qualityControllerRef.current?.destroy();
    qualityControllerRef.current = null;

    rtcManagerRef.current?.destroy();
    rtcManagerRef.current = null;

    setRemoteStreams({});
    setConnected(false);
    setIsConnecting(false);
    setRoomPin(null);
  };

  const handleCreateWindow = () => {
    if (!docRef.current) return;
    const windowsMap = docRef.current.getMap<WindowInstance>('windows');
    const windowId = `win-${crypto.randomUUID()}`;
    windowCounterRef.current += 1;
    const noteNum = windowCounterRef.current;

    const newWindow: WindowInstance = {
      id: windowId,
      title: `Workspace Note #${noteNum}`,
      width: 320,
      height: 220,
      x: (localDevice?.x || 0) + 60 + ((noteNum * 25) % 200),
      y: (localDevice?.y || 0) + 60 + ((noteNum * 25) % 200),
      owningDeviceId: localDeviceId,
      capturingDeviceId: localDeviceId,
      hasActiveCapture: false,
    };

    docRef.current.transact(() => {
      windowsMap.set(windowId, newWindow);
    });
  };

  const handleShareScreen = async () => {
    if (!captureManagerRef.current || !docRef.current) return;
    const windowId = `win-${crypto.randomUUID()}`;
    const windowsMap = docRef.current.getMap<WindowInstance>('windows');

    try {
      const stream = await captureManagerRef.current.startWindowCapture(windowId, (endedId: string) => {
        docRef.current?.transact(() => {
          windowsMap.delete(endedId);
        });
      });

      setRemoteStreams((prev) => ({
        ...prev,
        [stream.id]: stream,
      }));

      const newWindow: WindowInstance = {
        id: windowId,
        title: 'Web Screen Share',
        width: 800,
        height: 600,
        x: (localDevice?.x || 0) + 40,
        y: (localDevice?.y || 0) + 40,
        owningDeviceId: localDeviceId,
        capturingDeviceId: localDeviceId,
        hasActiveCapture: true,
        streamId: stream.id,
      };

      docRef.current.transact(() => {
        windowsMap.set(windowId, newWindow);
      });
    } catch (err: any) {
      if (err?.name !== 'NotAllowedError') {
        console.error('Failed to start display capture:', err);
      }
    }
  };

  const localDevice = devices.find((d) => d.id === localDeviceId) || null;

  // Visual scaling to fit phone viewport (e.g. scale 1080px screen down to 340px container)
  const VIEWPORT_WIDTH = 340;
  const localDeviceWidth = localDevice?.width || (typeof window !== 'undefined' ? window.screen.width : 1080);
  const localDeviceHeight = localDevice?.height || (typeof window !== 'undefined' ? window.screen.height : 1920);
  const visualScale = localDeviceWidth > 0 ? VIEWPORT_WIDTH / localDeviceWidth : 1;
  const viewportHeight = localDeviceHeight * visualScale;

  // Handoff hook configuration for mobile companion view
  const windowsMap = docRef.current?.getMap<WindowInstance>('windows') ?? null;

  const { handleDragStart, handleDrag, handleDragEnd } = useWindowHandoff(
    localDeviceId,
    localDevice,
    devices,
    windowsMap,
    visualScale
  );

  // Mobile bidirectional clipboard synchronization
  useMobileClipboardSync(localDeviceId, docInstance, connected, setClipboardHistory);

  // Synchronize Yjs focus state to React
  useEffect(() => {
    if (!docRef.current || !connected) return;
    const stateMap = docRef.current.getMap<string | null>('state');

    const updateFocus = () => {
      setFocusedWindowId(stateMap.get('focusedWindowId') || null);
    };

    stateMap.observe(updateFocus);
    return () => {
      stateMap.unobserve(updateFocus);
    };
  }, [connected]);

  const handleFocusClick = (windowId: string) => {
    if (!docRef.current) return;
    focusWindow(docRef.current, windowId);
  };

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

  return (
    <div className="flex flex-col h-screen w-screen bg-slate-950 text-slate-100 overflow-hidden font-sans select-none">
      {/* PWA Update Banner */}
      {updateAvailable && (
        <div className="bg-purple-600 text-white text-xs px-3 py-2 flex items-center justify-between z-50 shrink-0">
          <span>A new version of Omni-Space is available!</span>
          <button
            onClick={() => {
              if ('serviceWorker' in navigator) {
                navigator.serviceWorker.ready.then((reg) => {
                  reg.waiting?.postMessage({ type: 'SKIP_WAITING' });
                  window.location.reload();
                }).catch(() => {
                  window.location.reload();
                });
              } else {
                window.location.reload();
              }
            }}
            className="bg-white text-purple-950 font-bold px-2.5 py-1 rounded text-[11px] shadow"
          >
            Reload
          </button>
        </div>
      )}

      {/* PWA Install Banner */}
      {deferredPrompt && (
        <div className="bg-slate-900 border-b border-purple-500/30 text-slate-200 text-xs px-3 py-1.5 flex items-center justify-between z-40 shrink-0">
          <span className="text-[11px]">Install Omni-Space for best fullscreen experience</span>
          <button
            onClick={async () => {
              deferredPrompt.prompt();
              const outcome = await deferredPrompt.userChoice;
              if (outcome?.outcome === 'accepted') {
                setDeferredPrompt(null);
              }
            }}
            className="bg-purple-600 hover:bg-purple-500 text-white font-semibold px-2.5 py-1 rounded text-[11px]"
          >
            Install App
          </button>
        </div>
      )}

      {/* Dynamic Header */}
      <header className="h-14 border-b border-slate-900 px-4 flex items-center justify-between bg-slate-900/40 backdrop-blur shrink-0 z-20">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-purple-600 to-indigo-500 flex items-center justify-center shadow-lg shadow-purple-500/20">
            {role === 'host' ? <Monitor size={18} className="text-white" /> : <Smartphone size={18} className="text-white" />}
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-tight leading-none text-slate-200 flex items-center gap-1.5">
              <span>Omni-Space</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300 font-mono font-medium">
                {role === 'host' ? 'Host Workspace' : 'Companion'}
              </span>
            </h1>
            <span className="text-[10px] text-slate-500 font-medium">
              Multi-Device Spatial Workspace
            </span>
          </div>
        </div>

        {connected && (
          <div className="flex items-center gap-2">
            {/* View Mode Switcher: Desk vs Phone */}
            <div className="flex bg-slate-800/90 p-0.5 rounded-lg border border-slate-700/80">
              <button
                type="button"
                onClick={() => setViewMode('desk')}
                className={`px-2.5 py-1 text-xs rounded-md transition font-medium flex items-center gap-1.5 ${
                  viewMode === 'desk'
                    ? 'bg-purple-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
                title="View full spatial desk canvas"
              >
                <Monitor size={12} />
                <span className="hidden sm:inline">Desk Canvas</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode('companion')}
                className={`px-2.5 py-1 text-xs rounded-md transition font-medium flex items-center gap-1.5 ${
                  viewMode === 'companion'
                    ? 'bg-purple-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
                title="View companion screen"
              >
                <Smartphone size={12} />
                <span className="hidden sm:inline">Phone View</span>
              </button>
            </div>

            {/* Quick Actions in Desk View */}
            {viewMode === 'desk' && (
              <>
                <button
                  type="button"
                  onClick={handleCreateWindow}
                  className="px-2.5 py-1.5 min-h-[34px] flex items-center justify-center gap-1.5 rounded-lg bg-purple-600/80 hover:bg-purple-600 text-white text-xs font-semibold border border-purple-500/40 transition shadow-md shadow-purple-600/20"
                  title="Create new draggable window"
                >
                  <Plus size={14} />
                  <span className="hidden md:inline">Window</span>
                </button>

                <button
                  type="button"
                  onClick={() => setShowCalibration(true)}
                  className="p-2 min-w-[34px] min-h-[34px] flex items-center justify-center rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700/80 transition"
                  title="Arrange Displays"
                >
                  <Sliders size={14} className="text-amber-400" />
                </button>

                <button
                  type="button"
                  onClick={() => setShowQRModal(true)}
                  className="p-2 min-w-[34px] min-h-[34px] flex items-center justify-center rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700/80 transition"
                  title="Show Pairing QR Code"
                >
                  <QrCode size={14} className="text-purple-400" />
                </button>
              </>
            )}

            {/* Quick Actions in Companion View */}
            {viewMode === 'companion' && (
              <div className="flex bg-slate-800/90 p-0.5 rounded-lg border border-slate-700/80">
                <button
                  type="button"
                  onClick={() => setInputMode('direct')}
                  className={`px-2 py-1 text-xs rounded-md transition font-medium ${
                    inputMode === 'direct'
                      ? 'bg-purple-600 text-white shadow-sm'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Touch
                </button>
                <button
                  type="button"
                  onClick={() => setInputMode('trackpad')}
                  className={`px-2 py-1 text-xs rounded-md transition font-medium ${
                    inputMode === 'trackpad'
                      ? 'bg-purple-600 text-white shadow-sm'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Trackpad
                </button>
              </div>
            )}

            <button
              type="button"
              onClick={handleShareScreen}
              className="p-2 min-w-[34px] min-h-[34px] flex items-center justify-center rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700/80 transition"
              title="Share Screen, Window, or Tab"
              aria-label="Share screen or window"
            >
              <Tv size={14} className="text-indigo-400" />
            </button>

            <button
              type="button"
              onClick={() => setShowClipboardDrawer(true)}
              className="p-2 min-w-[34px] min-h-[34px] flex items-center justify-center rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700/80 transition"
              title="Clipboard History"
              aria-label="Open clipboard history"
            >
              <Clipboard size={14} className="text-purple-400" />
            </button>

            <button
              onClick={handleDisconnect}
              className="p-2 min-w-[34px] min-h-[34px] flex items-center justify-center rounded-lg bg-slate-800 hover:bg-slate-700 active:scale-95 text-slate-400 hover:text-slate-200 transition"
              title="Disconnect"
              aria-label="Disconnect device"
            >
              <LogOut size={16} />
            </button>
          </div>
        )}
      </header>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col items-center justify-center relative overflow-hidden">
        <ErrorBoundary fallbackTitle="Failed to render workspace">
          {!connected && (
            <div className="w-full max-w-sm p-4">
              <PairingScreen
                onPair={handlePair}
                errorMessage={errorMessage}
                deviceId={localDeviceId}
                isConnecting={isConnecting}
              />
            </div>
          )}

          {/* 1. Spatial Multi-Screen Desk Canvas */}
          {connected && viewMode === 'desk' && (
            <WorkspaceViewport
              localDeviceId={localDeviceId}
              localDevice={localDevice}
              devices={devices}
              awareness={awarenessRef.current}
              windows={windows}
              remoteStreams={remoteStreams}
              focusedWindowId={focusedWindowId}
              rtcManager={rtcManagerRef.current}
              devicesMap={docRef.current?.getMap<Device>('devices') || EMPTY_DEVICES_MAP}
              windowsMap={windowsMap}
              handleFocusClick={handleFocusClick}
              onCreateWindow={handleCreateWindow}
              onShareScreen={handleShareScreen}
              onOpenQR={() => setShowQRModal(true)}
              onOpenCalibration={() => setShowCalibration(true)}
              roomPin={roomPin}
            />
          )}

          {/* 2. Virtual Trackpad Mode in Companion View */}
          {connected && viewMode === 'companion' && inputMode === 'trackpad' && (
            <div className="w-full flex-1 max-w-md flex flex-col items-center justify-center gap-2 p-3">
              <div className="w-full flex-1 min-h-[280px]">
                <VirtualTrackpad
                  rtcManager={rtcManagerRef.current}
                  targetWindow={
                    windows.find((w) => w.id === focusedWindowId) || windows[0] || null
                  }
                  capturingDevice={
                    (() => {
                      const targetWin = windows.find((w) => w.id === focusedWindowId) || windows[0];
                      if (!targetWin) return null;
                      return devices.find((d) => d.id === targetWin.capturingDeviceId) || null;
                    })()
                  }
                />
              </div>

              <ModifierKeyBar
                rtcManager={rtcManagerRef.current}
                targetWindowId={focusedWindowId || windows[0]?.id || null}
                targetDeviceId={
                  (() => {
                    const targetWin = windows.find((w) => w.id === focusedWindowId) || windows[0];
                    return targetWin ? targetWin.capturingDeviceId : null;
                  })()
                }
              />
            </div>
          )}

          {/* 3. Direct Screen Simulator in Companion View */}
          {connected && viewMode === 'companion' && inputMode === 'direct' && (
            <div className="flex flex-col items-center gap-3 w-full p-3">
              <div
                ref={viewportRef}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
                style={{
                  width: `${VIEWPORT_WIDTH}px`,
                  height: `${viewportHeight}px`,
                }}
                className={`relative rounded-2xl border ${
                  connected ? 'border-purple-500/30 bg-slate-900/30 shadow-2xl' : 'border-transparent'
                } overflow-hidden transition-all duration-300`}
              >
                {/* Awareness Cursors */}
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
                    devicesMap={docRef.current?.getMap<Device>('devices') || EMPTY_DEVICES_MAP}
                    onFocusClick={handleFocusClick}
                  />
                ))}

                {/* Boundaries indicators */}
                <div className="absolute inset-y-0 left-0 w-[2px] bg-purple-500/10 pointer-events-none" />
                <div className="absolute inset-y-0 right-0 w-[2px] bg-purple-500/10 pointer-events-none" />
              </div>

              <ModifierKeyBar
                rtcManager={rtcManagerRef.current}
                targetWindowId={focusedWindowId || windows[0]?.id || null}
                targetDeviceId={
                  (() => {
                    const targetWin = windows.find((w) => w.id === focusedWindowId) || windows[0];
                    return targetWin ? targetWin.capturingDeviceId : null;
                  })()
                }
              />
            </div>
          )}
        </ErrorBoundary>
      </main>

      {/* Calibration / Arrange Displays Modal */}
      {showCalibration && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl flex flex-col h-[480px]">
            <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2">
                <Sliders size={16} className="text-amber-400" />
                <h3 className="text-sm font-semibold text-slate-100">Display Arrangement</h3>
              </div>
              <button
                onClick={() => setShowCalibration(false)}
                className="p-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition"
              >
                <X size={16} />
              </button>
            </div>
            <div className="flex-1 overflow-hidden">
              <CalibrationScreen
                localDeviceId={localDeviceId}
                devices={devices}
                devicesMap={docRef.current?.getMap<Device>('devices') || EMPTY_DEVICES_MAP}
              />
            </div>
          </div>
        </div>
      )}

      {/* Floating P2P File Transfer HUD */}
      <FileTransferHUD
        transfer={inFlightTransfer}
        onCancel={() => setInFlightTransfer(null)}
      />

      {/* Rich Clipboard History Drawer */}
      <ClipboardHistoryDrawer
        isOpen={showClipboardDrawer}
        onClose={() => setShowClipboardDrawer(false)}
        history={clipboardHistory}
        onSelect={(item) => {
          navigator.clipboard?.writeText(item.content).catch(() => {});
        }}
      />

      {/* Pairing QR Code Modal */}
      <PairingQRCodeModal
        isOpen={showQRModal}
        onClose={() => setShowQRModal(false)}
        roomPin={roomPin || ''}
      />
    </div>
  );
}
