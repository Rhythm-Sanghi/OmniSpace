import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { initOmniDoc } from '../src/schema.js';

describe('OmniDoc Schema', () => {
  it('initializes CRDT maps on a fresh Y.Doc', () => {
    const omniDoc = initOmniDoc();
    expect(omniDoc.doc).toBeInstanceOf(Y.Doc);
    expect(omniDoc.devices).toBeInstanceOf(Y.Map);
    expect(omniDoc.windows).toBeInstanceOf(Y.Map);
    expect(omniDoc.state).toBeInstanceOf(Y.Map);
    expect(omniDoc.clipboard).toBeInstanceOf(Y.Map);
  });

  it('binds to an existing Y.Doc instance', () => {
    const doc = new Y.Doc();
    const omniDoc = initOmniDoc(doc);
    expect(omniDoc.doc).toBe(doc);
  });
});
