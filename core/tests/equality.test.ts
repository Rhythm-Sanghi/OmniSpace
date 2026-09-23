import { describe, it, expect } from 'vitest';
import { areWindowsEqual, areDevicesEqual } from '../src/equality.js';
import { WindowInstance, Device } from '../src/types.js';

describe('equality functions', () => {
  describe('areWindowsEqual', () => {
    const baseWindow: WindowInstance = {
      id: 'win-1',
      title: 'Browser',
      width: 800,
      height: 600,
      x: 100,
      y: 100,
      owningDeviceId: 'dev-1',
      capturingDeviceId: 'dev-1',
      hasActiveCapture: true,
      streamId: 'stream-1',
    };

    it('returns true for identical window arrays', () => {
      expect(areWindowsEqual([baseWindow], [{ ...baseWindow }])).toBe(true);
    });

    it('returns false for different array lengths', () => {
      expect(areWindowsEqual([baseWindow], [])).toBe(false);
    });

    it('returns false when position or properties differ', () => {
      expect(areWindowsEqual([baseWindow], [{ ...baseWindow, x: 200 }])).toBe(false);
      expect(areWindowsEqual([baseWindow], [{ ...baseWindow, owningDeviceId: 'dev-2' }])).toBe(false);
      expect(areWindowsEqual([baseWindow], [{ ...baseWindow, title: 'Editor' }])).toBe(false);
    });
  });

  describe('areDevicesEqual', () => {
    const baseDevice: Device = {
      id: 'dev-1',
      name: 'Desktop PC',
      width: 1920,
      height: 1080,
      dpiScale: 1,
      x: 0,
      y: 0,
      status: 'connected',
      type: 'desktop',
    };

    it('returns true for identical device arrays', () => {
      expect(areDevicesEqual([baseDevice], [{ ...baseDevice }])).toBe(true);
    });

    it('returns false for different array lengths', () => {
      expect(areDevicesEqual([baseDevice], [])).toBe(false);
    });

    it('returns false when properties differ', () => {
      expect(areDevicesEqual([baseDevice], [{ ...baseDevice, status: 'disconnected' }])).toBe(false);
      expect(areDevicesEqual([baseDevice], [{ ...baseDevice, x: 100 }])).toBe(false);
      expect(areDevicesEqual([baseDevice], [{ ...baseDevice, name: 'Laptop' }])).toBe(false);
    });
  });
});
