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
  type: 'offer' | 'answer' | 'ice-candidate' | 'room-roster' | 'peer-joined' | 'peer-left';
  payload: any;
}
