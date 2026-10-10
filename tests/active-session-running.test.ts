import type { ChatTab, CursorState } from '../packages/web/src/net/protocol.ts';
import type { PendingSwitch } from '../packages/web/src/store/ui.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  hasRowStatus,
  isActiveSessionWorking,
  isRowWorking,
  isTabRunning,
  viewedTabOf,
} from '../packages/web/src/store/ides.ts';

/**
 * "Is the viewed session running?" prefers the row-level spinner (IDE sidebar ground truth);
 * live activity is only a fallback for this window's active row.
 * Context: switching to a running session can have agentStatus extinguished by copy-staleness
 * while the sidebar spinner is still going; session-row loading / title state must not
 * disappear (2026-09-15 feedback).
 *
 * 2026-09-30: the fallback is also gated on the row having **no** status of its own. On one machine the
 * window-level status sat at `generating` (agentActivityText null, agentActivityLive true) while every tab
 * reported active/idle — the fallback then drew the loading ring on whichever session was being viewed
 * (the ring followed the selection) and kept the composer locked as "会话进行中…" with nothing running.
 * A row that answered must win over the window summary.
 */

function tab(overrides: Partial<ChatTab> = {}): ChatTab {
  return {
    composerId: 'c1',
    title: '会话一',
    isActive: false,
    status: 'idle',
    selectorPath: '',
    windowId: 'w1',
    ...overrides,
  };
}

function stateWith(tabs: ChatTab[], overrides: Partial<CursorState> = {}): CursorState {
  return {
    chatTabs: tabs,
    activeWindowId: 'w1',
    activeComposerId: tabs.find(t => t.isActive)?.composerId ?? '',
    agentStatus: 'idle',
    agentActivityText: null,
    agentActivityLive: false,
    ...overrides,
  } as CursorState;
}

function pending(overrides: Partial<PendingSwitch> = {}): PendingSwitch {
  return {
    commandId: 'cmd-1',
    ide: 'cursor',
    composerId: 'c2',
    windowId: 'w1',
    title: '会话二',
    startedAt: 0,
    ...overrides,
  };
}

describe('isTabRunning', () => {
  it('is true only for the generating row', () => {
    assert.equal(isTabRunning(tab({ status: 'generating' })), true);
    assert.equal(isTabRunning(tab({ status: 'waiting_approval' })), false);
    assert.equal(isTabRunning(tab({ status: 'active' })), false);
    assert.equal(isTabRunning(undefined), false);
  });
});

describe('viewedTabOf', () => {
  const tabs = [
    tab({ composerId: 'c1', title: '一', status: 'generating' }),
    tab({ composerId: 'c2', title: '二', isActive: true }),
  ];

  it('prefers the optimistic switch target', () => {
    assert.equal(viewedTabOf(stateWith(tabs), pending({ composerId: 'c1' }))?.composerId, 'c1');
  });

  it('falls back to the active row', () => {
    assert.equal(viewedTabOf(stateWith(tabs), null)?.composerId, 'c2');
    assert.equal(viewedTabOf(stateWith(tabs), pending({ composerId: 'nope' }))?.composerId, 'c2');
  });
});

describe('isActiveSessionWorking', () => {
  it('is true while the viewed row spins, even when the live status went stale', () => {
    const state = stateWith([tab({ composerId: 'c1', isActive: true, status: 'generating' })], {
      // Long task: copy-staleness extinguished live activity to false/idle, but the sidebar is still spinning
      agentStatus: 'idle',
      agentActivityLive: false,
      agentActivitySource: 'none',
    } as Partial<CursorState>);

    assert.equal(isActiveSessionWorking(state), true);
  });

  it('is true for a running session the optimistic switch is heading to', () => {
    const state = stateWith([
      tab({ composerId: 'c1', isActive: true, status: 'active' }),
      tab({ composerId: 'c2', status: 'generating' }),
    ]);

    assert.equal(isActiveSessionWorking(state, pending({ composerId: 'c2' })), true);
  });

  it('is false for a session that is not running', () => {
    const state = stateWith([
      tab({ composerId: 'c1', isActive: true, status: 'generating' }),
      tab({ composerId: 'c2', status: 'idle' }),
    ]);

    assert.equal(isActiveSessionWorking(state, pending({ composerId: 'c2' })), false);
  });

  it('falls back to the live fields only when the active row has no row-level status', () => {
    const legacyRow = stateWith([tab({ composerId: 'c1', isActive: true, status: undefined as unknown as string })], {
      agentStatus: 'running_tool',
      agentActivityText: '跑命令',
      agentActivityLive: true,
    } as Partial<CursorState>);
    assert.equal(isActiveSessionWorking(legacyRow), true);

    const otherWindowRow = stateWith(
      [tab({ composerId: 'c1', isActive: false, status: undefined as unknown as string, windowId: 'w2' })],
      { agentStatus: 'running_tool', agentActivityLive: true } as Partial<CursorState>,
    );
    assert.equal(isActiveSessionWorking(otherWindowRow), false);
  });

  /*
   * 2026-09-30 (Windows CodeBuddy, captured live off the socket): window-level status generating with
   * agentActivityText null / agentActivityLive true, while every tab reported active/idle. The row-level
   * answer wins — otherwise the input stays locked ("会话进行中…") on a machine where nothing is running.
   */
  it('ignores a stuck window-level generating once the row answered active/idle', () => {
    const state = stateWith([tab({ composerId: 'c1', isActive: true, status: 'active' })], {
      agentStatus: 'generating',
      agentActivityText: null,
      agentActivityLive: true,
      agentActivitySource: 'none',
    } as Partial<CursorState>);

    assert.equal(isActiveSessionWorking(state), false);
  });

  /*
   * Multitask delegation (measured 2026-09-30): the viewed row's spinner only mirrors
   * background sub-agents while the session itself is finished — not "in progress".
   * The input must not be locked for the whole background run.
   */
  it('is false when the active row only mirrors background sub-agents', () => {
    const state = stateWith([
      tab({ composerId: 'c1', isActive: true, status: 'generating', backgroundRunning: true }),
    ]);
    assert.equal(isActiveSessionWorking(state), false);
  });

  it('is false for a background-only row the optimistic switch is heading to', () => {
    const state = stateWith([
      tab({ composerId: 'c1', isActive: true, status: 'active' }),
      tab({ composerId: 'c2', isActive: true, status: 'generating', backgroundRunning: true }),
    ]);
    assert.equal(isActiveSessionWorking(state, pending({ composerId: 'c2' })), false);
  });
});

describe('hasRowStatus', () => {
  it('counts every row status the IDE sends, and only a missing one is "no answer"', () => {
    for (const status of ['active', 'idle', 'generating', 'unread', 'waiting_approval', 'draft'])
      assert.equal(hasRowStatus(tab({ status })), true, status);
    assert.equal(hasRowStatus(tab({ status: undefined as unknown as string })), false);
    assert.equal(hasRowStatus(tab({ status: '' })), false);
    assert.equal(hasRowStatus(undefined), false);
  });
});

describe('isRowWorking (session-row loading ring)', () => {
  /** The same "active row of the active window" notion the caller passes in (row highlight uses it too). */
  const viewingHere = (t: ChatTab, s: CursorState) => t.isActive === true && t.windowId === s.activeWindowId;

  it('rings the row whose own status is generating, whoever is viewing it', () => {
    const running = tab({ status: 'generating', windowId: 'w2' });
    const state = stateWith([running]);
    assert.equal(isRowWorking(running, state, viewingHere(running, state)), true);
  });

  /*
   * The reported bug (2026-09-30): with a stuck window-level generating, the ring moved to whichever row
   * was selected. Every row keeps its own answer, so switching sessions cannot move the ring.
   */
  it('never rings a row that answered active/idle, whatever the window status says', () => {
    const tabs = [
      tab({ composerId: 'c1', title: '会话一', status: 'active', isActive: true }),
      tab({ composerId: 'c2', title: '会话二', status: 'idle' }),
    ];
    const state = stateWith(tabs, {
      agentStatus: 'generating',
      agentActivityText: null,
      agentActivityLive: true,
      agentActivitySource: 'none',
    } as Partial<CursorState>);

    for (const t of tabs)
      assert.equal(isRowWorking(t, state, viewingHere(t, state)), false, t.composerId);
  });

  it('stands in for the row only while that row has no status', () => {
    const legacyRow = tab({ isActive: true, status: undefined as unknown as string });
    const state = stateWith([legacyRow], {
      agentStatus: 'thinking',
      agentActivityLive: true,
    } as Partial<CursorState>);

    assert.equal(isRowWorking(legacyRow, state, viewingHere(legacyRow, state)), true);
    // Live state describes the active window's pane only: it says nothing about another window's row.
    assert.equal(isRowWorking(legacyRow, state, false), false);
  });
});
