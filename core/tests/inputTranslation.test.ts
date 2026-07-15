import { describe, it, expect } from 'vitest';
import { translateToRealCoordinates } from '../src/inputTranslation.js';

describe('translateToRealCoordinates', () => {
  it('correctly maps logical video coordinates at 1x capturing DPI baseline', () => {
    // 1x Capturing Device Screen starting at global (0, 0), containing an 800x600 window
    const sourceWindow = { x: 100, y: 100, width: 800, height: 600 };
    const capturingDevice = { x: 0, y: 0, dpiScale: 1 };
    
    // Video element matches stream aspect ratio (4:3) - no letterboxing
    const videoElement = { width: 400, height: 300 };
    
    // Click in the center of the video (200, 150)
    const result = translateToRealCoordinates(
      { x: 200, y: 150 },
      videoElement,
      sourceWindow,
      capturingDevice
    );

    expect(result).not.toBeNull();
    // Center of window = 100 + 400 = 500, y = 100 + 300 = 400
    expect(result?.x).toBe(500);
    expect(result?.y).toBe(400);
  });

  it('translates coordinates with 2x capturing DPI (Retina screen)', () => {
    const sourceWindow = { x: 200, y: 100, width: 800, height: 600 };
    // Capturing device at (100, 50) on plane with a 2x scale
    const capturingDevice = { x: 100, y: 50, dpiScale: 2 };
    
    const videoElement = { width: 400, height: 300 };
    
    // Click at quarter position (100, 75)
    const result = translateToRealCoordinates(
      { x: 100, y: 75 },
      videoElement,
      sourceWindow,
      capturingDevice
    );

    expect(result).not.toBeNull();
    // 0.25 into window: x = 200 + 200 = 400. y = 100 + 150 = 250.
    // Local to capturing device: lx = 400 - 100 = 300. ly = 250 - 50 = 200.
    // Physical scaled: x = 300 * 2 = 600. y = 200 * 2 = 400.
    expect(result?.x).toBe(600);
    expect(result?.y).toBe(400);
  });

  it('discards clicks in letterbox margins and maps active areas correctly', () => {
    const sourceWindow = { x: 0, y: 0, width: 800, height: 600 }; // 4:3 Aspect
    const capturingDevice = { x: 0, y: 0, dpiScale: 1 };
    
    // Element aspect ratio is wider (16:9) - results in pillarboxes on left/right
    // Active width = 600 * (4/3) = 800px? Wait, height is 300.
    // Active width = 300 * (4/3) = 400.
    // Offset X = (800 - 400) / 2 = 200.
    const videoElement = { width: 800, height: 300 };

    // 1. Click in left pillarbox margin (100, 150) -> should be discarded
    const clickInMargin = translateToRealCoordinates(
      { x: 100, y: 150 },
      videoElement,
      sourceWindow,
      capturingDevice
    );
    expect(clickInMargin).toBeNull();

    // 2. Click in center of active feed (x=400, y=150) -> should map to center of window (400, 300)
    const clickInActive = translateToRealCoordinates(
      { x: 400, y: 150 },
      videoElement,
      sourceWindow,
      capturingDevice
    );
    expect(clickInActive).not.toBeNull();
    expect(clickInActive?.x).toBe(400);
    expect(clickInActive?.y).toBe(300);
  });
});
