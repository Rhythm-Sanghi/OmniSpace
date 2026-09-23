export const MSG_MOUSE_INPUT = 7;
export const MSG_KEYBOARD_INPUT = 8;
export const MSG_FILE_TRANSFER = 9;

export interface MouseMovePayload {
  x: number;
  y: number;
}

export interface MouseButtonPayload {
  x: number;
  y: number;
  button: number; // 0: Left, 1: Middle, 2: Right
}

export interface MouseScrollPayload {
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
}

export interface KeyboardKeyPayload {
  code: string; // e.g. "KeyA", "Enter" (physical browser layout-agnostic code)
  key: string;  // e.g. "a", "Enter"
}

export type InputEventPayload =
  | { type: 'mousemove'; data: MouseMovePayload }
  | { type: 'mousedown'; data: MouseButtonPayload }
  | { type: 'mouseup'; data: MouseButtonPayload }
  | { type: 'scroll'; data: MouseScrollPayload }
  | { type: 'keydown'; data: KeyboardKeyPayload }
  | { type: 'keyup'; data: KeyboardKeyPayload };

export interface InputEventEnvelope {
  targetWindowId: string;
  event: InputEventPayload;
  timestamp: number;
}

export interface QualityFeedback {
  windowId: string;
  maxBitrate?: number;
  maxFramerate?: number;
}

export function isValidQualityFeedback(data: unknown): data is QualityFeedback {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  if (typeof d.windowId !== 'string' || d.windowId.trim().length === 0 || d.windowId.length > 256) {
    return false;
  }
  if (d.maxBitrate !== undefined && (typeof d.maxBitrate !== 'number' || isNaN(d.maxBitrate) || d.maxBitrate <= 0)) {
    return false;
  }
  if (d.maxFramerate !== undefined && (typeof d.maxFramerate !== 'number' || isNaN(d.maxFramerate) || d.maxFramerate <= 0)) {
    return false;
  }
  return true;
}

export function isValidInputEventEnvelope(data: unknown): data is InputEventEnvelope {
  if (!data || typeof data !== 'object') return false;
  const env = data as Record<string, unknown>;
  if (typeof env.targetWindowId !== 'string' || env.targetWindowId.trim().length === 0 || env.targetWindowId.length > 256) {
    return false;
  }
  if (typeof env.timestamp !== 'number' || isNaN(env.timestamp) || env.timestamp <= 0) {
    return false;
  }
  if (!env.event || typeof env.event !== 'object') {
    return false;
  }
  const evt = env.event as Record<string, unknown>;
  if (typeof evt.type !== 'string' || !evt.data || typeof evt.data !== 'object') {
    return false;
  }
  const payload = evt.data as Record<string, unknown>;
  switch (evt.type) {
    case 'mousemove':
      return typeof payload.x === 'number' && !isNaN(payload.x) && typeof payload.y === 'number' && !isNaN(payload.y);
    case 'mousedown':
    case 'mouseup':
      return (
        typeof payload.x === 'number' && !isNaN(payload.x) &&
        typeof payload.y === 'number' && !isNaN(payload.y) &&
        typeof payload.button === 'number' && !isNaN(payload.button) && [0, 1, 2, 3, 4].includes(payload.button as number)
      );
    case 'scroll':
      return (
        typeof payload.x === 'number' && !isNaN(payload.x) &&
        typeof payload.y === 'number' && !isNaN(payload.y) &&
        typeof payload.deltaX === 'number' && !isNaN(payload.deltaX) &&
        typeof payload.deltaY === 'number' && !isNaN(payload.deltaY)
      );
    case 'keydown':
    case 'keyup':
      return (
        typeof payload.code === 'string' &&
        payload.code.length <= 64 &&
        typeof payload.key === 'string' &&
        payload.key.length <= 64
      );
    default:
      return false;
  }
}

export interface FileTransferStartPayload {
  action: 'start';
  transferId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  totalChunks: number;
}

export interface FileTransferChunkPayload {
  action: 'chunk';
  transferId: string;
  chunkIndex: number;
  data: string; // base64 encoded chunk
}

export interface FileTransferCompletePayload {
  action: 'complete';
  transferId: string;
  checksum?: string;
}

export interface FileTransferAbortPayload {
  action: 'abort';
  transferId: string;
  reason?: string;
}

export type FileTransferPayload =
  | FileTransferStartPayload
  | FileTransferChunkPayload
  | FileTransferCompletePayload
  | FileTransferAbortPayload;

export function isValidFileTransferPayload(data: unknown): data is FileTransferPayload {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;

  if (typeof d.transferId !== 'string' || d.transferId.trim().length === 0 || d.transferId.length > 128) {
    return false;
  }

  switch (d.action) {
    case 'start':
      return (
        typeof d.fileName === 'string' &&
        d.fileName.trim().length > 0 &&
        d.fileName.length <= 256 &&
        typeof d.fileSize === 'number' &&
        !isNaN(d.fileSize) &&
        d.fileSize >= 0 &&
        typeof d.mimeType === 'string' &&
        d.mimeType.length <= 128 &&
        typeof d.totalChunks === 'number' &&
        !isNaN(d.totalChunks) &&
        d.totalChunks >= 0
      );
    case 'chunk':
      return (
        typeof d.chunkIndex === 'number' &&
        !isNaN(d.chunkIndex) &&
        d.chunkIndex >= 0 &&
        typeof d.data === 'string'
      );
    case 'complete':
      return d.checksum === undefined || (typeof d.checksum === 'string' && d.checksum.length <= 128);
    case 'abort':
      return d.reason === undefined || (typeof d.reason === 'string' && d.reason.length <= 256);
    default:
      return false;
  }
}
