import { Device, WindowInstance } from './types.js';

/**
 * Performs a shallow value comparison of two WindowInstance arrays to prevent redundant state updates.
 */
export function areWindowsEqual(a: WindowInstance[], b: WindowInstance[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const wa = a[i];
    const wb = b[i];
    if (
      !wa || !wb ||
      wa.id !== wb.id ||
      wa.x !== wb.x ||
      wa.y !== wb.y ||
      wa.width !== wb.width ||
      wa.height !== wb.height ||
      wa.owningDeviceId !== wb.owningDeviceId ||
      wa.capturingDeviceId !== wb.capturingDeviceId ||
      wa.hasActiveCapture !== wb.hasActiveCapture ||
      wa.streamId !== wb.streamId ||
      wa.title !== wb.title
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Performs a shallow value comparison of two Device arrays to prevent redundant state updates.
 */
export function areDevicesEqual(a: Device[], b: Device[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const da = a[i];
    const db = b[i];
    if (
      !da || !db ||
      da.id !== db.id ||
      da.x !== db.x ||
      da.y !== db.y ||
      da.width !== db.width ||
      da.height !== db.height ||
      da.status !== db.status ||
      da.name !== db.name ||
      da.dpiScale !== db.dpiScale ||
      da.type !== db.type
    ) {
      return false;
    }
  }
  return true;
}
