export interface Device {
  id: string;
  name: string;
  width: number;
  height: number;
  dpiScale: number;
  x: number;
  y: number;
  status: 'connected' | 'disconnected';
  disconnectedAt?: number;
  type: 'desktop' | 'mobile';
}

export interface WindowInstance {
  id: string;
  title: string;
  width: number;
  height: number;
  x: number; // Global plane coordinate
  y: number; // Global plane coordinate
  owningDeviceId: string | null;
  capturingDeviceId: string;
  hasActiveCapture: boolean;
  streamId?: string;
  isMaximized?: boolean;
  minWidth?: number;
  minHeight?: number;
  preMaximizedBounds?: { x: number; y: number; width: number; height: number };
}

export interface CursorState {
  deviceId: string;
  x: number; // Global plane X coordinate
  y: number; // Global plane Y coordinate
  active: boolean;
}

export interface SignalingPayload {
  senderPeerId: string;
  targetPeerId?: string;
  type: 'offer' | 'answer' | 'ice-candidate' | 'room-roster' | 'peer-joined' | 'peer-left' | 'error';
  payload: any;
}

export const DEFAULT_VIEWPORT_WIDTH = 750;
export const DEFAULT_WINDOW_WIDTH = 300;
export const DEFAULT_WINDOW_HEIGHT = 200;
export const DEFAULT_SCREEN_WIDTH = 1920;
export const DEFAULT_SCREEN_HEIGHT = 1080;

