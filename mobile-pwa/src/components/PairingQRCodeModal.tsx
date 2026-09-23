import React, { useState, useEffect } from 'react';
import QRCode from 'qrcode';
import { QrCode, X, Copy, Check, Smartphone } from 'lucide-react';

interface PairingQRCodeModalProps {
  isOpen: boolean;
  onClose: () => void;
  roomPin: string;
}

export const PairingQRCodeModal: React.FC<PairingQRCodeModalProps> = ({
  isOpen,
  onClose,
  roomPin,
}) => {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Companion URL (Cloudflare Pages web app with auto-pairing pin query param)
  const companionUrl = `https://omnispace.pages.dev/?pin=${roomPin}`;

  useEffect(() => {
    if (!isOpen || !roomPin) return;

    QRCode.toDataURL(companionUrl, {
      width: 256,
      margin: 2,
      color: {
        dark: '#0f172a',
        light: '#ffffff',
      },
      errorCorrectionLevel: 'M',
    })
      .then((url) => setQrDataUrl(url))
      .catch((err) => console.error('Failed to generate pairing QR code:', err));
  }, [isOpen, roomPin, companionUrl]);

  if (!isOpen) return null;

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(companionUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 select-none">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-sm overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 duration-200">
        {/* Modal Header */}
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-purple-500/10 text-purple-400">
              <QrCode size={18} />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-slate-100">Pair Companion Device</h3>
              <p className="text-[11px] text-slate-400">Scan to link mobile phone or tablet</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition"
            aria-label="Close QR Modal"
          >
            <X size={16} />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 flex flex-col items-center gap-4 text-center">
          {/* QR Code Frame */}
          <div className="p-3 bg-white rounded-2xl shadow-lg border-2 border-purple-500/30 flex items-center justify-center">
            {qrDataUrl ? (
              <img
                src={qrDataUrl}
                alt={`QR code for Room PIN ${roomPin}`}
                className="w-48 h-48 rounded-lg"
              />
            ) : (
              <div className="w-48 h-48 flex items-center justify-center text-slate-400 text-xs">
                Generating QR Code...
              </div>
            )}
          </div>

          {/* Room PIN Highlight */}
          <div className="flex flex-col items-center gap-1 w-full bg-slate-950/60 border border-slate-800 p-3 rounded-xl">
            <span className="text-[10px] uppercase font-bold tracking-widest text-slate-400">
              Room PIN Code
            </span>
            <span className="text-2xl font-mono font-bold tracking-widest text-purple-300">
              {roomPin}
            </span>
          </div>

          <p className="text-xs text-slate-400 leading-relaxed max-w-xs">
            Scan this code with your phone camera or the built-in companion scanner to connect instantly.
          </p>

          {/* Quick Actions */}
          <div className="flex items-center gap-2 w-full pt-1">
            <button
              onClick={handleCopyLink}
              className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium py-2 px-3 rounded-lg border border-slate-700 flex items-center justify-center gap-1.5 transition"
            >
              {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
              <span>{copied ? 'Link Copied!' : 'Copy Link'}</span>
            </button>
            <a
              href={companionUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold py-2 px-3 rounded-lg flex items-center justify-center gap-1.5 transition shadow-md shadow-purple-600/20"
            >
              <Smartphone size={14} />
              <span>Open Web</span>
            </a>
          </div>
        </div>
      </div>
    </div>
  );
};
