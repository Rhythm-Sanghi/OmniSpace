export interface NativeWindowInfo {
  handle: number; // Native window handle (HWND on Windows, CGWindowID on macOS, XID on Linux)
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  appName?: string;
}

export interface NativeWindowBoundsEvent {
  handle: number;
  x: number;
  y: number;
  width: number;
  height: number;
}
