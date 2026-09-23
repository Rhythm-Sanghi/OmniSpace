import React, { useState, useEffect, useRef } from 'react';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import { LogOut, Smartphone, Clipboard } from 'lucide-react';
import {
  getDeviceId,
  initOmniDoc,
  Device,
  WindowInstance,
  OmniRTCManager,
  OmniQualityController,
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
  const polledWindowIdsRef = useRef<Set<string>>(new Set());

  const viewportRef = useRef<HTMLDivElement>(null);

  const signalingUrl = import.meta.env.VITE_SIGNALING_URL || 'wss://omnispace-322x.onrender.com';

  const [docInstance, setDocInstance] = useState<Y.Doc | null>(null);

  useEffect(() => {
    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);

    // Initial mobile awareness state with vibrant high-contrast color
    const palette = ['#a855f7', '#ec4899', '#3b82f6', '#10b981', '#f59e0b', '#06b6d4', '#8b5cf6'];
    const color = palette[Math.floor(Math.random() * palette.length)];
    awareness.setLocalState({
      deviceId: localDeviceId,
      name: `Mobile-${localDeviceId.substring(0, 4)}`,
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
  }, [localDeviceId]);

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
        handlePair(pinParam);
      }
    }
  }, [connected, isConnecting]);

  const handlePair = (pin: string) => {
    if (connected || isConnecting || rtcManagerRef.current) return;
    setIsConnecting(true);
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

    rtcManager.onSignalingError = (err) => {
      setErrorMessage(`Signaling error: ${err.message}`);
      setIsConnecting(false);
    };

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

    qualityControllerRef.current?.destroy();
    qualityControllerRef.current = null;

    rtcManagerRef.current?.destroy();
    rtcManagerRef.current = null;

    setRemoteStreams({});
    setConnected(false);
    setIsConnecting(false);
    setRoomPin(null);
  };

  const localDevice = devices.find((d) => d.id === localDeviceId) || null;

  // Visual scaling to fit phone viewport (e.g. scale 1080px screen down to 350px container)
  const VIEWPORT_WIDTH = 340;
  const localDeviceWidth = localDevice?.width || (typeof window !== 'undefined' ? window.screen.width : 1080);
  const localDeviceHeight = localDevice?.height || (typeof window !== 'undefined' ? window.screen.height : 1920);
  const visualScale = localDeviceWidth > 0 ? VIEWPORT_WIDTH / localDeviceWidth : 1;
  const viewportHeight = localDeviceHeight * visualScale;

  // Handoff hook configuration
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

  // Synchronize Yjs focus state to PWA React
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
      <header className="h-14 border-b border-slate-900 px-4 flex items-center justify-between bg-slate-900/40 backdrop-blur shrink-0 z-10">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-purple-600 to-indigo-500 flex items-center justify-center shadow-lg shadow-purple-500/20">
            <Smartphone size={18} className="text-white" />
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-tight leading-none text-slate-200">Omni-Space</h1>
            <span className="text-[10px] text-slate-500 font-medium">Companion Viewport</span>
          </div>
        </div>

        {connected && (
          <div className="flex items-center gap-2">
            {/* Mode Switcher */}
            <div className="flex bg-slate-800/90 p-0.5 rounded-lg border border-slate-700/80">
              <button
                type="button"
                onClick={() => setInputMode('direct')}
                className={`px-2.5 py-1 text-xs rounded-md transition font-medium ${
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
                className={`px-2.5 py-1 text-xs rounded-md transition font-medium ${
                  inputMode === 'trackpad'
                    ? 'bg-purple-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Trackpad
              </button>
            </div>

            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-mono">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              PIN: {roomPin}
            </div>

            <button
              type="button"
              onClick={() => setShowClipboardDrawer(true)}
              className="p-2 min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700/80 transition"
              title="Clipboard History"
              aria-label="Open clipboard history"
            >
              <Clipboard size={14} className="text-purple-400" />
            </button>

            <button
              onClick={handleDisconnect}
              className="p-2 min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg bg-slate-800 hover:bg-slate-700 active:scale-95 text-slate-400 hover:text-slate-200 transition"
              title="Disconnect"
              aria-label="Disconnect device"
            >
              <LogOut size={16} />
            </button>
          </div>
        )}
      </header>

      {/* Main Content Viewport */}
      <main className="flex-1 flex flex-col items-center justify-center p-3 gap-3 relative overflow-hidden">
        <ErrorBoundary fallbackTitle="Failed to render companion viewport">
          {!connected && (
            <div className="w-full max-w-sm">
              <PairingScreen
                onPair={handlePair}
                errorMessage={errorMessage}
                deviceId={localDeviceId}
                isConnecting={isConnecting}
              />
            </div>
          )}

          {connected && inputMode === 'trackpad' && (
            <div className="w-full flex-1 max-w-md flex flex-col items-center justify-center gap-2">
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

          {/* Companion Screen Simulator Boundary */}
          {connected && inputMode === 'direct' && (
            <div className="flex flex-col items-center gap-3 w-full">
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
    </div>
  );
}
