import * as Y from 'yjs';

/**
 * Focuses a specific window viewport globally in the shared Yjs doc.
 */
export function focusWindow(doc: Y.Doc, windowId: string) {
  const stateMap = doc.getMap<any>('state');
  stateMap.set('focusedWindowId', windowId);
}

/**
 * Clears global window focus.
 */
export function blurWindow(doc: Y.Doc) {
  const stateMap = doc.getMap<any>('state');
  stateMap.set('focusedWindowId', null);
}

/**
 * Returns the currently focused window ID, or null.
 */
export function getFocusedWindowId(doc: Y.Doc): string | null {
  const stateMap = doc.getMap<any>('state');
  return stateMap.get('focusedWindowId') || null;
}

/**
 * Clears focus if the targeted window matches the currently focused one.
 */
export function clearFocusIfMatches(doc: Y.Doc, windowId: string) {
  const stateMap = doc.getMap<any>('state');
  if (stateMap.get('focusedWindowId') === windowId) {
    stateMap.set('focusedWindowId', null);
  }
}
