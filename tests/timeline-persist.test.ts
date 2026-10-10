import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canRestore } from '../packages/web/src/lib/timeline-persist.js';

const body = [
  { type: 'assistant', id: 'a0', flatIndex: 0, text: 'x' },
  { type: 'assistant', id: 'a1', flatIndex: 1, text: 'y' },
];

describe('canRestore', () => {
  it('restores when the snapshot head matches the body head', () => {
    assert.equal(canRestore({ headId: 'a0', anchorKey: 'a1', anchorOffset: -120 }, body), true);
  });

  it('refuses when the head differs (earlier pages were lost on reload)', () => {
    assert.equal(canRestore({ headId: 'zz', anchorKey: 'a1', anchorOffset: 0 }, body), false);
  });

  it('refuses on missing snapshot / empty body', () => {
    assert.equal(canRestore(null, body), false);
    assert.equal(canRestore({ headId: 'a0', anchorKey: 'a1', anchorOffset: 0 }, []), false);
    assert.equal(canRestore({ headId: 'a0', anchorKey: 'a1', anchorOffset: 0 }, undefined), false);
  });
});
