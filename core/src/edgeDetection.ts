import { Device } from './types.js';
import { isInsideDevice } from './math.js';

export type Edge = 'left' | 'right' | 'top' | 'bottom';

export function getExitEdge(gx: number, gy: number, device: Device): Edge | null {
  // Check if it has exited
  if (gx < device.x) {
    return 'left';
  }
  if (gx >= device.x + device.width) {
    return 'right';
  }
  if (gy < device.y) {
    return 'top';
  }
  if (gy >= device.y + device.height) {
    return 'bottom';
  }
  return null;
}

export function findTargetDevice(
  gx: number,
  gy: number,
  devices: Device[],
  excludeDeviceId?: string
): Device | null {
  for (const device of devices) {
    if (excludeDeviceId && device.id === excludeDeviceId) {
      continue;
    }
    // Only handoff to connected devices
    if (device.status !== 'connected') {
      continue;
    }
    if (isInsideDevice(gx, gy, device)) {
      return device;
    }
  }
  return null;
}
