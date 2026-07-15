export class OmniCaptureManager {
  private localStreams: Map<string, MediaStream> = new Map();
  private macosCaptureHandles: Map<string, { intervalId: any; img: HTMLImageElement; port: number }> = new Map();

  constructor() {}

  /**
   * Starts capturing an OS window using display media selection,
   * or a native CoreGraphics window loopback stream on macOS.
   */
  public async startWindowCapture(
    windowId: string,
    onTrackEnded?: (windowId: string) => void,
    hwndHandle?: number | null
  ): Promise<MediaStream> {
    const isMac = typeof navigator !== 'undefined' && navigator.userAgent && navigator.userAgent.toLowerCase().includes('mac');
    const isTauri = typeof window !== 'undefined' && (window as any).__TAURI_METADATA__ && (window as any).__TAURI__ && (window as any).__TAURI__.invoke;

    if (isMac && isTauri) {
      if (hwndHandle === undefined || hwndHandle === null) {
        throw new Error('Window handle is required for native macOS window capture.');
      }

      const [port, token] = await (window as any).__TAURI__.invoke('start_macos_capture', { windowId: hwndHandle });

      const canvas = document.createElement('canvas');
      canvas.width = 800;
      canvas.height = 600;
      const ctx = canvas.getContext('2d');

      const img = new Image();
      img.src = `http://127.0.0.1:${port}/stream?token=${token}`;

      const intervalId = setInterval(() => {
        if (img.complete && img.naturalWidth > 0) {
          if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
          }
          ctx?.drawImage(img, 0, 0);
        }
      }, 33); // ~30 fps

      // Generate the WebRTC MediaStream track from the Canvas
      // @ts-ignore
      const stream = canvas.captureStream(30);
      
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        const originalStop = videoTrack.stop;
        videoTrack.stop = () => {
          originalStop.call(videoTrack);
          this.stopWindowCapture(windowId);
          if (onTrackEnded) {
            onTrackEnded(windowId);
          }
        };
      }

      this.macosCaptureHandles.set(windowId, { intervalId, img, port });
      this.localStreams.set(windowId, stream);
      return stream;
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
      videoTrack.onended = () => {
        this.stopWindowCapture(windowId);
        if (onTrackEnded) {
          onTrackEnded(windowId);
        }
      };
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
      clearInterval(macHandle.intervalId);
      macHandle.img.src = ''; // Close client connection
      if (typeof window !== 'undefined' && (window as any).__TAURI__ && (window as any).__TAURI__.invoke) {
        (window as any).__TAURI__.invoke('stop_macos_capture').catch((err: any) => console.error(err));
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
