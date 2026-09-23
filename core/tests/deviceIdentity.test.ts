import { describe, it, expect, beforeEach } from 'vitest';
import { getDeviceId } from '../src/deviceIdentity.js';

function createMockStorage(): Storage {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = String(value);
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
    key: (index: number) => Object.keys(store)[index] ?? null,
    get length() {
      return Object.keys(store).length;
    },
  };
}

describe('deviceIdentity', () => {
  beforeEach(() => {
    (globalThis as any).localStorage = createMockStorage();
    (globalThis as any).sessionStorage = createMockStorage();
    (globalThis as any).window = {
      location: { search: '' },
    };
  });

  it('generates a stable persistent device ID in standard browser environment', () => {
    const id1 = getDeviceId();
    expect(id1).toMatch(/^device-/);

    const id2 = getDeviceId();
    expect(id2).toBe(id1);
  });

  it('generates a dev device ID when dev parameter is set', () => {
    // Mock URLSearchParams with dev=true
    const originalSearch = window.location.search;
    delete (window as any).location;
    window.location = { search: '?dev=true' } as any;

    try {
      const devId1 = getDeviceId();
      expect(devId1).toMatch(/^dev-device-/);

      const devId2 = getDeviceId();
      expect(devId2).toBe(devId1);
    } finally {
      window.location = { search: originalSearch } as any;
    }
  });

  it('uses devDeviceId override when provided in search params', () => {
    const originalSearch = window.location.search;
    delete (window as any).location;
    window.location = { search: '?dev=true&devDeviceId=custom-peer-123' } as any;

    try {
      const devId = getDeviceId();
      expect(devId).toBe('custom-peer-123');
    } finally {
      window.location = { search: originalSearch } as any;
    }
  });
});
