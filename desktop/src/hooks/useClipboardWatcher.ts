import { useEffect } from 'react';
import * as Y from 'yjs';
import { OmniClipboardSync } from 'core';

export function useClipboardWatcher(
  localDeviceId: string,
  doc: Y.Doc | null,
  connected: boolean
) {
  useEffect(() => {
    const isTauri = typeof window !== 'undefined' && !!(window as any).__TAURI_METADATA__;
    if (!doc || !connected || !isTauri) return;

    const readLocalClipboard = async () => {
      const { invoke } = await import('@tauri-apps/api/tauri');
      return await invoke<string>('get_clipboard');
    };

    const writeLocalClipboard = async (text: string) => {
      const { invoke } = await import('@tauri-apps/api/tauri');
      await invoke('set_clipboard', { text });
    };

    const sync = new OmniClipboardSync(
      localDeviceId,
      doc,
      readLocalClipboard,
      writeLocalClipboard
    );
    sync.initialize();

    return () => {
      sync.destroy();
    };
  }, [localDeviceId, doc, connected]);
}
