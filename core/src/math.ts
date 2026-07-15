import { Device } from './types.js';

export function localToGlobal(lx: number, ly: number, device: Device): { x: number; y: number } {
  return {
    x: lx + device.x,
    y: ly + device.y,
  };
}

export function globalToLocal(gx: number, gy: number, device: Device): { x: number; y: number } {
  return {
    x: gx - device.x,
    y: gy - device.y,
  };
}

export function isInsideDevice(gx: number, gy: number, device: Device): boolean {
  return (
    gx >= device.x &&
    gx < device.x + device.width &&
    gy >= device.y &&
    gy < device.y + device.height
  );
}
