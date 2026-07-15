import React, { useRef, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Tv, Lock, Keyboard } from 'lucide-react';
import { Device, WindowInstance } from 'core';

interface RemoteWindowRendererProps {
  localDeviceId: string;
  localDevice: Device;
  windowState: WindowInstance;
  stream: MediaStream | null;
  focusedWindowId?: string | null;
  onDragStart?: (windowId: string, event: any) => void;
  onDrag?: (windowId: string, event: any, info: any) => void;
  onDragEnd?: (windowId: string, event: any, info: any) => void;
  inputCaptureListeners?: any;
  onFocusClick?: (windowId: string) => void;
}

export const RemoteWindowRenderer: React.FC<RemoteWindowRendererProps> = ({
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
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  
  const isOwner = windowState.owningDeviceId === localDeviceId;
  const isFocused = focusedWindowId === windowState.id;

  // Bind video stream to source element
  useEffect(() => {
    if (videoRef.current) {
      if (stream) {
        videoRef.current.srcObject = stream;
        videoRef.current.play().catch((err) => {
          console.warn('Auto-play blocked or failed for remote window video track:', err);
        });
      } else {
        videoRef.current.srcObject = null;
      }
    }
  }, [stream]);

  // Check if window overlaps with local display bounds
  const overlapsDevice =
    windowState.x + windowState.width > localDevice.x &&
    windowState.x < localDevice.x + localDevice.width &&
    windowState.y + windowState.height > localDevice.y &&
    windowState.y < localDevice.y + localDevice.height;

  // Render nothing if it is not owned and doesn't overlap
  if (!isOwner && !overlapsDevice) {
    return null;
  }

  // Project global coordinates to local CSS viewport pixels
  const lx = windowState.x - localDevice.x;
  const ly = windowState.y - localDevice.y;

  const handleContainerClick = () => {
    if (onFocusClick) {
      onFocusClick(windowState.id);
    }
    // Pull up mobile virtual keyboard
    if (inputRef.current) {
      inputRef.current.focus();
    }
  };

  return (
    <motion.div
      ref={containerRef}
      drag={isOwner && !!onDragStart}
      dragMomentum={false}
      dragElastic={0}
      onDragStart={(e) => onDragStart && onDragStart(windowState.id, e)}
      onDrag={(e, info) => onDrag && onDrag(windowState.id, e, info)}
      onDragEnd={(e, info) => onDragEnd && onDragEnd(windowState.id, e, info)}
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
      transition={{ type: 'spring', stiffness: 300, damping: 25 }}
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
          <div style={{ display: 'flex', gap: '6px', marginRight: '16px' }}>
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
              <div style={{ color: '#a855f7', display: 'flex', alignItems: 'center', gap: '4px' }}>
                <Keyboard size={12} className="animate-pulse" />
              </div>
            )}
            {windowState.hasActiveCapture && (
              <div
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
            {!isOwner && (
              <div style={{ color: '#64748b' }}>
                <Lock size={12} />
              </div>
            )}
          </div>
        </div>

        {/* Content body */}
        <div
          onClick={handleContainerClick}
          onMouseEnter={() => {
            const settings = localStorage.getItem('omni-settings-focus-follows-cursor');
            if (settings === 'true' && onFocusClick) {
              onFocusClick(windowState.id);
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
          {/* Hidden input to receive virtual keyboard focus on mobile PWAs */}
          <input
            ref={inputRef}
            type="text"
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
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted={windowState.capturingDeviceId === localDeviceId} // Mute local captures to avoid echo loops
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'contain',
                  backgroundColor: '#020617',
                  pointerEvents: 'none', // Allow parent container to capture events
                }}
              />
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center gap-3 bg-slate-950/70 p-4">
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
      </div>
    </motion.div>
  );
};
