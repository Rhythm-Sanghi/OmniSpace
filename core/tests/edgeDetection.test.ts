import { describe, it, expect } from 'vitest';
import { Device, getExitEdge, findTargetDevice } from '../src/index.js';

describe('Edge Detection and Handoff Candidates', () => {
  const localDevice: Device = {
    id: 'local-id',
    name: 'Primary Screen',
    width: 1000,
    height: 600,
    dpiScale: 1,
    x: 0,
    y: 0,
    status: 'connected',
    type: 'desktop',
  };

  const rightNeighbor: Device = {
    id: 'right-neighbor',
    name: 'Right Screen',
    width: 800,
    height: 600,
    dpiScale: 1,
    x: 1000, // Aligned directly to the right edge of localDevice
    y: 0,
    status: 'connected',
    type: 'desktop',
  };

  const offlineNeighbor: Device = {
    id: 'offline-neighbor',
    name: 'Offline Screen',
    width: 800,
    height: 600,
    dpiScale: 1,
    x: -800, // Aligned directly to the left edge of localDevice
    y: 0,
    status: 'disconnected', // Offline
    type: 'mobile',
  };

  const devicesList = [localDevice, rightNeighbor, offlineNeighbor];

  it('correctly detects exit edges', () => {
    // Exits left
    expect(getExitEdge(-1, 300, localDevice)).toBe('left');
    // Exits right
    expect(getExitEdge(1000, 300, localDevice)).toBe('right');
    // Exits top
    expect(getExitEdge(500, -1, localDevice)).toBe('top');
    // Exits bottom
    expect(getExitEdge(500, 600, localDevice)).toBe('bottom');
    // No exit
    expect(getExitEdge(500, 300, localDevice)).toBeNull();
  });

  it('identifies valid connected target devices for handoff coordinates', () => {
    // Coordinate is inside rightNeighbor bounds
    const target = findTargetDevice(1100, 300, devicesList, localDevice.id);
    expect(target).not.toBeNull();
    expect(target?.id).toBe('right-neighbor');
  });

  it('excludes disconnected devices from transition targets', () => {
    // Coordinate is inside offlineNeighbor bounds
    const target = findTargetDevice(-200, 300, devicesList, localDevice.id);
    expect(target).toBeNull(); // Should ignore offline devices
  });
});
