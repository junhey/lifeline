import type { ChatTab, CursorState } from '../packages/web/src/net/protocol.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { viewedLiveKeyOf } from '../packages/web/src/store/ides.js';

function tab(composerId: string, extra: Partial<ChatTab> = {}): ChatTab {
  return {
    composerId,
    title: 't',
    isActive: true,
    status: 'idle',
    selectorPath: '#x',
    windowId: 'w',
    ...extra,
  } as ChatTab;
}

function state(activeComposerId?: string, chatTabs: ChatTab[] = []): CursorState {
  return { connected: true, activeWindowId: 'w', activeComposerId, chatTabs } as CursorState;
}

describe('viewedLiveKeyOf', () => {
  it('optimistic pending with a real id wins', () => {
    assert.equal(
      viewedLiveKeyOf('cursor', state('old-id'), { ide: 'cursor', composerId: 'target-id', windowId: 'w' } as never),
      'cursor:target-id',
    );
  });

  it('pending for another IDE is ignored', () => {
    assert.equal(
      viewedLiveKeyOf('cursor', state('active-id'), { ide: 'codebuddy', composerId: 'x', windowId: 'w' } as never),
      'cursor:active-id',
    );
  });

  it('synthetic active id → empty key', () => {
    assert.equal(viewedLiveKeyOf('cursor', state('tab-3')), '');
  });

  it('active draft tab → empty key (no body belongs to a draft)', () => {
    assert.equal(viewedLiveKeyOf('cursor', state(undefined, [tab('tab-0', { isDraft: true })])), '');
  });

  it('no pending, real active id → ide:id', () => {
    assert.equal(viewedLiveKeyOf('codebuddy', state('abc')), 'codebuddy:abc');
  });

  it('state undefined → empty key (IDE never connected)', () => {
    assert.equal(viewedLiveKeyOf('cursor', undefined), '');
  });

  it('synthetic pending id falls through to the active tab (draft-click path, no draft tab present)', () => {
    assert.equal(
      viewedLiveKeyOf('cursor', state('active-id'), { ide: 'cursor', composerId: 'tab-0', windowId: 'w' } as never),
      'cursor:active-id',
    );
  });
});
