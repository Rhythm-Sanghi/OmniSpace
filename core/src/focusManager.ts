import * as Y from 'yjs';

export interface FocusStateSchema {
  focusedWindowId: string | null;
}

/**
 * Focuses a specific window viewport globally in the shared Yjs doc.
 */
export function focusWindow(doc: Y.Doc, windowId: string) {
  const stateMap = doc.getMap<string | null>('state');
  doc.transact(() => {
    stateMap.set('focusedWindowId', windowId);
  }, 'focus-change');
}

/**
 * Clears global window focus.
 */
export function blurWindow(doc: Y.Doc) {
  const stateMap = doc.getMap<string | null>('state');
  doc.transact(() => {
    stateMap.set('focusedWindowId', null);
  }, 'focus-change');
}

/**
 * Returns the currently focused window ID, or null.
 */
export function getFocusedWindowId(doc: Y.Doc): string | null {
  const stateMap = doc.getMap<string | null>('state');
  const val = stateMap.get('focusedWindowId');
  return typeof val === 'string' && val.length > 0 ? val : null;
}

/**
 * Clears focus if the targeted window matches the currently focused one.
 */
export function clearFocusIfMatches(doc: Y.Doc, windowId: string) {
  const stateMap = doc.getMap<string | null>('state');
  if (stateMap.get('focusedWindowId') === windowId) {
    doc.transact(() => {
      stateMap.set('focusedWindowId', null);
    }, 'focus-change');
  }
}
