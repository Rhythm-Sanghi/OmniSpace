import { useEffect } from 'react';
import * as Y from 'yjs';
import { WindowInstance } from 'core';

export function useNativeWindowTracking(
  localDeviceId: string,
  windowsMap: Y.Map<WindowInstance>,
  localWindowHandles: Map<string, number>
) {
  useEffect(() => {
    const isTauri = typeof window !== 'undefined' && !!(window as any).__TAURI_METADATA__;
    if (!isTauri) return;

    let unsubscribeBounds: (() => void) | null = null;
    let unsubscribeClosed: (() => void) | null = null;

    // Dynamically import Tauri event APIs to support browser-only contexts
    const initTauriListeners = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');

        // Listen for move/resize bounds updates from Rust poll loop
        unsubscribeBounds = await listen(
          'native-window-bounds',
          (event: any) => {
            const { handle, x, y, width, height } = event.payload;

            // Find matching window ID in our local registry
            let matchedWindowId: string | null = null;
            for (const [winId, hwnd] of localWindowHandles.entries()) {
              if (hwnd === handle) {
                matchedWindowId = winId;
                break;
              }
            }

            if (matchedWindowId) {
              const match = windowsMap.get(matchedWindowId);
              if (match && match.capturingDeviceId === localDeviceId) {
                windowsMap.doc?.transact(() => {
                  windowsMap.set(match.id, {
                    ...match,
                    x,
                    y,
                    width,
                    height,
                  });
                }, 'native-tracking-update');
              }
            }
          }
        );

        // Listen for window closures
        unsubscribeClosed = await listen('native-window-closed', (event: any) => {
          const handle = event.payload;

          let matchedWindowId: string | null = null;
          for (const [winId, hwnd] of localWindowHandles.entries()) {
            if (hwnd === handle) {
              matchedWindowId = winId;
              break;
            }
          }

          if (matchedWindowId) {
            const match = windowsMap.get(matchedWindowId);
            if (match && match.capturingDeviceId === localDeviceId) {
              windowsMap.doc?.transact(() => {
                windowsMap.delete(match.id);
              }, 'native-tracking-close');
              localWindowHandles.delete(matchedWindowId);
            }
          }
        });
      } catch (err) {
        console.error('Failed to initialize Tauri native window tracking listeners:', err);
      }
    };

    initTauriListeners();

    return () => {
      if (unsubscribeBounds) unsubscribeBounds();
      if (unsubscribeClosed) unsubscribeClosed();
    };
  }, [localDeviceId, windowsMap, localWindowHandles]);
}
