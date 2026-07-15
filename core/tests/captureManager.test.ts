import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OmniCaptureManager } from '../src/captureManager.js';

describe('OmniCaptureManager', () => {
  let originalNavigatorDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(global, 'navigator');
  });

  afterEach(() => {
    if (originalNavigatorDescriptor) {
      Object.defineProperty(global, 'navigator', originalNavigatorDescriptor);
    } else {
      // @ts-ignore
      delete global.navigator;
    }
  });

  const setMockNavigator = (mockNav: any) => {
    Object.defineProperty(global, 'navigator', {
      value: mockNav,
      configurable: true,
      writable: true,
    });
  };

  it('throws error when display media capture is not supported', async () => {
    setMockNavigator({}); // No mediaDevices
    const manager = new OmniCaptureManager();
    await expect(manager.startWindowCapture('win-1')).rejects.toThrow(
      'Screen capture is not supported in this client environment.'
    );
  });

  it('starts capture, registers onended callback, and cleanups stream correctly', async () => {
    const mockTrack = {
      stop: vi.fn(),
      onended: null as any,
    };

    const mockStream = {
      getVideoTracks: () => [mockTrack],
      getTracks: () => [mockTrack],
      id: 'stream-1',
    };

    const getDisplayMediaMock = vi.fn().mockResolvedValue(mockStream);

    setMockNavigator({
      mediaDevices: {
        getDisplayMedia: getDisplayMediaMock,
      },
    });

    const manager = new OmniCaptureManager();
    const onEndedSpy = vi.fn();

    const stream = await manager.startWindowCapture('win-1', onEndedSpy);

    expect(getDisplayMediaMock).toHaveBeenCalledWith({
      video: {
        displaySurface: 'window',
      },
      audio: false,
    });
    expect(stream).toBe(mockStream);
    expect(manager.getLocalStream('win-1')).toBe(mockStream);

    // Trigger onended callback
    if (mockTrack.onended) {
      mockTrack.onended();
    }

    expect(onEndedSpy).toHaveBeenCalledWith('win-1');
    expect(manager.getLocalStream('win-1')).toBeUndefined();
    expect(mockTrack.stop).toHaveBeenCalled();
  });

  it('stops window capture manually and clears streams', async () => {
    const mockTrack = {
      stop: vi.fn(),
    };
    const mockStream = {
      getVideoTracks: () => [mockTrack],
      getTracks: () => [mockTrack],
    };
    
    setMockNavigator({
      mediaDevices: {
        getDisplayMedia: vi.fn().mockResolvedValue(mockStream),
      },
    });

    const manager = new OmniCaptureManager();
    await manager.startWindowCapture('win-2');
    
    manager.stopWindowCapture('win-2');
    expect(mockTrack.stop).toHaveBeenCalled();
    expect(manager.getLocalStream('win-2')).toBeUndefined();
  });

  it('starts macOS native capture and streams over HTTP loopback server', async () => {
    const originalWindow = (global as any).window;
    
    const mockInvoke = vi.fn().mockResolvedValue([8080, 'mock-token-abc']);
    (global as any).window = {
      __TAURI_METADATA__: {},
      __TAURI__: {
        invoke: mockInvoke,
      },
    };
    
    setMockNavigator({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    });

    const mockCtx = {
      drawImage: vi.fn(),
    };

    const mockTrack = {
      stop: vi.fn(),
    };
    const trackStopSpy = mockTrack.stop;

    const mockStream = {
      getVideoTracks: () => [mockTrack],
      getTracks: () => [mockTrack],
    };

    const mockCanvas = {
      width: 800,
      height: 600,
      getContext: () => mockCtx,
      captureStream: vi.fn().mockReturnValue(mockStream),
    };

    const originalDocument = (global as any).document;
    (global as any).document = {
      createElement: vi.fn().mockImplementation((tag) => {
        if (tag === 'canvas') return mockCanvas;
        return {};
      }),
    };

    const mockImageInstance = {
      src: '',
      complete: true,
      naturalWidth: 1024,
      naturalHeight: 768,
    };

    const originalImage = (global as any).Image;
    (global as any).Image = vi.fn().mockImplementation(() => mockImageInstance);

    vi.useFakeTimers();

    const manager = new OmniCaptureManager();
    const onEndedSpy = vi.fn();

    const stream = await manager.startWindowCapture('win-macos', onEndedSpy, 9999);

    expect(mockInvoke).toHaveBeenCalledWith('start_macos_capture', { windowId: 9999 });
    expect(mockImageInstance.src).toBe('http://127.0.0.1:8080/stream?token=mock-token-abc');
    expect(mockCanvas.captureStream).toHaveBeenCalledWith(30);
    expect(stream).toBe(mockStream);

    // Advance by 33ms to trigger the drawInterval
    vi.advanceTimersByTime(33);
    expect(mockCanvas.width).toBe(1024);
    expect(mockCanvas.height).toBe(768);
    expect(mockCtx.drawImage).toHaveBeenCalledWith(mockImageInstance, 0, 0);

    // Stop capture and verify cleanup
    manager.stopWindowCapture('win-macos');
    expect(mockImageInstance.src).toBe('');
    expect(mockInvoke).toHaveBeenCalledWith('stop_macos_capture');
    expect(trackStopSpy).toHaveBeenCalled();

    // Restore global definitions
    (global as any).document = originalDocument;
    (global as any).Image = originalImage;
    (global as any).window = originalWindow;
    vi.useRealTimers();
  });
});
