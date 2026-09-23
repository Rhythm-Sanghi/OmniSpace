import { useEffect } from 'react';
import * as Y from 'yjs';
import { WindowInstance } from 'core';

export function useNativeWindowTracking(
  localDeviceId: string,
  windowsMap: Y.Map<WindowInstance> | null | undefined,
  localWindowHandles: Map<string, number>
) {
  useEffect(() => {
    const isTauri = typeof window !== 'undefined' && !!(window as any).__TAURI_METADATA__;
    if (!isTauri || !windowsMap) return;

    let isCancelled = false;
    let unsubscribeBounds: (() => void) | null = null;
    let unsubscribeClosed: (() => void) | null = null;

    // Dynamically import Tauri event APIs to support browser-only contexts
    const initTauriListeners = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        if (isCancelled) return;

        // Listen for move/resize bounds updates from Rust poll loop
        const unlistenBounds = await listen(
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

        if (isCancelled) {
          unlistenBounds();
          return;
        } else {
          unsubscribeBounds = unlistenBounds;
        }

        // Listen for window closures
        const unlistenClosed = await listen('native-window-closed', (event: any) => {
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

        if (isCancelled) {
          unlistenClosed();
          return;
        } else {
          unsubscribeClosed = unlistenClosed;
        }
      } catch (err) {
        console.error('Failed to initialize Tauri native window tracking listeners:', err);
      }
    };

    initTauriListeners();

    return () => {
      isCancelled = true;
      if (unsubscribeBounds) unsubscribeBounds();
      if (unsubscribeClosed) unsubscribeClosed();
    };
  }, [localDeviceId, windowsMap, localWindowHandles]);
}
