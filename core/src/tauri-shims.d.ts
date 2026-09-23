declare module '@tauri-apps/api/tauri' {
  export const invoke: <T = any>(cmd: string, args?: any) => Promise<T>;
}

declare module '@tauri-apps/api/event' {
  export interface Event<T> {
    event: string;
    windowLabel: string;
    payload: T;
  }
  
  export const listen: <T = any>(
    event: string,
    handler: (event: Event<T>) => void
  ) => Promise<() => void>;
}
