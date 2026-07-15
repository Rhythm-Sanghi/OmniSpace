export const MSG_MOUSE_INPUT = 8;
export const MSG_KEYBOARD_INPUT = 9;

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
