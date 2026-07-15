import { OmniRTCManager } from './rtc.js';

export interface QualityFeedback {
  windowId: string;
  maxBitrate?: number; // in bps
  maxFramerate?: number; // in fps
}

export class OmniQualityController {
  private pollIntervals: Map<string, any> = new Map(); // windowId -> setInterval ID
  private prevStats: Map<string, { packetsLost: number; packetsReceived: number }> = new Map(); // windowId -> stats
  private consecutiveCleanIntervals: Map<string, number> = new Map(); // windowId -> count

  // Active targets
  private currentBitrate: Map<string, number> = new Map(); // windowId -> bps
  private currentFramerate: Map<string, number> = new Map(); // windowId -> fps

  private readonly MIN_BITRATE = 150000; // 150 kbps
  private readonly MAX_BITRATE = 2500000; // 2.5 Mbps
  private readonly DEFAULT_BITRATE = 1500000; // 1.5 Mbps

  private readonly MIN_FRAMERATE = 5;
  private readonly MAX_FRAMERATE = 30;
  private readonly DEFAULT_FRAMERATE = 30;

  constructor(
    private rtcManager: OmniRTCManager,
    private getSender: (windowId: string, peerId: string) => RTCRtpSender | undefined
  ) {
    // Register listener for quality feedback on sender side
    this.rtcManager.onQualityFeedbackReceived = (peerId, feedback) => {
      this.applyQualityFeedback(peerId, feedback);
    };
  }

  /**
   * Starts polling receiver stats for an incoming video track.
   */
  public startStatsPolling(windowId: string, peerId: string, pc: RTCPeerConnection) {
    this.stopStatsPolling(windowId);

    // Initialize metrics
    this.currentBitrate.set(windowId, this.DEFAULT_BITRATE);
    this.currentFramerate.set(windowId, this.DEFAULT_FRAMERATE);
    this.consecutiveCleanIntervals.set(windowId, 0);

    const interval = setInterval(async () => {
      try {
        const stats = await pc.getStats();
        let inboundVideoStats: any = null;

        stats.forEach((report) => {
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            inboundVideoStats = report;
          }
        });

        if (!inboundVideoStats) return;

        const packetsLost = inboundVideoStats.packetsLost || 0;
        const packetsReceived = inboundVideoStats.packetsReceived || 0;
        const jitter = inboundVideoStats.jitter || 0;

        const prev = this.prevStats.get(windowId) || { packetsLost: 0, packetsReceived: 0 };
        this.prevStats.set(windowId, { packetsLost, packetsReceived });

        const lostDelta = packetsLost - prev.packetsLost;
        const recDelta = packetsReceived - prev.packetsReceived;
        const totalDelta = lostDelta + recDelta;

        const lossPercentage = totalDelta > 0 ? (lostDelta / totalDelta) * 100 : 0;

        let shouldAdjust = false;
        let bitrate = this.currentBitrate.get(windowId) || this.DEFAULT_BITRATE;
        let framerate = this.currentFramerate.get(windowId) || this.DEFAULT_FRAMERATE;

        // Thresholds: loss > 5% or jitter > 50ms (0.05s)
        if (lossPercentage > 5 || jitter > 0.05) {
          this.consecutiveCleanIntervals.set(windowId, 0);

          // Throttle down (bitrate by 0.7x, framerate by step)
          bitrate = Math.max(this.MIN_BITRATE, Math.round(bitrate * 0.7));
          if (framerate > 20) framerate = 20;
          else if (framerate > 15) framerate = 15;
          else if (framerate > 10) framerate = 10;
          else framerate = Math.max(this.MIN_FRAMERATE, framerate - 2);

          shouldAdjust = true;
        } else {
          // Stable connection
          const cleanCount = (this.consecutiveCleanIntervals.get(windowId) || 0) + 1;
          this.consecutiveCleanIntervals.set(windowId, cleanCount);

          // Recover after 3 consecutive clean cycles (6 seconds)
          if (cleanCount >= 3) {
            this.consecutiveCleanIntervals.set(windowId, 0);

            if (bitrate < this.MAX_BITRATE || framerate < this.MAX_FRAMERATE) {
              bitrate = Math.min(this.MAX_BITRATE, Math.round(bitrate * 1.3));
              framerate = Math.min(this.MAX_FRAMERATE, framerate + 5);
              shouldAdjust = true;
            }
          }
        }

        if (shouldAdjust) {
          this.currentBitrate.set(windowId, bitrate);
          this.currentFramerate.set(windowId, framerate);

          // Broadcast feedback back to capturing sender peer
          this.rtcManager.sendQualityFeedback(peerId, {
            windowId,
            maxBitrate: bitrate,
            maxFramerate: framerate,
          });
        }
      } catch (err) {
        console.error(`Error polling stats for window ${windowId}:`, err);
      }
    }, 2000);

    this.pollIntervals.set(windowId, interval);
  }

  /**
   * Stops polling receiver stats for a track.
   */
  public stopStatsPolling(windowId: string) {
    if (this.pollIntervals.has(windowId)) {
      clearInterval(this.pollIntervals.get(windowId));
      this.pollIntervals.delete(windowId);
    }
    this.prevStats.delete(windowId);
    this.consecutiveCleanIntervals.delete(windowId);
    this.currentBitrate.delete(windowId);
    this.currentFramerate.delete(windowId);
  }

  /**
   * Applies received quality feedback to the RTCRtpSender.
   */
  private async applyQualityFeedback(peerId: string, feedback: QualityFeedback) {
    const sender = this.getSender(feedback.windowId, peerId);
    if (!sender) return;

    try {
      const params = sender.getParameters();
      if (!params.encodings) {
        params.encodings = [{}];
      }

      if (feedback.maxBitrate !== undefined) {
        params.encodings[0].maxBitrate = feedback.maxBitrate;
      }
      if (feedback.maxFramerate !== undefined) {
        params.encodings[0].maxFramerate = feedback.maxFramerate;
      }

      await sender.setParameters(params);
    } catch (err) {
      console.error(`Failed to apply quality parameters for window ${feedback.windowId}:`, err);
    }
  }

  public destroy() {
    this.pollIntervals.forEach((interval) => clearInterval(interval));
    this.pollIntervals.clear();
    this.prevStats.clear();
    this.consecutiveCleanIntervals.clear();
    this.currentBitrate.clear();
    this.currentFramerate.clear();
  }
}
