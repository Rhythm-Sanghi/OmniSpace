import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Y from 'yjs';
import { OmniRTCManager, OmniQualityController } from '../src/index.js';

describe('OmniQualityController', () => {
  let mockRtcManager: any;
  let mockSender: any;
  let getSenderSpy: any;

  beforeEach(() => {
    mockRtcManager = {
      localDeviceId: 'device-A',
      sendQualityFeedback: vi.fn(),
      onQualityFeedbackReceived: null as any,
    };

    mockSender = {
      getParameters: vi.fn().mockReturnValue({
        encodings: [{}],
      }),
      setParameters: vi.fn().mockResolvedValue(undefined),
    };

    getSenderSpy = vi.fn().mockReturnValue(mockSender);
  });

  it('polls inbound-rtp stats and triggers throttle-down when loss percentage is high', async () => {
    vi.useFakeTimers();

    const controller = new OmniQualityController(mockRtcManager, getSenderSpy);

    // Mock RTCPeerConnection returning bad connection stats
    let callCount = 0;
    const mockPc = {
      getStats: vi.fn().mockImplementation(() => {
        callCount++;
        const map = new Map<string, any>();
        if (callCount === 1) {
          // First interval: low loss
          map.set('report-1', {
            type: 'inbound-rtp',
            kind: 'video',
            packetsLost: 0,
            packetsReceived: 100,
            jitter: 0.01,
          });
        } else {
          // Second interval: high loss (lost 50 packets out of 100 received)
          map.set('report-1', {
            type: 'inbound-rtp',
            kind: 'video',
            packetsLost: 50,
            packetsReceived: 150,
            jitter: 0.08,
          });
        }
        return Promise.resolve(map);
      }),
    } as any;

    controller.startStatsPolling('win-1', 'device-B', mockPc);

    // Poll 1: Stable
    await vi.advanceTimersByTimeAsync(2000);
    expect(mockRtcManager.sendQualityFeedback).not.toHaveBeenCalled();

    // Poll 2: Trigger throttle-down
    await vi.advanceTimersByTimeAsync(2000);
    expect(mockRtcManager.sendQualityFeedback).toHaveBeenCalledWith('device-B', {
      windowId: 'win-1',
      maxBitrate: 1050000, // 1500000 * 0.7
      maxFramerate: 20, // stepped down to 20
    });

    controller.destroy();
    vi.useRealTimers();
  });

  it('restores quality after consecutive clean intervals', async () => {
    vi.useFakeTimers();

    const controller = new OmniQualityController(mockRtcManager, getSenderSpy);

    // Start with a lower quality target (e.g. 500kbps, 15fps)
    (controller as any).currentBitrate.set('win-1', 500000);
    (controller as any).currentFramerate.set('win-1', 15);

    const mockPc = {
      getStats: vi.fn().mockImplementation(() => {
        const map = new Map<string, any>();
        // Stable stats (no loss, jitter = 0.002s)
        map.set('report-1', {
          type: 'inbound-rtp',
          kind: 'video',
          packetsLost: 0,
          packetsReceived: 100,
          jitter: 0.002,
        });
        return Promise.resolve(map);
      }),
    } as any;

    controller.startStatsPolling('win-1', 'device-B', mockPc);
    // Explicitly seed the lower stats so it doesn't default to clean limits
    (controller as any).currentBitrate.set('win-1', 500000);
    (controller as any).currentFramerate.set('win-1', 15);

    // Advance 3 intervals (6 seconds) to trigger recovery
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(mockRtcManager.sendQualityFeedback).toHaveBeenCalledWith('device-B', {
      windowId: 'win-1',
      maxBitrate: 650000, // 500000 * 1.3
      maxFramerate: 20, // 15 + 5
    });

    controller.destroy();
    vi.useRealTimers();
  });

  it('applies received quality feedback parameters on the sender side', () => {
    const _controller = new OmniQualityController(mockRtcManager, getSenderSpy);

    // Simulate receiving feedback packet on sender side
    mockRtcManager.onQualityFeedbackReceived('device-B', {
      windowId: 'win-1',
      maxBitrate: 300000,
      maxFramerate: 10,
    });

    expect(getSenderSpy).toHaveBeenCalledWith('win-1', 'device-B');
    expect(mockSender.setParameters).toHaveBeenCalled();
    const appliedParams = mockSender.setParameters.mock.calls[0][0];
    expect(appliedParams.encodings[0].maxBitrate).toBe(300000);
    expect(appliedParams.encodings[0].maxFramerate).toBe(10);
  });
});
