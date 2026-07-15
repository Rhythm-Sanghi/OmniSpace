import { useState, useEffect } from 'react';
import { Monitor, ScreenShare, X, ChevronRight, RefreshCw } from 'lucide-react';
import { NativeWindowInfo } from 'core';

interface WindowCapturePromptProps {
  onCaptureSelected: (hwndHandle: number | null, windowTitle: string) => void;
  onClose: () => void;
}

export function WindowCapturePrompt({ onCaptureSelected, onClose }: WindowCapturePromptProps) {
  const [windows, setWindows] = useState<NativeWindowInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [isTauri, setIsTauri] = useState(false);

  useEffect(() => {
    const tauriCheck = typeof window !== 'undefined' && !!(window as any).__TAURI_METADATA__;
    setIsTauri(tauriCheck);
    if (tauriCheck) {
      fetchWindows();
    }
  }, []);

  const fetchWindows = async () => {
    setLoading(true);
    try {
      const { invoke } = await import('@tauri-apps/api/tauri');
      const list = await invoke<any[]>('enumerate_windows');
      setWindows(
        list.map((w: any) => ({
          handle: w.handle,
          title: w.title,
          x: 0,
          y: 0,
          width: 0,
          height: 0,
        }))
      );
    } catch (err) {
      console.error('Failed to enumerate native windows:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleBrowserDirectShare = () => {
    onCaptureSelected(null, 'Shared Browser Window');
  };

  const handleNativeShare = (win: NativeWindowInfo) => {
    onCaptureSelected(win.handle, win.title);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-white/10 bg-slate-900/90 text-white shadow-2xl backdrop-blur-xl transition-all duration-300">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/5 px-5 py-4">
          <div className="flex items-center gap-2">
            <ScreenShare className="text-indigo-400" size={20} />
            <h3 className="text-lg font-semibold tracking-wide">Share Application Window</h3>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-slate-400 hover:bg-white/5 hover:text-white transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="p-5">
          {isTauri ? (
            <div>
              <div className="mb-3 flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  Select a window to track coordinates
                </span>
                <button
                  onClick={fetchWindows}
                  disabled={loading}
                  className="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
                >
                  <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
                  Refresh
                </button>
              </div>

              {loading ? (
                <div className="flex h-40 items-center justify-center">
                  <div className="h-6 w-6 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
                </div>
              ) : windows.length === 0 ? (
                <div className="flex h-32 flex-col items-center justify-center text-center">
                  <Monitor size={28} className="text-slate-600 mb-2" />
                  <p className="text-sm text-slate-400">No shareable windows detected.</p>
                </div>
              ) : (
                <div className="max-h-60 overflow-y-auto space-y-1.5 pr-1 custom-scrollbar">
                  {windows.map((win) => (
                    <button
                      key={win.handle}
                      onClick={() => handleNativeShare(win)}
                      className="group flex w-full items-center justify-between rounded-xl border border-white/5 bg-white/[0.02] px-4 py-3 text-left hover:border-indigo-500/30 hover:bg-indigo-500/[0.04] transition-all"
                    >
                      <div className="flex items-center gap-3 overflow-hidden">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-400">
                          <Monitor size={16} />
                        </div>
                        <span className="truncate text-sm font-medium group-hover:text-indigo-200 transition-colors">
                          {win.title}
                        </span>
                      </div>
                      <ChevronRight size={14} className="text-slate-500 group-hover:text-indigo-400 transition-colors" />
                    </button>
                  ))}
                </div>
              )}

              <div className="mt-4 pt-4 border-t border-white/5">
                <button
                  onClick={handleBrowserDirectShare}
                  className="w-full rounded-xl bg-white/5 py-2.5 text-center text-xs font-semibold text-slate-300 hover:bg-white/10 hover:text-white transition-all"
                >
                  Bypass Track Selection & Share Direct
                </button>
              </div>
            </div>
          ) : (
            <div className="text-center py-6">
              <Monitor size={48} className="mx-auto text-indigo-400/20 mb-4 animate-pulse" />
              <p className="text-sm text-slate-300 mb-6 px-4">
                You are running Omni-Space in a standard web browser. Start window capture directly via browser media options.
              </p>
              <button
                onClick={handleBrowserDirectShare}
                className="w-full rounded-xl bg-indigo-600 py-3 font-semibold text-white hover:bg-indigo-500 shadow-lg shadow-indigo-600/20 active:scale-[0.98] transition-all"
              >
                Choose Window to Share
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
