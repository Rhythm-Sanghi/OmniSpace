import * as Y from 'yjs';
import { Device, WindowInstance } from './types.js';

export interface OmniDoc {
  doc: Y.Doc;
  devices: Y.Map<Device>;
  windows: Y.Map<WindowInstance>;
  state: Y.Map<any>;
  clipboard: Y.Map<any>;
}

export function initOmniDoc(doc: Y.Doc = new Y.Doc()): OmniDoc {
  const devices = doc.getMap<Device>('devices');
  const windows = doc.getMap<WindowInstance>('windows');
  const state = doc.getMap<any>('state');
  const clipboard = doc.getMap<any>('clipboard');

  return {
    doc,
    devices,
    windows,
    state,
    clipboard,
  };
}
