import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pillCount } from '../packages/web/src/lib/new-message-pill.js';

describe('pillCount', () => {
  it('accumulates appends while away from the bottom', () => {
    assert.equal(pillCount(0, { type: 'append', n: 3 }), 3);
    assert.equal(pillCount(3, { type: 'append', n: 2 }), 5);
  });

  it('reaching the bottom clears it', () => {
    assert.equal(pillCount(5, { type: 'bottom', atBottom: true }), 0);
  });

  it('leaving the bottom keeps it', () => {
    assert.equal(pillCount(5, { type: 'bottom', atBottom: false }), 5);
  });

  it('explicit seen clears it', () => {
    assert.equal(pillCount(5, { type: 'seen' }), 0);
  });

  it('zero-length append is a no-op', () => {
    assert.equal(pillCount(4, { type: 'append', n: 0 }), 4);
  });
});
