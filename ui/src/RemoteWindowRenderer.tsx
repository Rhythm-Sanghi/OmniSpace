import React, { useRef, useEffect, useMemo, useCallback, useState } from 'react';
import { motion, PanInfo } from 'framer-motion';
import { Tv, Lock, Keyboard, Maximize2, Minimize2, UploadCloud, Volume2, VolumeX, Activity } from 'lucide-react';
import { Device, WindowInstance } from 'core';

export interface RemoteWindowRendererProps {
  localDeviceId: string;
  localDevice: Device;
  windowState: WindowInstance;
  stream: MediaStream | null;
  focusedWindowId?: string | null;
  onDragStart?: (windowId: string, event: MouseEvent | TouchEvent | PointerEvent) => void;
  onDrag?: (windowId: string, event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => void;
  onDragEnd?: (windowId: string, event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => void;
  inputCaptureListeners?: React.HTMLAttributes<HTMLDivElement>;
  onFocusClick?: (windowId: string) => void;
  focusFollowsCursor?: boolean;
  onResize?: (windowId: string, width: number, height: number) => void;
  onToggleMaximize?: (windowId: string) => void;
  peerConnection?: RTCPeerConnection | null;
  onFileDrop?: (targetPeerId: string, file: File) => void;
}

const RemoteWindowRendererComponent: React.FC<RemoteWindowRendererProps> = ({
  localDeviceId,
  localDevice,
  windowState,
  stream,
  focusedWindowId,
  onDragStart,
  onDrag,
  onDragEnd,
  inputCaptureListeners,
  onFocusClick,
  focusFollowsCursor,
  onResize,
  onToggleMaximize,
  peerConnection,
  onFileDrop,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cachedFocusFollowsCursorRef = useRef<boolean | null>(null);
  
  const isOwner = windowState.owningDeviceId === localDeviceId;
  const isFocused = focusedWindowId === windowState.id;
  const [playBlocked, setPlayBlocked] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [diagnostics, setDiagnostics] = useState<{ fps: number; rtt: number; bitrate: number; packetLoss: number } | null>(null);
  const [isDragOverFile, setIsDragOverFile] = useState(false);

  const hasAudio = useMemo(() => {
    return !!(stream && stream.getAudioTracks().length > 0);
  }, [stream]);

  // Subscribe to settings storage events once on mount
  useEffect(() => {
    if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
      cachedFocusFollowsCursorRef.current = localStorage.getItem('omni-settings-focus-follows-cursor') === 'true';
      const handleStorage = (e: StorageEvent) => {
        if (e.key === 'omni-settings-focus-follows-cursor') {
          cachedFocusFollowsCursorRef.current = e.newValue === 'true';
        }
      };
      window.addEventListener('storage', handleStorage);
      return () => {
        window.removeEventListener('storage', handleStorage);
      };
    }
    return undefined;
  }, []);

  // Bind video stream to source element
  useEffect(() => {
    let cancelled = false;
    const video = videoRef.current;
    if (video) {
      if (stream) {
        try {
          video.pause();
        } catch {
          // Ignore pause error
        }
        video.srcObject = stream;
        video
          .play()
          .then(() => {
            if (!cancelled) setPlayBlocked(false);
          })
          .catch((err) => {
            console.warn('Auto-play blocked or failed for remote window video track:', err);
            if (!cancelled) setPlayBlocked(true);
          });
      } else {
        try {
          video.pause();
        } catch {
          // Ignore pause error
        }
        video.srcObject = null;
        if (!cancelled) setPlayBlocked(false);
      }
    }
    return () => {
      cancelled = true;
      if (video) {
        try {
          video.pause();
        } catch {
          // Ignore pause error
        }
        video.srcObject = null;
      }
    };
  }, [stream]);

  // WebRTC Diagnostics stats polling
  useEffect(() => {
    if (!showDiagnostics || !peerConnection) {
      setDiagnostics(null);
      return undefined;
    }
    let prevBytes = 0;
    let prevTimestamp = Date.now();

    const interval = setInterval(async () => {
      try {
        const stats = await peerConnection.getStats();
        let fps = 0;
        let rtt = 0;
        let bitrate = 0;
        let packetLoss = 0;

        stats.forEach((report: any) => {
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            fps = report.framesPerSecond || 0;
            const now = Date.now();
            const bytes = report.bytesReceived || 0;
            if (prevBytes > 0) {
              const timeDiff = (now - prevTimestamp) / 1000;
              bitrate = timeDiff > 0 ? Math.round(((bytes - prevBytes) * 8) / (timeDiff * 1024)) : 0;
            }
            prevBytes = bytes;
            prevTimestamp = now;

            const lost = report.packetsLost || 0;
            const total = (report.packetsReceived || 0) + lost;
            if (total > 0) {
              packetLoss = Math.round((lost / total) * 100);
            }
          }
          if (report.type === 'candidate-pair' && report.state === 'succeeded') {
            rtt = Math.round((report.currentRoundTripTime || 0) * 1000);
          }
        });

        setDiagnostics({ fps, rtt, bitrate, packetLoss });
      } catch {
        // Ignore stats error
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [showDiagnostics, peerConnection]);

  // Check if window overlaps with local display bounds
  const overlapsDevice = useMemo(() => {
    return (
      windowState.x + windowState.width > localDevice.x &&
      windowState.x < localDevice.x + localDevice.width &&
      windowState.y + windowState.height > localDevice.y &&
      windowState.y < localDevice.y + localDevice.height
    );
  }, [
    windowState.x,
    windowState.y,
    windowState.width,
    windowState.height,
    localDevice.x,
    localDevice.y,
    localDevice.width,
    localDevice.height,
  ]);

  const handleDragStart = useCallback(
    (e: MouseEvent | TouchEvent | PointerEvent) => {
      if (onDragStart) onDragStart(windowState.id, e);
    },
    [onDragStart, windowState.id]
  );

  const handleDrag = useCallback(
    (e: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
      if (onDrag) onDrag(windowState.id, e, info);
    },
    [onDrag, windowState.id]
  );

  const handleDragEnd = useCallback(
    (e: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
      if (onDragEnd) onDragEnd(windowState.id, e, info);
    },
    [onDragEnd, windowState.id]
  );

  const handleContainerClick = useCallback(() => {
    if (onFocusClick) {
      onFocusClick(windowState.id);
    }
    // Pull up mobile virtual keyboard
    if (inputRef.current) {
      inputRef.current.focus();
    }
  }, [onFocusClick, windowState.id]);

  // Render nothing if it is not owned and doesn't overlap
  if (!isOwner && !overlapsDevice) {
    return null;
  }

  // Project global coordinates to local CSS viewport pixels
  const lx = windowState.x - localDevice.x;
  const ly = windowState.y - localDevice.y;

  return (
    <motion.div
      ref={containerRef}
      drag={isOwner && !!onDragStart}
      dragMomentum={false}
      dragElastic={0}
      onDragStart={handleDragStart}
      onDrag={handleDrag}
      onDragEnd={handleDragEnd}
      style={{
        position: 'absolute',
        left: lx,
        top: ly,
        width: windowState.width,
        height: windowState.height,
        zIndex: isOwner ? 1000 : 500,
        pointerEvents: isOwner ? 'auto' : 'none',
        opacity: isOwner ? 1 : 0.85,
      }}
      transition={isOwner ? { type: 'spring', stiffness: 300, damping: 25 } : { duration: 0 }}
    >
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: 'rgba(15, 23, 42, 0.85)',
          backdropFilter: 'blur(20px)',
          borderRadius: '16px',
          border: isFocused
            ? '2px solid rgba(139, 92, 246, 0.85)'
            : isOwner
            ? '1.5px solid rgba(139, 92, 246, 0.45)'
            : '1px dashed rgba(255, 255, 255, 0.15)',
          boxShadow: isFocused
            ? '0 0 0 3px rgba(139, 92, 246, 0.4), 0 25px 50px -12px rgba(0, 0, 0, 0.6)'
            : isOwner
            ? '0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 20px rgba(139, 92, 246, 0.2)'
            : '0 10px 15px -3px rgba(0, 0, 0, 0.3)',
          overflow: 'hidden',
          transition: 'border-color 0.2s, box-shadow 0.2s',
        }}
      >
        {/* Title bar */}
        <div
          aria-roledescription={isOwner && !!onDragStart ? 'Window drag handle' : undefined}
          style={{
            height: '42px',
            backgroundColor: 'rgba(15, 23, 42, 0.65)',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            display: 'flex',
            alignItems: 'center',
            padding: '0 16px',
            cursor: isOwner && !!onDragStart ? 'grab' : 'default',
            userSelect: 'none',
          }}
        >
          {/* Controls indicators */}
          <div aria-hidden="true" style={{ display: 'flex', gap: '6px', marginRight: '16px' }}>
            <div style={{ width: '11px', height: '11px', borderRadius: '50%', backgroundColor: '#ef4444', opacity: 0.75 }} />
            <div style={{ width: '11px', height: '11px', borderRadius: '50%', backgroundColor: '#f59e0b', opacity: 0.75 }} />
            <div style={{ width: '11px', height: '11px', borderRadius: '50%', backgroundColor: '#10b981', opacity: 0.75 }} />
          </div>

          {/* Title label */}
          <div
            style={{
              color: '#cbd5e1',
              fontSize: '11px',
              fontWeight: 600,
              fontFamily: 'system-ui, sans-serif',
              letterSpacing: '0.02em',
              flex: 1,
              textAlign: 'center',
              marginRight: '60px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
            }}
          >
            {windowState.hasActiveCapture && <Tv size={12} className="text-violet-400 animate-pulse" />}
            {windowState.title}
          </div>

          {/* Window control badges */}
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            {isFocused && (
              <div role="status" aria-label="Keyboard input active" title="Keyboard input active" style={{ color: '#a855f7', display: 'flex', alignItems: 'center', gap: '4px' }}>
                <Keyboard size={12} className="animate-pulse" />
              </div>
            )}
            {windowState.hasActiveCapture && (
              <div
                role="status"
                aria-label="Live feed active"
                style={{
                  backgroundColor: 'rgba(168, 85, 247, 0.15)',
                  border: '1px solid rgba(168, 85, 247, 0.3)',
                  color: '#c084fc',
                  fontSize: '9px',
                  fontWeight: 700,
                  padding: '2px 6px',
                  borderRadius: '4px',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
              >
                <div className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-ping" />
                Live Feed
              </div>
            )}
            {hasAudio && windowState.capturingDeviceId !== localDeviceId && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsMuted(!isMuted);
                }}
                className="p-1 hover:bg-white/10 rounded transition-colors text-slate-300 hover:text-white cursor-pointer"
                aria-label={isMuted ? 'Unmute window audio' : 'Mute window audio'}
                title={isMuted ? 'Unmute window audio' : 'Mute window audio'}
              >
                {isMuted ? <VolumeX size={12} className="text-rose-400" /> : <Volume2 size={12} className="text-emerald-400" />}
              </button>
            )}
            {peerConnection && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowDiagnostics(!showDiagnostics);
                }}
                className={`p-1 hover:bg-white/10 rounded transition-colors cursor-pointer ${
                  showDiagnostics ? 'text-purple-400 bg-purple-500/20' : 'text-slate-400 hover:text-slate-200'
                }`}
                aria-label="Toggle streaming diagnostics"
                title="Toggle streaming diagnostics"
              >
                <Activity size={12} />
              </button>
            )}
            {!isOwner && (
              <div role="status" aria-label="Remote window read-only" title="Remote window read-only" style={{ color: '#64748b' }}>
                <Lock size={12} />
              </div>
            )}
            {isOwner && onToggleMaximize && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleMaximize(windowState.id);
                }}
                className="p-1 hover:bg-white/10 rounded transition-colors text-slate-300 hover:text-white cursor-pointer"
                aria-label={windowState.isMaximized ? 'Restore window' : 'Maximize window'}
                title={windowState.isMaximized ? 'Restore window' : 'Maximize window'}
              >
                {windowState.isMaximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
              </button>
            )}
          </div>
        </div>

        {/* Content body */}
        <div
          role="button"
          tabIndex={0}
          aria-label={`Window content for ${windowState.title}`}
          onClick={handleContainerClick}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              handleContainerClick();
            }
          }}
          onMouseEnter={() => {
            const enabled = focusFollowsCursor ?? cachedFocusFollowsCursorRef.current ?? false;
            if (enabled && onFocusClick) {
              onFocusClick(windowState.id);
            }
          }}
          onDragOver={(e) => {
            if (onFileDrop && e.dataTransfer.types.includes('Files')) {
              e.preventDefault();
              e.stopPropagation();
              setIsDragOverFile(true);
            }
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setIsDragOverFile(false);
          }}
          onDrop={(e) => {
            if (onFileDrop && e.dataTransfer.files.length > 0) {
              e.preventDefault();
              e.stopPropagation();
              setIsDragOverFile(false);
              const file = e.dataTransfer.files[0];
              onFileDrop(windowState.capturingDeviceId || windowState.owningDeviceId || '', file);
            }
          }}
          {...inputCaptureListeners}
          style={{
            flex: 1,
            position: 'relative',
            backgroundColor: 'rgba(15, 23, 42, 0.4)',
            overflow: 'hidden',
          }}
        >
          {/* File drag-and-drop overlay */}
          {isDragOverFile && (
            <div className="absolute inset-0 z-40 bg-purple-950/85 backdrop-blur-sm border-2 border-dashed border-purple-400 rounded-2xl flex flex-col items-center justify-center pointer-events-none p-4 text-center">
              <UploadCloud size={36} className="text-purple-300 animate-bounce mb-2" />
              <p className="text-xs font-bold text-white uppercase tracking-wider">Drop file to send</p>
              <p className="text-[10px] text-purple-300 mt-1">P2P encrypted transfer directly to device</p>
            </div>
          )}

          {/* WebRTC Diagnostics HUD */}
          {showDiagnostics && (
            <div className="absolute top-2 right-2 z-30 p-2 bg-slate-950/90 border border-slate-700/80 rounded-lg text-[10px] font-mono text-slate-300 pointer-events-none backdrop-blur shadow-lg flex flex-col gap-0.5 min-w-[130px]">
              <div className="flex items-center gap-1.5 font-bold text-purple-400 border-b border-slate-800 pb-1 mb-0.5">
                <Activity size={10} /> WebRTC Stats
              </div>
              <div className="flex justify-between gap-3">
                <span>FPS:</span>
                <span className="text-white font-semibold">{diagnostics ? Math.round(diagnostics.fps) : '...'}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span>RTT:</span>
                <span className={diagnostics && diagnostics.rtt < 40 ? 'text-emerald-400' : 'text-amber-400'}>
                  {diagnostics ? `${diagnostics.rtt} ms` : '...'}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span>Bitrate:</span>
                <span className="text-white">{diagnostics ? `${diagnostics.bitrate} kbps` : '...'}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span>Loss:</span>
                <span className={diagnostics && diagnostics.packetLoss > 2 ? 'text-rose-400' : 'text-emerald-400'}>
                  {diagnostics ? `${diagnostics.packetLoss}%` : '0%'}
                </span>
              </div>
            </div>
          )}

          {/* Hidden input to receive virtual keyboard focus on mobile PWAs */}
          <input
            ref={inputRef}
            type="text"
            aria-hidden="true"
            tabIndex={-1}
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              opacity: 0,
              width: '1px',
              height: '1px',
              pointerEvents: 'none',
              zIndex: -1,
            }}
            autoComplete="off"
            autoCapitalize="off"
          />

          {windowState.hasActiveCapture ? (
            stream ? (
              <>
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  aria-label={`Live screen feed from ${windowState.title}`}
                  muted={windowState.capturingDeviceId === localDeviceId || isMuted}
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'contain',
                    backgroundColor: '#020617',
                    pointerEvents: 'none', // Allow parent container to capture events
                  }}
                />
                {playBlocked && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      videoRef.current
                        ?.play()
                        .then(() => setPlayBlocked(false))
                        .catch(() => {});
                    }}
                    className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 text-white gap-2 cursor-pointer z-10"
                    aria-label="Click to start video stream"
                  >
                    <span className="px-4 py-2 bg-violet-600 hover:bg-violet-500 rounded-lg shadow-lg text-sm font-semibold flex items-center gap-2">
                      ▶ Click to view stream
                    </span>
                  </button>
                )}
              </>
            ) : (
              <div
                role="status"
                aria-live="polite"
                className="absolute inset-0 flex flex-col items-center justify-center text-center gap-3 bg-slate-950/70 p-4"
              >
                <div className="relative">
                  <div className="absolute -inset-1 rounded-full bg-violet-500/20 blur animate-pulse" />
                  <Tv size={28} className="text-violet-400 relative animate-pulse" />
                </div>
                <div>
                  <p className="text-sm font-medium text-slate-200">Connecting video stream...</p>
                  <p className="text-xs text-slate-500 mt-1">Establishing secure WebRTC transport</p>
                </div>
              </div>
            )
          ) : (
            <div
              style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '24px',
                color: '#94a3b8',
                fontSize: '12px',
                fontFamily: 'system-ui, sans-serif',
                textAlign: 'center',
                backgroundColor: '#020617',
                gap: '12px',
                userSelect: 'none',
              }}
            >
              <div className="relative opacity-60">
                <div className="absolute -inset-1 rounded-full bg-slate-500/10 blur" />
                <Tv size={28} className="text-slate-400 relative" />
              </div>
              <div style={{ maxWidth: '240px' }}>
                <p style={{ fontWeight: 600, color: '#f1f5f9', marginBottom: '4px' }}>Capture Inactive</p>
                <p style={{ fontSize: '10px', lineHeight: 1.4, color: '#64748b' }}>
                  No live OS window is streaming to this viewport. Select &apos;Share OS Window&apos; to broadcast a window here.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Resize handle (bottom-right corner) */}
        {isOwner && onResize && !windowState.isMaximized && (
          <div
            role="slider"
            aria-label="Resize window"
            tabIndex={-1}
            onPointerDown={(e) => {
              e.stopPropagation();
              const startX = e.clientX;
              const startY = e.clientY;
              const startW = windowState.width;
              const startH = windowState.height;

              const onPointerMove = (moveEvent: PointerEvent) => {
                const newW = Math.max(180, startW + (moveEvent.clientX - startX));
                const newH = Math.max(120, startH + (moveEvent.clientY - startY));
                onResize(windowState.id, newW, newH);
              };

              const onPointerUp = () => {
                window.removeEventListener('pointermove', onPointerMove);
                window.removeEventListener('pointerup', onPointerUp);
              };

              window.addEventListener('pointermove', onPointerMove);
              window.addEventListener('pointerup', onPointerUp);
            }}
            style={{
              position: 'absolute',
              right: 2,
              bottom: 2,
              width: 16,
              height: 16,
              cursor: 'nwse-resize',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 30,
              touchAction: 'none',
            }}
          >
            <div style={{ width: 6, height: 6, borderRight: '2px solid rgba(255,255,255,0.4)', borderBottom: '2px solid rgba(255,255,255,0.4)' }} />
          </div>
        )}
      </div>
    </motion.div>
  );
};

export const RemoteWindowRenderer = React.memo(RemoteWindowRendererComponent);

