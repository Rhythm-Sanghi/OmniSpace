import React, { useState, useRef, useEffect } from 'react';
import QRCode from 'qrcode';
import { Camera, ShieldAlert, Send, Copy, Check, Tv, Smartphone } from 'lucide-react';

interface PairingScreenProps {
  onPair: (pin: string, role?: 'host' | 'join') => void;
  errorMessage: string | null;
  deviceId: string;
  isConnecting?: boolean;
}

export const PairingScreen: React.FC<PairingScreenProps> = ({
  onPair,
  errorMessage,
  deviceId,
  isConnecting = false,
}) => {
  // Mode selection: 'host' (generate code to pair) vs 'join' (type code or scan QR)
  const [mode, setMode] = useState<'host' | 'join'>(() => {
    if (typeof window !== 'undefined' && window.location.search.includes('pin=')) {
      return 'join';
    }
    if (typeof window !== 'undefined' && window.innerWidth >= 768) {
      return 'host';
    }
    return 'join';
  });

  const [hostPin] = useState(() => Math.floor(100000 + Math.random() * 900000).toString());
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [pin, setPin] = useState('');
  const [scanning, setScanning] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  const scanningRef = useRef(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const jsQrModuleRef = useRef<any>(null);

  // Generate QR Code for Host Mode
  useEffect(() => {
    let active = true;
    const url = `https://omnispace.pages.dev/?pin=${hostPin}`;
    QRCode.toDataURL(url, {
      width: 220,
      margin: 2,
      color: {
        dark: '#ffffff',
        light: '#090d16',
      },
      errorCorrectionLevel: 'M',
    })
      .then((dataUrl) => {
        if (active) setQrDataUrl(dataUrl);
      })
      .catch((err) => {
        console.error('Failed to generate QR code:', err);
      });

    return () => {
      active = false;
    };
  }, [hostPin]);

  const handleCopyLink = () => {
    const url = `https://omnispace.pages.dev/?pin=${hostPin}`;
    navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };

  const startScanner = async () => {
    setCameraError(null);
    scanningRef.current = true;
    setScanning(true);
    try {
      if (!jsQrModuleRef.current) {
        const mod = await import('jsqr');
        jsQrModuleRef.current = (mod as any).default || mod;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.setAttribute('playsinline', 'true'); // Required for iOS
        videoRef.current.play().catch(() => {});
        animationFrameRef.current = requestAnimationFrame(scanFrame);
      }
    } catch (err: unknown) {
      console.error('Camera access error:', err);
      setCameraError('Could not access back camera. Enter PIN manually.');
      stopScanner();
    }
  };

  const stopScanner = () => {
    scanningRef.current = false;
    setScanning(false);
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  };

  const scanFrame = () => {
    if (!scanningRef.current || !videoRef.current || !canvasRef.current || !jsQrModuleRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');

    if (
      video.readyState === video.HAVE_ENOUGH_DATA &&
      video.videoWidth > 0 &&
      video.videoHeight > 0 &&
      ctx
    ) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const jsQRFunc = jsQrModuleRef.current;
      const code = jsQRFunc(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: 'dontInvert',
      });

      if (code && code.data) {
        let detectedPin = code.data.trim();
        const match = detectedPin.match(/pin=(\d{6})/);
        if (match) {
          detectedPin = match[1];
        }

        if (/^\d{6}$/.test(detectedPin)) {
          stopScanner();
          onPair(detectedPin, 'join');
          return;
        }
      }
    }

    if (scanningRef.current) {
      animationFrameRef.current = requestAnimationFrame(scanFrame);
    }
  };

  useEffect(() => {
    return () => {
      stopScanner();
    };
  }, []);

  const handleManualPair = (e: React.FormEvent) => {
    e.preventDefault();
    if (/^\d{6}$/.test(pin)) {
      onPair(pin, 'join');
    }
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-6 bg-slate-950 text-slate-100 min-h-screen">
      {/* Title */}
      <div className="flex flex-col items-center gap-2 mb-6 text-center">
        <div className="text-4xl">{mode === 'host' ? '🌌' : '📱'}</div>
        <h1 className="text-2xl font-bold tracking-wide mt-1">
          {mode === 'host' ? 'Host Web Workspace' : 'Pair Companion Device'}
        </h1>
        <p className="text-xs text-slate-400 max-w-sm leading-relaxed">
          {mode === 'host'
            ? 'Generate a room code on this browser. Connect your phone or another laptop to share screens and input.'
            : 'Enter a room PIN or scan the QR code displayed on your host laptop to connect.'}
        </p>
      </div>

      {/* Mode Switcher Tabs */}
      <div className="w-full max-w-sm flex bg-slate-900/90 p-1 rounded-xl border border-slate-800 mb-5 shadow-lg">
        <button
          type="button"
          onClick={() => {
            setMode('host');
            stopScanner();
          }}
          className={`flex-1 py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition ${
            mode === 'host'
              ? 'bg-purple-600 text-white shadow-md shadow-purple-600/30'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Tv size={13} />
          <span>Host Workspace</span>
        </button>

        <button
          type="button"
          onClick={() => setMode('join')}
          className={`flex-1 py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition ${
            mode === 'join'
              ? 'bg-purple-600 text-white shadow-md shadow-purple-600/30'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Smartphone size={13} />
          <span>Join Companion</span>
        </button>
      </div>

      {/* Main Container Card */}
      <div className="w-full max-w-sm glass-panel p-6 rounded-2xl flex flex-col gap-5 relative overflow-hidden border border-slate-800 shadow-2xl">
        {mode === 'host' ? (
          /* Host Mode View: Display Generated PIN & QR Code */
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="w-full flex flex-col items-center gap-1 p-3.5 bg-purple-500/10 border border-purple-500/20 rounded-xl">
              <span className="text-[10px] uppercase tracking-wider text-purple-400 font-bold">
                Your Room Pairing Code
              </span>
              <span className="text-3xl font-bold tracking-widest text-purple-300 font-mono">
                {hostPin}
              </span>
            </div>

            {/* QR Code Canvas */}
            <div className="flex flex-col items-center gap-2">
              <div className="p-2.5 bg-slate-900 border border-purple-500/30 rounded-xl shadow-lg shadow-purple-500/10">
                {qrDataUrl ? (
                  <img
                    src={qrDataUrl}
                    alt={`Pairing QR Code for Room ${hostPin}`}
                    className="w-40 h-40 rounded-lg object-contain"
                  />
                ) : (
                  <div className="w-40 h-40 flex items-center justify-center text-xs text-slate-500">
                    Generating QR code...
                  </div>
                )}
              </div>
              <p className="text-[11px] text-slate-400 max-w-[260px] leading-tight">
                Scan with your phone camera or enter PIN <span className="font-mono text-purple-300 font-semibold">{hostPin}</span> on another browser
              </p>
            </div>

            <div className="w-full flex gap-2 pt-1">
              <button
                type="button"
                onClick={handleCopyLink}
                className="flex-1 py-2.5 px-3 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-300 hover:text-white text-xs font-medium flex items-center justify-center gap-1.5 transition"
              >
                {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                <span>{copied ? 'Link Copied!' : 'Copy Link'}</span>
              </button>

              <button
                type="button"
                disabled={isConnecting}
                onClick={() => onPair(hostPin, 'host')}
                className="flex-1 py-2.5 px-3 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white text-xs font-semibold flex items-center justify-center gap-1.5 transition shadow-lg shadow-purple-600/30"
              >
                {isConnecting ? (
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  <>
                    <Tv size={14} />
                    <span>Start Room</span>
                  </>
                )}
              </button>
            </div>
          </div>
        ) : scanning ? (
          /* Scanner Screen View */
          <div className="flex flex-col gap-4">
            <div className="relative aspect-square w-full bg-slate-900 rounded-xl overflow-hidden border border-purple-500/20">
              <video
                ref={videoRef}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
              <canvas ref={canvasRef} style={{ display: 'none' }} />

              {/* Scanning crosshairs overlay */}
              <div className="absolute inset-8 border border-purple-500/30 rounded-lg pointer-events-none">
                <div className="w-full h-[2px] bg-purple-500 absolute top-0 animate-bounce shadow-[0_0_8px_#a855f7]" style={{ animationDuration: '3s' }} />
                <div className="absolute top-0 left-0 w-4 h-4 border-t-2 border-l-2 border-purple-400" />
                <div className="absolute top-0 right-0 w-4 h-4 border-t-2 border-r-2 border-purple-400" />
                <div className="absolute bottom-0 left-0 w-4 h-4 border-b-2 border-l-2 border-purple-400" />
                <div className="absolute bottom-0 right-0 w-4 h-4 border-b-2 border-r-2 border-purple-400" />
              </div>

              <div className="absolute bottom-3 inset-x-0 text-center text-[10px] text-purple-300 font-semibold tracking-wider uppercase">
                Align QR Code inside bounds
              </div>
            </div>

            <button
              onClick={stopScanner}
              className="bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs py-2 rounded-lg transition"
            >
              Cancel Scanner
            </button>
          </div>
        ) : (
          /* Manual PIN Entry Form */
          <form onSubmit={handleManualPair} className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <label htmlFor="pin-input" className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">
                Enter Room PIN
              </label>
              <div className="flex gap-2">
                <input
                  id="pin-input"
                  type="text"
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="e.g. 123456"
                  className="flex-1 bg-slate-900 border border-slate-800 focus:border-purple-500 outline-none px-3 py-2 rounded-lg text-slate-200 font-mono text-center tracking-widest text-sm"
                />
                <button
                  type="submit"
                  disabled={pin.length !== 6 || isConnecting}
                  className="bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-slate-100 px-4 rounded-lg flex items-center justify-center transition min-w-[48px]"
                >
                  {isConnecting ? (
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  ) : (
                    <Send size={15} />
                  )}
                </button>
              </div>
            </div>

            <div className="flex items-center justify-center gap-2">
              <div className="h-[1px] bg-slate-800 flex-1" />
              <span className="text-[10px] text-slate-500 font-bold uppercase">or</span>
              <div className="h-[1px] bg-slate-800 flex-1" />
            </div>

            <button
              type="button"
              disabled={isConnecting}
              onClick={startScanner}
              className="bg-slate-900 hover:bg-slate-800 disabled:opacity-50 border border-slate-800 text-slate-200 py-2.5 rounded-lg flex items-center justify-center gap-2 text-xs font-semibold transition"
            >
              <Camera size={14} className="text-purple-500" />
              Scan QR Code
            </button>
          </form>
        )}

        {isConnecting && (
          <div className="flex items-center justify-center gap-2 text-xs text-purple-300 bg-purple-500/10 border border-purple-500/20 p-2.5 rounded-lg">
            <div className="w-3.5 h-3.5 border-2 border-purple-400/30 border-t-purple-400 rounded-full animate-spin shrink-0" />
            <span>Connecting to Workspace {pin || (mode === 'host' ? hostPin : '') ? `Room ${pin || hostPin}` : ''}...</span>
          </div>
        )}

        {cameraError && (
          <div className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 p-2.5 rounded-lg">
            {cameraError}
          </div>
        )}

        {errorMessage && (
          <div className="flex items-center gap-2 text-rose-400 text-xs bg-rose-500/10 border border-rose-500/20 p-2.5 rounded-lg">
            <ShieldAlert size={14} className="shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}
      </div>

      <div className="mt-8 text-[11px] text-slate-600 font-mono text-center leading-relaxed">
        Device Identity: <span className="text-slate-500">{deviceId.substring(0, 16)}</span>
      </div>
    </div>
  );
};
