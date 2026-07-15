import React, { useState, useRef, useEffect } from 'react';
import jsQR from 'jsqr';
import { Camera, ShieldAlert, Send } from 'lucide-react';

interface PairingScreenProps {
  onPair: (pin: string) => void;
  errorMessage: string | null;
  deviceId: string;
}

export const PairingScreen: React.FC<PairingScreenProps> = ({
  onPair,
  errorMessage,
  deviceId,
}) => {
  const [pin, setPin] = useState('');
  const [scanning, setScanning] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  const startScanner = async () => {
    setCameraError(null);
    setScanning(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.setAttribute('playsinline', 'true'); // Required for iOS
        videoRef.current.play();
        animationFrameRef.current = requestAnimationFrame(scanFrame);
      }
    } catch (err: any) {
      console.error('Camera access error:', err);
      setCameraError('Could not access back camera. Enter PIN manually.');
      setScanning(false);
    }
  };

  const stopScanner = () => {
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
    if (!scanning || !videoRef.current || !canvasRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');

    if (video.readyState === video.HAVE_ENOUGH_DATA && ctx) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const jsQRFunc = (jsQR as any).default || jsQR;
      const code = jsQRFunc(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: 'dontInvert',
      });

      if (code && code.data) {
        // Assume code data is just the room PIN or an omni-space url containing pin query
        let detectedPin = code.data.trim();
        
        // Extract 6-digit pin if url format
        const match = detectedPin.match(/pin=(\d{6})/);
        if (match) {
          detectedPin = match[1];
        }

        if (/^\d{6}$/.test(detectedPin)) {
          stopScanner();
          onPair(detectedPin);
          return;
        }
      }
    }

    if (scanning) {
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
      onPair(pin);
    }
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-6 bg-slate-950 text-slate-100 min-h-screen">
      {/* Title */}
      <div className="flex flex-col items-center gap-2 mb-8 text-center">
        <div className="text-4xl">📱</div>
        <h1 className="text-2xl font-bold tracking-wide mt-2">Pair Companion Device</h1>
        <p className="text-xs text-slate-400 max-w-xs leading-relaxed">
          Link your mobile browser to the desktop workspace. Drag items across screens seamlessly.
        </p>
      </div>

      <div className="w-full max-w-sm glass-panel p-6 rounded-2xl flex flex-col gap-6 relative overflow-hidden">
        {scanning ? (
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
                {/* Laser scanline animation */}
                <div className="w-full h-[2px] bg-purple-500 absolute top-0 animate-bounce shadow-[0_0_8px_#a855f7]" style={{ animationDuration: '3s' }} />
                
                {/* Corners */}
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
              <label className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">
                Enter Room PIN
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="e.g. 123456"
                  className="flex-1 bg-slate-900 border border-slate-800 focus:border-purple-500 outline-none px-3 py-2 rounded-lg text-slate-200 font-mono text-center tracking-widest text-sm"
                />
                <button
                  type="submit"
                  disabled={pin.length !== 6}
                  className="bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-slate-100 px-4 rounded-lg flex items-center justify-center transition"
                >
                  <Send size={15} />
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
              onClick={startScanner}
              className="bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-200 py-2.5 rounded-lg flex items-center justify-center gap-2 text-xs font-semibold transition"
            >
              <Camera size={14} className="text-purple-500" />
              Scan QR Code
            </button>
          </form>
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
