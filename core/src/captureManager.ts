interface TauriWindow {
  __TAURI_METADATA__?: unknown;
  __TAURI__?: {
    invoke?: (cmd: string, args?: any) => Promise<any>;
    [key: string]: any;
  };
}

function getTauriWindow(): TauriWindow | null {
  if (typeof window === 'undefined') return null;
  return window as unknown as TauriWindow;
}

export const INITIAL_CANVAS_WIDTH = 800;
export const INITIAL_CANVAS_HEIGHT = 600;

interface MacOSCaptureHandle {
  intervalId: ReturnType<typeof setInterval> | null;
  animationFrameId: number | null;
  img: HTMLImageElement;
  port: number;
}

export class OmniCaptureManager {
  private localStreams: Map<string, MediaStream> = new Map();
  private macosCaptureHandles: Map<string, MacOSCaptureHandle> = new Map();

  constructor() {}

  private log(level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) {
    const timestamp = new Date().toISOString();
    const payload = meta ? ` ${JSON.stringify(meta)}` : '';
    const formatted = `[OmniCaptureManager][${timestamp}] ${message}${payload}`;
    if (level === 'error') console.error(formatted);
    else if (level === 'warn') console.warn(formatted);
    else console.log(formatted);
  }

  /**
   * Starts capturing an OS window using native platform frame loopback stream under Tauri
   * (macOS CoreGraphics, Windows Win32 GDI/PrintWindow, Linux X11),
   * or falls back to standard navigator.mediaDevices.getDisplayMedia in browser environments.
   */
  public async startWindowCapture(
    windowId: string,
    onTrackEnded?: (windowId: string) => void,
    hwndHandle?: number | null
  ): Promise<MediaStream> {
    const tauriWin = getTauriWindow();
    const isTauri = Boolean(
      tauriWin?.__TAURI_METADATA__ ||
      (tauriWin?.__TAURI__ && typeof tauriWin.__TAURI__.invoke === 'function')
    );

    // If running natively inside desktop Tauri and a target window handle was provided,
    // use the native Rust loopback frame streamer.
    if (isTauri && hwndHandle !== undefined && hwndHandle !== null) {
      this.stopWindowCapture(windowId);
      let invokeFn: ((cmd: string, args?: any) => Promise<any>) | null = null;
      if (tauriWin?.__TAURI__ && typeof tauriWin.__TAURI__.invoke === 'function') {
        invokeFn = tauriWin.__TAURI__.invoke;
      } else {
        try {
          const tauriApi = await import('@tauri-apps/api/tauri');
          invokeFn = tauriApi.invoke;
        } catch {
          invokeFn = null;
        }
      }

      if (invokeFn) {
        const [port, token] = await invokeFn('start_macos_capture', { windowId: hwndHandle });

        const canvas = document.createElement('canvas');
        canvas.width = INITIAL_CANVAS_WIDTH;
        canvas.height = INITIAL_CANVAS_HEIGHT;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          this.log('warn', 'Failed to obtain 2D canvas context for window capture', { windowId });
        }

        const img = new Image();
        img.onerror = (err) => {
          this.log('error', 'Loopback frame streaming image error', { windowId, err: String(err) });
          this.stopWindowCapture(windowId);
          if (onTrackEnded) {
            onTrackEnded(windowId);
          }
        };
        img.src = `http://127.0.0.1:${port}/stream?token=${token}`;

        let animationFrameId: number | null = null;
        let intervalId: ReturnType<typeof setInterval> | null = null;
        let consecutiveEmptyFrames = 0;
        const MAX_CONSECUTIVE_EMPTY = 150; // ~5 seconds of no frames

        const drawFrame = () => {
          if (img.complete && img.naturalWidth > 0) {
            consecutiveEmptyFrames = 0;
            if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
              canvas.width = img.naturalWidth;
              canvas.height = img.naturalHeight;
            }
            if (ctx) {
              ctx.drawImage(img, 0, 0);
            }
          } else {
            consecutiveEmptyFrames++;
            if (consecutiveEmptyFrames > MAX_CONSECUTIVE_EMPTY) {
              this.log('warn', 'Frame streaming timed out without valid image payload', { windowId });
              this.stopWindowCapture(windowId);
              if (onTrackEnded) onTrackEnded(windowId);
              return;
            }
          }
          if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
            animationFrameId = window.requestAnimationFrame(drawFrame);
            const handle = this.macosCaptureHandles.get(windowId);
            if (handle) {
              handle.animationFrameId = animationFrameId;
            }
          }
        };

        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
          animationFrameId = window.requestAnimationFrame(drawFrame);
        } else {
          intervalId = setInterval(drawFrame, 33);
        }

        // Register handle immediately to avoid interval leak if stream creation fails
        this.macosCaptureHandles.set(windowId, {
          intervalId,
          animationFrameId,
          img,
          port,
        });

        let stream: MediaStream | null = null;
        try {
          stream = (canvas as any).captureStream ? ((canvas as any).captureStream(30) as MediaStream) : null;
        } catch (err) {
          this.stopWindowCapture(windowId);
          throw err;
        }

        if (!stream) {
          this.stopWindowCapture(windowId);
          throw new Error('Canvas captureStream is not supported in this runtime environment');
        }

        const videoTrack = stream.getVideoTracks()[0];
        if (videoTrack) {
          let isStopping = false;
          const originalStop = videoTrack.stop;
          videoTrack.stop = () => {
            if (isStopping) return;
            isStopping = true;
            if (typeof originalStop === 'function') {
              originalStop.call(videoTrack);
            }
            this.stopWindowCapture(windowId);
            if (onTrackEnded) {
              onTrackEnded(windowId);
            }
          };
          if (typeof videoTrack.addEventListener === 'function') {
            videoTrack.addEventListener('ended', () => {
              if (isStopping) return;
              isStopping = true;
              this.stopWindowCapture(windowId);
              if (onTrackEnded) {
                onTrackEnded(windowId);
              }
            });
          } else {
            videoTrack.onended = () => {
              if (isStopping) return;
              isStopping = true;
              this.stopWindowCapture(windowId);
              if (onTrackEnded) {
                onTrackEnded(windowId);
              }
            };
          }
        }

        this.localStreams.set(windowId, stream);
        return stream;
      }
    }

    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getDisplayMedia !== 'function'
    ) {
      throw new Error('Screen capture is not supported in this client environment.');
    }

    // Stop any existing stream for this window first
    this.stopWindowCapture(windowId);

    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        displaySurface: 'window',
      },
      audio: false,
    });

    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) {
      if (typeof videoTrack.addEventListener === 'function') {
        videoTrack.addEventListener('ended', () => {
          this.stopWindowCapture(windowId);
          if (onTrackEnded) {
            onTrackEnded(windowId);
          }
        });
      } else {
        videoTrack.onended = () => {
          this.stopWindowCapture(windowId);
          if (onTrackEnded) {
            onTrackEnded(windowId);
          }
        };
      }
    }

    this.localStreams.set(windowId, stream);
    return stream;
  }

  /**
   * Stops a window capture stream and releases camera/screen lock resources.
   */
  public stopWindowCapture(windowId: string) {
    const macHandle = this.macosCaptureHandles.get(windowId);
    if (macHandle) {
      if (
        macHandle.animationFrameId !== null &&
        typeof window !== 'undefined' &&
        typeof window.cancelAnimationFrame === 'function'
      ) {
        window.cancelAnimationFrame(macHandle.animationFrameId);
      }
      if (macHandle.intervalId) {
        clearInterval(macHandle.intervalId);
      }
      macHandle.img.src = ''; // Close client connection
      if (typeof window !== 'undefined') {
        if ((window as any).__TAURI__ && typeof (window as any).__TAURI__.invoke === 'function') {
          (window as any).__TAURI__.invoke('stop_macos_capture', { windowId, port: macHandle.port })
            .catch((err: unknown) => console.error(`[OmniCaptureManager] Failed to stop native capture for window ${windowId}:`, err));
        } else {
          import('@tauri-apps/api/tauri').then(({ invoke }) => {
            invoke('stop_macos_capture', { windowId, port: macHandle.port })
              .catch((err: unknown) => console.error(`[OmniCaptureManager] Failed to stop native capture for window ${windowId}:`, err));
          }).catch((err: unknown) => console.error(`[OmniCaptureManager] Failed to import Tauri invoke for stop_macos_capture on window ${windowId}:`, err));
        }
      }
      this.macosCaptureHandles.delete(windowId);
    }

    const stream = this.localStreams.get(windowId);
    if (stream) {
      // Delete from localStreams FIRST to break potential infinite recursion loops
      this.localStreams.delete(windowId);
      stream.getTracks().forEach((track) => {
        track.stop();
      });
    }
  }

  /**
   * Retrieves the active captured stream for a given window.
   */
  public getLocalStream(windowId: string): MediaStream | undefined {
    return this.localStreams.get(windowId);
  }

  /**
   * Releases all active capture streams.
   */
  public destroy() {
    Array.from(this.localStreams.keys()).forEach((windowId) => {
      this.stopWindowCapture(windowId);
    });
    this.localStreams.clear();
    this.macosCaptureHandles.clear();
  }
}
