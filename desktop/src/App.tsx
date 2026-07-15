import React, { useState, useEffect, useRef } from 'react';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import { Plus, Monitor, Terminal, Wifi, ShieldAlert, Tv } from 'lucide-react';
import {
  getDeviceId,
  initOmniDoc,
  Device,
  WindowInstance,
  OmniRTCManager,
  OmniCaptureManager,
  OmniMediaTransportManager,
  OmniQualityController,
  focusWindow,
} from 'core';
import { CursorOverlay } from 'ui';
import { CalibrationScreen } from './components/CalibrationScreen.js';
import { useWindowHandoff } from './hooks/useWindowHandoff.js';
import { WindowCapturePrompt } from './components/WindowCapturePrompt.js';
import { useNativeWindowTracking } from './hooks/useNativeWindowTracking.js';
import { DesktopWindowRenderer } from './components/DesktopWindowRenderer.js';
import { useClipboardWatcher } from './hooks/useClipboardWatcher.js';
import { PermissionOnboarding } from './components/PermissionOnboarding.js';

export default function App() {
  const [localDeviceId] = useState(() => getDeviceId());
  const [pin, setPin] = useState(() => Math.floor(100000 + Math.random() * 900000).toString());
  const [roomPin, setRoomPin] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [focusedWindowId, setFocusedWindowId] = useState<string | null>(null);
  const [showAccessibilityOnboarding, setShowAccessibilityOnboarding] = useState(false);
  const [showScreenRecordingOnboarding, setShowScreenRecordingOnboarding] = useState(false);
  const [pendingCapture, setPendingCapture] = useState<{ hwndHandle: number | null; windowTitle: string } | null>(null);
  const [focusFollowsCursor, setFocusFollowsCursor] = useState(() => {
    return localStorage.getItem('omni-settings-focus-follows-cursor') === 'true';
  });

  // Shared Doc and Awareness instances
  const docRef = useRef<Y.Doc | null>(null);
  const awarenessRef = useRef<awarenessProtocol.Awareness | null>(null);
  const rtcManagerRef = useRef<OmniRTCManager | null>(null);

  // Clipboard Watcher hook
  useClipboardWatcher(localDeviceId, docRef.current, connected);

  // Synchronized state lists
  const [devices, setDevices] = useState<Device[]>([]);
  const [windows, setWindows] = useState<WindowInstance[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [remoteStreams, setRemoteStreams] = useState<{ [streamId: string]: MediaStream }>({});
  const [showCapturePrompt, setShowCapturePrompt] = useState(false);

  const captureManagerRef = useRef<OmniCaptureManager | null>(null);
  const mediaTransportRef = useRef<OmniMediaTransportManager | null>(null);
  const qualityControllerRef = useRef<OmniQualityController | null>(null);
  const localWindowHandlesRef = useRef<Map<string, number>>(new Map());

  const workspaceRef = useRef<HTMLDivElement>(null);

  // Load configuration from environment
  const signalingUrl = ((import.meta as any).env.VITE_SIGNALING_URL as string) || 'wss://omnispace-322x.onrender.com';

  const addLog = (msg: string) => {
    setLogs((prev) => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev.slice(0, 49)]);
  };

  useEffect(() => {
    // Initialize Yjs structures
    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);

    // Set local awareness user details
    const color = `#${Math.floor(Math.random() * 16777215).toString(16)}`;
    awareness.setLocalState({
      deviceId: localDeviceId,
      name: `Desktop-${localDeviceId.substring(0, 4)}`,
      color,
      cursor: { x: 0, y: 0, active: false },
    });

    docRef.current = doc;
    awarenessRef.current = awareness;

    const { devices: devicesMap, windows: windowsMap } = initOmniDoc(doc);

    // Sync state changes to React
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

  // Synchronize Yjs window focus state to React
  useEffect(() => {
    if (!docRef.current || !connected) return;
    const stateMap = docRef.current.getMap<any>('state');

    const updateFocus = () => {
      const newFocusId = stateMap.get('focusedWindowId') || null;
      setFocusedWindowId(newFocusId);

      if (newFocusId && docRef.current) {
        const windowsMap = docRef.current.getMap<WindowInstance>('windows');
        const win = windowsMap.get(newFocusId);
        if (win && win.capturingDeviceId === localDeviceId) {
          const hwnd = localWindowHandlesRef.current.get(newFocusId);
          if (hwnd) {
            import('@tauri-apps/api/tauri').then(({ invoke }) => {
              invoke('focus_native_window', { handle: hwnd }).catch((err) =>
                console.error('Failed to focus native window:', err)
              );
            }).catch((err) => console.error(err));
          }
        }
      }
    };

    stateMap.observe(updateFocus);
    updateFocus();

    return () => {
      stateMap.unobserve(updateFocus);
    };
  }, [connected, localDeviceId]);

  const handleFocusClick = (windowId: string) => {
    if (docRef.current) {
      focusWindow(docRef.current, windowId);
    }
  };

  const handleConnect = () => {
    if (pin.length !== 6 || isNaN(Number(pin))) {
      setErrorMessage('PIN must be a 6-digit number');
      return;
    }

    setErrorMessage(null);
    addLog(`Connecting to signaling server at ${signalingUrl}...`);

    const doc = docRef.current!;
    const awareness = awarenessRef.current!;

    // Initialize WebRTC connection broker manager
    const rtcManager = new OmniRTCManager(
      localDeviceId,
      'desktop',
      pin,
      signalingUrl,
      doc,
      awareness
    );

    // Forward received input events to Tauri Rust synthetic injectors
    rtcManager.onMouseInputReceived = (_peerId, envelope) => {
      import('@tauri-apps/api/tauri').then(({ invoke }) => {
        invoke('inject_input', { event: JSON.stringify(envelope.event) }).catch((err) =>
          console.error('Failed to invoke inject_input:', err)
        );
      }).catch((err) => console.error(err));
    };

    rtcManager.onKeyboardInputReceived = (_peerId, envelope) => {
      import('@tauri-apps/api/tauri').then(({ invoke }) => {
        invoke('inject_input', { event: JSON.stringify(envelope.event) }).catch((err) =>
          console.error('Failed to invoke inject_input:', err)
        );
      }).catch((err) => console.error(err));
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

    // Initialize adaptive quality controller
    const qualityController = new OmniQualityController(
      rtcManager,
      (winId, peerId) => mediaTransport.getSender(winId, peerId)
    );
    qualityControllerRef.current = qualityController;

    // Handle incoming WebRTC remote tracks (receiving end)
    rtcManager.onRemoteTrackReceived = (peerId: string, stream: MediaStream) => {
      addLog(`Received remote window streaming feed from peer ${peerId.substring(0, 4)}`);
      setRemoteStreams((prev) => ({
        ...prev,
        [stream.id]: stream,
      }));
    };

    rtcManagerRef.current = rtcManager;

    // Listen for connection states indirectly through local device status
    const devicesMap = doc.getMap<Device>('devices');
    const checkConnection = () => {
      const self = devicesMap.get(localDeviceId);
      if (self && self.status === 'connected') {
        setConnected(true);
        setRoomPin(pin);
        addLog(`Connected to Room ${pin}! Roster sync complete.`);
        devicesMap.unobserve(checkConnection);
      }
    };
    devicesMap.observe(checkConnection);

    rtcManager.connect();
  };

  const handleDisconnect = () => {
    mediaTransportRef.current?.destroy();
    mediaTransportRef.current = null;

    qualityControllerRef.current?.destroy();
    qualityControllerRef.current = null;

    captureManagerRef.current?.destroy();
    captureManagerRef.current = null;

    rtcManagerRef.current?.destroy();
    rtcManagerRef.current = null;

    setRemoteStreams({});
    setConnected(false);
    setRoomPin(null);
    addLog('Disconnected from room.');
  };

  const handleCreateWindow = () => {
    if (!docRef.current || !localDevice) return;
    const windowsMap = docRef.current.getMap<WindowInstance>('windows');

    const winWidth = 300;
    const winHeight = 200;

    // Spawn window in the center of local device coordinates
    const gx = localDevice.x + (localDevice.width - winWidth) / 2;
    const gy = localDevice.y + (localDevice.height - winHeight) / 2;
    const windowId = `window-${crypto.randomUUID()}`;

    const newWindow: WindowInstance = {
      id: windowId,
      title: `Workspace Note #${windowsMap.size + 1}`,
      width: winWidth,
      height: winHeight,
      x: gx,
      y: gy,
      owningDeviceId: localDeviceId, // Claim initially
      capturingDeviceId: localDeviceId,
      hasActiveCapture: false,
    };

    windowsMap.set(windowId, newWindow);
    addLog(`Created mock window "${newWindow.title}"`);
  };

  const handleWindowCaptureStart = async (hwndHandle: number | null, windowTitle: string) => {
    setShowCapturePrompt(false);
    if (!docRef.current || !captureManagerRef.current || !localDevice) return;

    // Check if permissions are active on macOS/Linux
    if (typeof window !== 'undefined' && (window as any).__TAURI_METADATA__) {
      try {
        const { invoke } = await import('@tauri-apps/api/tauri');
        
        // 1. Check Screen Recording capture permission first
        const hasCapturePermission = await invoke<boolean>('check_screen_recording_permission');
        if (!hasCapturePermission) {
          setPendingCapture({ hwndHandle, windowTitle });
          setShowScreenRecordingOnboarding(true);
          return;
        }

        // 2. Then check Accessibility input control permission
        const hasInputPermission = await invoke<boolean>('check_accessibility_permission');
        if (!hasInputPermission) {
          setPendingCapture({ hwndHandle, windowTitle });
          setShowAccessibilityOnboarding(true);
          return;
        }
      } catch (err) {
        console.error('Failed to check permissions:', err);
      }
    }

    const windowId = `window-${crypto.randomUUID()}`;
    const windowsMap = docRef.current.getMap<WindowInstance>('windows');

    const winWidth = 800;
    const winHeight = 600;
    const gx = localDevice.x + (localDevice.width - winWidth) / 2;
    const gy = localDevice.y + (localDevice.height - winHeight) / 2;

    try {
      // 1. Request getDisplayMedia capture from user
      const stream = await captureManagerRef.current.startWindowCapture(windowId, (endedId) => {
        // Callback: User clicked browser "Stop Sharing": delete window from Yjs
        docRef.current?.transact(() => {
          windowsMap.delete(endedId);
        });
        
        // Stop tauri tracking if any
        if (hwndHandle && typeof window !== 'undefined' && (window as any).__TAURI_METADATA__) {
          import('@tauri-apps/api/tauri').then(({ invoke }) => {
            invoke('stop_tracking_window').catch((err) => console.error(err));
          }).catch((err) => console.error(err));
        }
      }, hwndHandle);

      // 2. Set stream in local React state so local video renderer can display it
      setRemoteStreams((prev) => ({
        ...prev,
        [stream.id]: stream,
      }));

      // 3. Create Yjs WindowInstance
      const newWindow: WindowInstance = {
        id: windowId,
        title: windowTitle || 'Shared Windows OS Viewport',
        width: winWidth,
        height: winHeight,
        x: gx,
        y: gy,
        owningDeviceId: localDeviceId, // Initially local
        capturingDeviceId: localDeviceId, // Capturer is local
        hasActiveCapture: true,
        streamId: stream.id,
      };

      if (hwndHandle) {
        localWindowHandlesRef.current.set(windowId, hwndHandle);
      }

      docRef.current.transact(() => {
        windowsMap.set(windowId, newWindow);
      });

      // 4. Start Tauri coordinate tracking if running in Tauri context
      if (hwndHandle && typeof window !== 'undefined' && (window as any).__TAURI_METADATA__) {
        const { invoke } = await import('@tauri-apps/api/tauri');
        await invoke('start_tracking_window', { handle: hwndHandle });
      }

      addLog(`Started streaming window "${newWindow.title}" (Stream ID: ${stream.id})`);
    } catch (err: any) {
      console.error(err);
      addLog(`Capture Cancelled/Failed: ${err.message || err}`);
    }
  };

  // Find local device state
  const localDevice = devices.find((d) => d.id === localDeviceId) || null;

  // Setup useWindowHandoff hook
  const { handleDragStart, handleDrag, handleDragEnd } = useWindowHandoff(
    localDeviceId,
    localDevice,
    devices,
    docRef.current?.getMap<WindowInstance>('windows') || new Y.Map()
  );

  useNativeWindowTracking(
    localDeviceId,
    docRef.current?.getMap<WindowInstance>('windows') || new Y.Map(),
    localWindowHandlesRef.current
  );

  // Compute visual scale for workspace viewport frame (e.g. scale 1920px screen width down to 800px container)
  const VIEWPORT_WIDTH = 750;
  const localDeviceWidth = localDevice?.width || window.screen.width;
  const localDeviceHeight = localDevice?.height || window.screen.height;
  const visualScale = VIEWPORT_WIDTH / localDeviceWidth;
  const viewportHeight = localDeviceHeight * visualScale;

  // Track cursor position inside viewport frame and broadcast coordinates
  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!localDevice || !awarenessRef.current) return;

    const bounds = e.currentTarget.getBoundingClientRect();
    const lxContainer = e.clientX - bounds.left;
    const lyContainer = e.clientY - bounds.top;

    // Map local container coordinates back to local device pixels
    const lx = lxContainer / visualScale;
    const ly = lyContainer / visualScale;

    // Map local device pixels to global shared coordinates
    const gx = lx + localDevice.x;
    const gy = ly + localDevice.y;

    // Broadcast cursor position via Yjs Awareness
    awarenessRef.current.setLocalStateField('cursor', {
      x: gx,
      y: gy,
      active: true,
    });
  };

  const handleMouseLeave = () => {
    if (awarenessRef.current) {
      awarenessRef.current.setLocalStateField('cursor', {
        x: 0,
        y: 0,
        active: false,
      });
    }
  };

  return (
    <div className="flex flex-col h-screen w-screen bg-slate-950 font-sans">
      {/* Top Header Bar */}
      <header className="h-14 border-b border-slate-800 bg-slate-900/60 backdrop-blur-md flex items-center justify-between px-6 z-20">
        <div className="flex items-center gap-3">
          <div className="text-xl font-bold text-slate-100 flex items-center gap-2 tracking-wide">
            <span className="text-purple-500">🌌</span> Omni-Space
          </div>
          <span className="text-xs text-slate-500 font-mono">v1.0.0</span>
        </div>

        <div className="flex items-center gap-4">
          {connected ? (
            <>
              <div className="flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 px-3 py-1 rounded-full text-xs font-medium">
                <Wifi size={13} className="animate-pulse" />
                Connected: Room {roomPin}
              </div>
              <button
                onClick={handleDisconnect}
                className="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs px-3 py-1.5 rounded-lg border border-slate-700 transition"
              >
                Disconnect
              </button>
            </>
          ) : (
            <div className="flex items-center gap-2 text-slate-500 text-xs font-medium">
              <Wifi size={13} />
              Offline
            </div>
          )}
        </div>
      </header>

      {/* Main Content Dashboard */}
      <main className="flex-1 flex overflow-hidden">
        {/* Left Column: Calibration / Controls */}
        <section className="w-[320px] border-r border-slate-800 flex flex-col bg-slate-950/80">
          {!connected ? (
            <div className="flex-1 flex flex-col justify-center px-6 gap-6">
              <div className="glass-panel p-6 rounded-2xl flex flex-col gap-4">
                <h3 className="text-base font-semibold text-slate-200">Join Workspace</h3>
                <p className="text-xs text-slate-400">
                  Enter a 6-digit room PIN code to pair this computer with other tablets, mobiles, or browser windows.
                </p>

                <div className="flex flex-col items-center gap-1 p-3 bg-purple-500/10 border border-purple-500/20 rounded-xl text-center">
                  <span className="text-[10px] uppercase tracking-wider text-purple-400 font-bold">Suggested Pairing PIN</span>
                  <span className="text-2xl font-bold tracking-widest text-purple-300 font-mono">{pin}</span>
                </div>

                <div className="flex flex-col gap-2">
                  <label className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">
                    Room PIN Code
                  </label>
                  <input
                    type="text"
                    value={pin}
                    onChange={(e) => setPin(e.target.value.slice(0, 6))}
                    placeholder="e.g. 123456"
                    className="bg-slate-900 border border-slate-800 focus:border-purple-500 outline-none px-3 py-2 rounded-lg text-slate-200 font-mono text-center tracking-widest text-sm"
                  />
                </div>

                {errorMessage && (
                  <div className="flex items-center gap-2 text-rose-400 text-xs bg-rose-500/10 border border-rose-500/20 p-2.5 rounded-lg">
                    <ShieldAlert size={14} className="shrink-0" />
                    <span>{errorMessage}</span>
                  </div>
                )}

                <button
                  onClick={handleConnect}
                  className="bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-slate-100 text-sm font-semibold py-2 rounded-lg shadow-lg shadow-purple-500/10 transition"
                >
                  Pair Device
                </button>
              </div>

              <div className="text-[11px] text-slate-600 text-center leading-relaxed">
                Device Identity: <span className="font-mono">{localDeviceId.substring(0, 12)}...</span>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col overflow-hidden">
              {/* Arrange Displays component */}
              <div className="flex-1 border-b border-slate-900 min-h-[300px]">
                <CalibrationScreen
                  localDeviceId={localDeviceId}
                  devices={devices}
                  devicesMap={
                    docRef.current?.getMap<Device>('devices') || new Y.Map<Device>()
                  }
                />
              </div>

              {/* Window Controls */}
              <div className="p-4 border-b border-slate-900 bg-slate-900/10 flex flex-col gap-2">
                <button
                  onClick={handleCreateWindow}
                  className="w-full bg-purple-600 hover:bg-purple-500 text-slate-100 text-xs font-semibold py-2.5 rounded-lg flex items-center justify-center gap-2 transition"
                >
                  <Plus size={14} /> Create App Window
                </button>
                <button
                  onClick={() => setShowCapturePrompt(true)}
                  className="w-full bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold py-2.5 rounded-lg flex items-center justify-center gap-2 border border-slate-700 transition"
                >
                  <Tv size={14} className="text-indigo-400" /> Share OS Window
                </button>
                <div className="flex items-center justify-between mt-2 px-1 text-slate-400 text-xs">
                  <span>Focus-follows-cursor</span>
                  <button
                    onClick={() => {
                      const next = !focusFollowsCursor;
                      setFocusFollowsCursor(next);
                      localStorage.setItem('omni-settings-focus-follows-cursor', next ? 'true' : 'false');
                    }}
                    className={`w-9 h-5 flex items-center rounded-full p-0.5 transition-colors duration-200 focus:outline-none ${
                      focusFollowsCursor ? 'bg-purple-600' : 'bg-slate-800'
                    }`}
                  >
                    <div
                      className={`bg-white w-4 h-4 rounded-full shadow-md transform transition-transform duration-200 ${
                        focusFollowsCursor ? 'translate-x-4' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>
              </div>

              {/* Logs */}
              <div className="flex-1 flex flex-col min-h-[150px] overflow-hidden">
                <div className="p-3 border-b border-slate-900 bg-slate-900/30 flex items-center gap-2 text-slate-400">
                  <Terminal size={13} />
                  <span className="text-[10px] font-bold uppercase tracking-wider">System Terminal</span>
                </div>
                <div className="flex-1 p-3 overflow-y-auto font-mono text-[10px] text-slate-500 flex flex-col gap-1.5 bg-slate-950">
                  {logs.length === 0 ? (
                    <div className="text-slate-700 italic">No events logged yet.</div>
                  ) : (
                    logs.map((log, idx) => <div key={idx}>{log}</div>)
                  )}
                </div>
              </div>
            </div>
          )}
        </section>

        {/* Right Column: Virtual Screen Simulator Viewport */}
        <section className="flex-1 bg-slate-900/30 flex items-center justify-center p-6 relative">
          {!connected ? (
            <div className="flex flex-col items-center gap-4 text-center max-w-sm">
              <div className="w-16 h-16 rounded-full bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-500 text-2xl">
                🌌
              </div>
              <h3 className="text-slate-300 font-semibold text-base">Workspace Simulation Area</h3>
              <p className="text-xs text-slate-500 leading-relaxed">
                Connect this device using a pairing PIN first. Once connected, your active desktop screen will simulate here, allowing windows and cursors to be dragged across seams.
              </p>
            </div>
          ) : (
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
                  width: VIEWPORT_WIDTH,
                  height: viewportHeight,
                  position: 'relative',
                  backgroundColor: '#0f172a', // Slate 900
                  border: '4px solid #1e293b', // Frame
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
                  awareness={awarenessRef.current}
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
                    rtcManager={rtcManagerRef.current}
                    devicesMap={docRef.current?.getMap<Device>('devices') || new Y.Map()}
                    onFocusClick={handleFocusClick}
                  />
                ))}

                {/* Visual warning seam if no neighbor device aligns */}
                <div className="absolute inset-y-0 right-0 w-[3px] bg-purple-500/20 pointer-events-none" />
                <div className="absolute inset-y-0 left-0 w-[3px] bg-purple-500/20 pointer-events-none" />
              </div>
            </div>
          )}
        </section>
      </main>

      {showCapturePrompt && (
        <WindowCapturePrompt
          onCaptureSelected={handleWindowCaptureStart}
          onClose={() => setShowCapturePrompt(false)}
        />
      )}

      {showAccessibilityOnboarding && (
        <PermissionOnboarding
          scope="accessibility"
          onClose={() => {
            setShowAccessibilityOnboarding(false);
            setPendingCapture(null);
          }}
          onPermissionGranted={() => {
            setShowAccessibilityOnboarding(false);
            if (pendingCapture) {
              handleWindowCaptureStart(pendingCapture.hwndHandle, pendingCapture.windowTitle);
              setPendingCapture(null);
            }
          }}
        />
      )}

      {showScreenRecordingOnboarding && (
        <PermissionOnboarding
          scope="screen_recording"
          onClose={() => {
            setShowScreenRecordingOnboarding(false);
            setPendingCapture(null);
          }}
          onPermissionGranted={() => {
            setShowScreenRecordingOnboarding(false);
            if (pendingCapture) {
              handleWindowCaptureStart(pendingCapture.hwndHandle, pendingCapture.windowTitle);
              setPendingCapture(null);
            }
          }}
        />
      )}
    </div>
  );
}
