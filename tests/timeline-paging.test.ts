import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PREFETCH_FROM, shouldPageAtTop, shouldPrefetch } from '../packages/web/src/lib/timeline-paging.js';

describe('timeline paging gates', () => {
  const base = { atLoadedHead: false, hasMore: true, userScrolled: true, rangeStart: 50 };

  it('pages at the loaded head with a gesture', () => {
    assert.equal(shouldPageAtTop({ ...base, atLoadedHead: true }), true);
  });

  it('never pages without a user gesture (anti auto-drag)', () => {
    assert.equal(shouldPageAtTop({ ...base, atLoadedHead: true, userScrolled: false }), false);
    assert.equal(shouldPrefetch({ ...base, rangeStart: 0, userScrolled: false }), false);
  });

  it('does not page when there is nothing earlier', () => {
    assert.equal(shouldPageAtTop({ ...base, atLoadedHead: true, hasMore: false }), false);
  });

  it('prefetches when the rendered head approaches the loaded head', () => {
    assert.equal(shouldPrefetch({ ...base, rangeStart: PREFETCH_FROM - 1 }), true);
  });

  it('no prefetch while comfortably away from the head', () => {
    assert.equal(shouldPrefetch({ ...base, rangeStart: PREFETCH_FROM + 5 }), false);
  });

  it('no prefetch when at the head (that is atTop paging, not prefetch)', () => {
    assert.equal(shouldPrefetch({ ...base, rangeStart: 0, atLoadedHead: true }), false);
  });
});
