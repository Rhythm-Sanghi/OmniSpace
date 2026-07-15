import { describe, it, expect } from 'vitest';
import { Device, localToGlobal, globalToLocal, isInsideDevice } from '../src/index.js';

describe('Coordinate Math Projections', () => {
  const mockDevice: Device = {
    id: 'device-1',
    name: 'Macbook',
    width: 1440,
    height: 900,
    dpiScale: 2,
    x: 1000,
    y: 500,
    status: 'connected',
    type: 'desktop',
  };

  it('correctly maps local screen coordinates to global plane coords', () => {
    const localX = 100;
    const localY = 200;
    const globalCoord = localToGlobal(localX, localY, mockDevice);
    expect(globalCoord.x).toBe(1100);
    expect(globalCoord.y).toBe(700);
  });

  it('correctly maps global plane coordinates to local device screen coords', () => {
    const globalX = 1500;
    const globalY = 800;
    const localCoord = globalToLocal(globalX, globalY, mockDevice);
    expect(localCoord.x).toBe(500);
    expect(localCoord.y).toBe(300);
  });

  it('properly validates if a global coordinate point falls within a device boundary', () => {
    // Inside bounds
    expect(isInsideDevice(1200, 600, mockDevice)).toBe(true);
    expect(isInsideDevice(1000, 500, mockDevice)).toBe(true);
    expect(isInsideDevice(2439, 1399, mockDevice)).toBe(true);

    // Outside bounds
    expect(isInsideDevice(999, 600, mockDevice)).toBe(false);
    expect(isInsideDevice(1200, 499, mockDevice)).toBe(false);
    expect(isInsideDevice(2440, 600, mockDevice)).toBe(false);
    expect(isInsideDevice(1200, 1400, mockDevice)).toBe(false);
  });
});
