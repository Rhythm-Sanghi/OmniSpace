import { useEffect, useRef } from 'react';
import * as Y from 'yjs';
import { OmniClipboardSync, ClipboardHistoryItem } from 'core';

/**
 * Manages clipboard synchronization for web browsers / mobile PWAs.
 * Respects browser security restrictions:
 * - Reads via navigator.clipboard.readText() only when window has focus
 * - Writes via navigator.clipboard.writeText() on incoming remote updates
 * - Handles denied or unavailable permissions gracefully without polling spam
 * - Prevents infinite echo loops via OmniClipboardSync
 */
export function useMobileClipboardSync(
  localDeviceId: string,
  doc: Y.Doc | null,
  connected: boolean,
  onHistoryChanged?: (history: ClipboardHistoryItem[]) => void
) {
  const syncRef = useRef<OmniClipboardSync | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof navigator === 'undefined' || !navigator.clipboard) {
      return;
    }

    if (!doc || !connected) {
      if (syncRef.current) {
        syncRef.current.destroy();
        syncRef.current = null;
      }
      return;
    }

    const readLocalClipboard = async (): Promise<string> => {
      // In browsers, reading clipboard requires active user interaction and window focus
      if (typeof document !== 'undefined' && !document.hasFocus()) {
        return '';
      }
      try {
        const text = await navigator.clipboard.readText();
        return text || '';
      } catch {
        // Permission denied or not active tab - fail silently
        return '';
      }
    };

    const writeLocalClipboard = async (text: string): Promise<void> => {
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
      } catch (err) {
        // Browser rejected background write - ignore gracefully
        console.debug('[MobileClipboard] Write skipped due to browser security policy:', err);
      }
    };

    const sync = new OmniClipboardSync(
      localDeviceId,
      doc,
      readLocalClipboard,
      writeLocalClipboard
    );
    if (onHistoryChanged) {
      sync.onHistoryChanged = onHistoryChanged;
    }
    sync.initialize();
    syncRef.current = sync;

    return () => {
      sync.destroy();
      syncRef.current = null;
    };
  }, [localDeviceId, doc, connected, onHistoryChanged]);
}
