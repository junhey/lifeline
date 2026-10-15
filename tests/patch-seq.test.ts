import type { AgentSocket } from '../packages/server/src/agent-hub.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { PatchSequencer } from '../packages/agent/src/patch-sequencer.js';
import { SYNC_REASON_PATCH_GAP } from '../packages/protocol/src/index.js';
import { AgentDirectory } from '../packages/server/src/agent-hub.js';
import { IdentityStore } from '../packages/server/src/identity-store.js';
import { emptyCursorState } from '../packages/server/src/pages/empty-state.js';

function fakeSocket(id: string): AgentSocket & { events: Array<[string, unknown[]]> } {
  const events: Array<[string, unknown[]]> = [];
  return {
    id,
    connected: true,
    events,
    emit(event: string, ...args: unknown[]) {
      events.push([event, args]);
    },
  };
}

function syncs(s: { events: Array<[string, unknown[]]> }): unknown[][] {
  return s.events.filter(e => e[0] === 'agent:sync').map(e => e[1]);
}

describe('PatchSequencer (agent side)', () => {
  it('numbers patches per IDE, starting at 1', () => {
    const seq = new PatchSequencer('e1');
    assert.deepEqual(seq.stamp('cursor', { agentStatus: 'idle' }), {
      ide: 'cursor',
      patch: { agentStatus: 'idle' },
      seq: 1,
      epoch: 'e1',
    });
    assert.equal(seq.stamp('cursor', {}).seq, 2);
    assert.equal(seq.stamp('codebuddy', {}).seq, 1);
  });

  it('baseline reports what full state already contains; epoch differs per process', () => {
    const seq = new PatchSequencer();
    seq.stamp('cursor', {});
    seq.stamp('cursor', {});
    assert.deepEqual(seq.baseline().seqs, { cursor: 2 });
    assert.notEqual(new PatchSequencer().epoch, seq.epoch);
  });
});

describe('AgentDirectory patch gap detection', () => {
  let dir: string;
  let store: IdentityStore;
  let d: AgentDirectory;
  let clock = 0;

  const connect = (id = 'sa') => {
    const sock = fakeSocket(id);
    d.register(sock, { agentId: 'agent-a', hostname: 'A' });
    sock.events.length = 0; // drop the register-time sync; we only look at gap syncs
    return sock;
  };
  const full = (sock: AgentSocket, seq: PatchSequencer) =>
    d.applyFull(sock, { ides: { cursor: { ...emptyCursorState(), connected: true } }, patchSeq: seq.baseline() });
  const patch = (sock: AgentSocket, seq: PatchSequencer, ide: 'cursor' | 'codebuddy' = 'cursor', body = {}) =>
    d.applyPatch(sock, seq.stamp(ide, body));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-seq-'));
    store = new IdentityStore(join(dir, 'identity.sqlite'));
    clock = 1_000;
    d = new AgentDirectory(store, { persistDebounceMs: 0, now: () => clock });
  });

  afterEach(() => {
    d.dispose();
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('stays quiet while patches arrive in order (including the first one after a full)', () => {
    const sock = connect();
    const seq = new PatchSequencer();
    seq.stamp('cursor', {}); // patch sent before the full, already reflected in its baseline
    full(sock, seq);
    for (let i = 0; i < 5; i++) patch(sock, seq);
    patch(sock, seq, 'codebuddy'); // an IDE with no patches yet starts from baseline 0
    assert.deepEqual(syncs(sock), []);
  });

  it('asks for a full state on a hole, and the full state repairs a stale field', () => {
    const sock = connect();
    const seq = new PatchSequencer();
    full(sock, seq);
    patch(sock, seq, 'cursor', { agentStatus: 'generating' });
    seq.stamp('cursor', { agentStatus: 'idle' }); // lost in transit: never reaches the server
    patch(sock, seq, 'cursor', { agentActivityText: 'x' });

    assert.deepEqual(syncs(sock), [[{ reason: SYNC_REASON_PATCH_GAP }]]);
    assert.equal(d.getState('agent-a')?.ides.cursor?.agentStatus, 'generating'); // the stuck value

    // Agent answers the sync with a fresh full state carrying the correct value and baseline.
    d.applyFull(sock, {
      ides: { cursor: { ...emptyCursorState(), agentStatus: 'idle' } },
      patchSeq: seq.baseline(),
    });
    assert.equal(d.getState('agent-a')?.ides.cursor?.agentStatus, 'idle');
    clock += 60_000;
    patch(sock, seq);
    assert.equal(syncs(sock).length, 1, 'no extra sync once healed');
  });

  it('does not sync-storm: one request per cooldown while still desynced', () => {
    const sock = connect();
    const seq = new PatchSequencer();
    full(sock, seq);
    seq.stamp('cursor', {}); // lost
    patch(sock, seq);
    patch(sock, seq);
    patch(sock, seq);
    assert.equal(syncs(sock).length, 1);

    // Agent never answered (e.g. full got lost too): retry after the cooldown, on the next patch.
    clock += 11_000;
    patch(sock, seq);
    assert.equal(syncs(sock).length, 2);
  });

  it('treats an epoch change (agent restart) as a gap, and re-anchors afterwards', () => {
    const sock = connect();
    full(sock, new PatchSequencer('old'));
    const restarted = new PatchSequencer('new');
    patch(sock, restarted);
    assert.equal(syncs(sock).length, 1);
    patch(sock, restarted);
    assert.equal(syncs(sock).length, 1, 'one restart warns once');
  });

  it('a patch with no baseline at all requests sync once', () => {
    const sock = connect();
    patch(sock, new PatchSequencer());
    assert.equal(syncs(sock).length, 1);
  });

  it('keeps old behavior for agents that send no seq', () => {
    const sock = connect();
    d.applyFull(sock, { ides: { cursor: emptyCursorState() } });
    d.applyPatch(sock, { ide: 'cursor', patch: { agentStatus: 'generating' } });
    d.applyPatch(sock, { agentStatus: 'idle' }); // legacy bare patch
    assert.deepEqual(syncs(sock), []);
    assert.equal(d.getState('agent-a')?.ides.cursor?.agentStatus, 'idle');
  });

  it('a re-registered socket starts from a clean line', () => {
    const first = connect('s1');
    const seq = new PatchSequencer();
    full(first, seq);
    const second = connect('s2'); // takeover: the old baseline must not judge the new socket
    patch(second, new PatchSequencer('other'));
    assert.equal(syncs(second).length, 1); // no baseline until its full arrives
    full(second, seq);
    patch(second, seq);
    assert.equal(syncs(second).length, 1);
  });
});
