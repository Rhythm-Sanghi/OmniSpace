import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { UploadCloud, DownloadCloud, X } from 'lucide-react';
import { TransferProgress } from 'core';

export interface InFlightTransferState extends TransferProgress {
  type: 'upload' | 'download';
}

interface FileTransferHUDProps {
  transfer: InFlightTransferState | null;
  onCancel?: (transferId: string) => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const FileTransferHUD: React.FC<FileTransferHUDProps> = ({
  transfer,
  onCancel,
}) => {
  return (
    <AnimatePresence>
      {transfer && (
        <motion.div
          initial={{ opacity: 0, y: 30, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 20, scale: 0.95 }}
          transition={{ type: 'spring', stiffness: 400, damping: 30 }}
          role="status"
          aria-live="polite"
          aria-label={`File transfer in progress: ${transfer.fileName}`}
          className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 p-3.5 bg-slate-900/95 backdrop-blur-md border border-purple-500/40 rounded-2xl shadow-2xl shadow-purple-950/50 w-80 text-white select-none pointer-events-auto"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-purple-600/20 border border-purple-500/40 flex items-center justify-center text-purple-400 shrink-0">
                {transfer.type === 'upload' ? (
                  <UploadCloud size={18} className="animate-pulse" />
                ) : (
                  <DownloadCloud size={18} className="animate-pulse" />
                )}
              </div>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-slate-200 truncate">
                  {transfer.fileName}
                </p>
                <p className="text-[10px] text-slate-400">
                  {transfer.type === 'upload' ? 'Sending...' : 'Receiving...'}{' '}
                  {formatBytes(transfer.bytesTransferred)} / {formatBytes(transfer.totalBytes)}
                </p>
              </div>
            </div>

            {onCancel && (
              <button
                type="button"
                onClick={() => onCancel(transfer.transferId)}
                className="p-1 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white transition"
                title="Cancel transfer"
                aria-label="Cancel file transfer"
              >
                <X size={16} />
              </button>
            )}
          </div>

          {/* Progress Bar */}
          <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden mt-1">
            <div
              className="bg-gradient-to-r from-purple-500 to-indigo-500 h-full rounded-full transition-all duration-150"
              style={{ width: `${transfer.percentage}%` }}
            />
          </div>

          <div className="flex justify-between items-center text-[9px] font-mono text-purple-300/80">
            <span>{transfer.type === 'upload' ? 'P2P WebRTC Push' : 'P2P WebRTC Stream'}</span>
            <span>{transfer.percentage}%</span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
