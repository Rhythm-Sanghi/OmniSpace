import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Clipboard, Copy, Check, X, Image as ImageIcon, FileText } from 'lucide-react';
import { ClipboardHistoryItem } from 'core';

export interface ClipboardHistoryDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  history: ClipboardHistoryItem[];
  onSelect: (item: ClipboardHistoryItem) => void;
}

export const ClipboardHistoryDrawer: React.FC<ClipboardHistoryDrawerProps> = ({
  isOpen,
  onClose,
  history,
  onSelect,
}) => {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopy = (item: ClipboardHistoryItem) => {
    onSelect(item);
    setCopiedId(item.id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 pointer-events-auto"
          />

          {/* Drawer panel */}
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 28, stiffness: 300 }}
            className="fixed top-0 right-0 bottom-0 w-80 max-w-[85vw] bg-slate-900 border-l border-slate-800 shadow-2xl z-50 flex flex-col pointer-events-auto text-slate-200"
          >
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-slate-800 bg-slate-950/40">
              <div className="flex items-center gap-2">
                <Clipboard size={18} className="text-purple-400" />
                <h3 className="text-sm font-semibold">Clipboard History</h3>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="p-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition"
                aria-label="Close clipboard history"
              >
                <X size={16} />
              </button>
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2">
              {history.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-48 text-center text-slate-500 text-xs">
                  <Clipboard size={24} className="opacity-40 mb-2" />
                  <p>No clipboard entries yet</p>
                  <p className="text-[10px] mt-1 text-slate-600">Copied text and images across devices will appear here</p>
                </div>
              ) : (
                history.map((item) => {
                  const isCopied = copiedId === item.id;
                  const isImage = item.type === 'image';

                  return (
                    <div
                      key={item.id}
                      className="flex flex-col gap-1.5 p-3 rounded-xl bg-slate-800/60 hover:bg-slate-800 border border-slate-700/60 transition group"
                    >
                      <div className="flex items-center justify-between text-[10px] text-slate-400">
                        <div className="flex items-center gap-1.5 font-medium">
                          {isImage ? (
                            <ImageIcon size={12} className="text-purple-400" />
                          ) : (
                            <FileText size={12} className="text-indigo-400" />
                          )}
                          <span className="truncate max-w-[120px]">
                            {item.sourceDeviceId ? `Device ${item.sourceDeviceId.slice(0, 6)}` : 'Local'}
                          </span>
                        </div>
                        <span className="font-mono text-slate-500">
                          {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>

                      {/* Content preview */}
                      {isImage ? (
                        <div className="rounded-lg overflow-hidden border border-slate-700 max-h-28 bg-slate-950 flex items-center justify-center">
                          <img
                            src={item.content}
                            alt="Clipboard image preview"
                            className="object-contain max-h-28 w-full"
                          />
                        </div>
                      ) : (
                        <p className="text-xs font-mono text-slate-300 line-clamp-3 break-all bg-slate-950/60 p-2 rounded-lg border border-slate-800/80">
                          {item.content}
                        </p>
                      )}

                      <button
                        type="button"
                        onClick={() => handleCopy(item)}
                        className={`mt-1 py-1 px-2.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition ${
                          isCopied
                            ? 'bg-emerald-600 text-white shadow-md shadow-emerald-600/20'
                            : 'bg-purple-600/30 hover:bg-purple-600 border border-purple-500/40 text-purple-200 hover:text-white'
                        }`}
                      >
                        {isCopied ? (
                          <>
                            <Check size={12} />
                            <span>Copied!</span>
                          </>
                        ) : (
                          <>
                            <Copy size={12} />
                            <span>Copy to Local</span>
                          </>
                        )}
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
};
