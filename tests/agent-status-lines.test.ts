import type { AgentLockFile } from '../packages/agent/src/single-instance.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { agentStatusLines } from '../packages/cli/src/daemon/agent-status-lines.js';

function readRepoFile(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf-8');
}

/**
 * The `agent` rows of `lifeline status`.
 *
 * This is the diagnosis surface for the incident (工蜂 Issue #2): a second agent on the machine makes
 * the console show the wrong code, and the person cannot ssh in to find out. The rows are built from
 * the lock file and the local process scan only — no `ps` for the reader, no server request — and the
 * stop hint is exact, because the difference between `lifeline stop` and `kill <pid>` decides whether
 * the reader stops the agent or nothing at all.
 */
const SERVICE_CMD = 'node /Users/x/.lifeline/runtime/lifeline.mjs run';
const REPO_CMD = 'node --import tsx /Users/x/lifeline/packages/agent/src/index.ts';
const LOCK_PATH = '/Users/x/.lifeline/agent.lock';

function lockFile(overrides: Partial<AgentLockFile> = {}): AgentLockFile {
  return {
    pid: 4242,
    agentId: 'machine-test',
    version: '0.1.83',
    remoteUrl: 'https://example.test',
    startedAt: 1_700_000_000_000,
    ...overrides,
  };
}

/** The common case: a lock on disk, and probes for the pid it names. */
function held(overrides: Partial<Parameters<typeof agentStatusLines>[0]> = {}) {
  return {
    lock: { kind: 'ok' as const, lock: lockFile() },
    probe: { alive: true, commandLine: SERVICE_CMD },
    instances: { kind: 'ok' as const, pids: [4242] },
    daemonRunning: true,
    lockPath: LOCK_PATH,
    ...overrides,
  };
}

describe('agentStatusLines', () => {
  it('says no agent holds the lock when the file is absent', () => {
    const lines = agentStatusLines(held({ lock: { kind: 'absent' } }));
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /no agent holds the machine lock/);
  });

  it('says the lock is unreadable, and what the scan makes of it, without inviting a delete', () => {
    const running = agentStatusLines(held({ lock: { kind: 'unreadable' } })).join('\n');
    assert.match(running, /cannot be read/);
    assert.ok(running.includes(LOCK_PATH));
    // A damaged file is not an absent one: while an agent is running, deleting it is the wrong move.
    assert.match(running, /still running — do not delete it/);

    const none = agentStatusLines(held({ lock: { kind: 'unreadable' }, instances: { kind: 'ok', pids: [] } })).join('\n');
    assert.match(none, /cannot be read/);
    assert.match(none, /no agent process is running/);
    assert.doesNotMatch(none, /do not delete/);

    const unknown = agentStatusLines(held({ lock: { kind: 'unreadable' }, instances: { kind: 'unknown' } })).join('\n');
    assert.match(unknown, /scan itself failed/);
    assert.doesNotMatch(unknown, /no agent process is running|do not delete/);
  });

  it('prints the holder and the `lifeline stop` hint when the service holds it', () => {
    const text = agentStatusLines(held()).join('\n');
    assert.match(text, /pid 4242/);
    assert.match(text, /v0\.1\.83/);
    assert.match(text, /machine-test/);
    assert.match(text, /2023-11-14T22:13:20\.000Z/);
    assert.match(text, /stop it with `lifeline stop`/);
    assert.doesNotMatch(text, /kill 4242/);
    // A foreground `start --foreground` has the same command line as the service, and `lifeline stop`
    // does not stop it: reuse the wording `lifeline stop` itself prints instead of inventing a second.
    assert.match(text, /`lifeline start --foreground` or `lifeline run` runs in the foreground/);
  });

  it('names `kill <pid>` for a repo agent, because `lifeline stop` cannot stop it', () => {
    const text = agentStatusLines(held({ probe: { alive: true, commandLine: REPO_CMD } })).join('\n');
    assert.match(text, /kill 4242/);
    assert.doesNotMatch(text, /stop it with `lifeline stop`/);
    // The foreground note belongs to the service hint only: a repo agent is not run by `lifeline stop`.
    assert.doesNotMatch(text, /runs in the foreground/);
  });

  it('names no signal when the holder could not be identified', () => {
    const text = agentStatusLines(held({ probe: { alive: true, commandLine: null } })).join('\n');
    assert.match(text, /could not be read: inspect pid 4242/);
    assert.doesNotMatch(text, /kill 4242/);
    assert.doesNotMatch(text, /lifeline stop/);
  });

  it('marks a dead pid stale and names the file to delete', () => {
    const text = agentStatusLines(held({ probe: { alive: false, commandLine: null } })).join('\n');
    assert.match(text, /stale/);
    assert.match(text, /4242/);
    assert.match(text, /not running/);
    assert.ok(text.includes(LOCK_PATH));
    assert.doesNotMatch(text, /kill 4242/);
  });

  it('marks a live pid that is not an agent stale too', () => {
    const text = agentStatusLines(held({ probe: { alive: true, commandLine: 'node /x/other-service.js' } })).join('\n');
    assert.match(text, /stale/);
    assert.match(text, /running but not a lifeline agent/);
  });

  it('explains that the lock is why a service agent cannot start, and how to stop the holder', () => {
    const blocked = agentStatusLines(held({ daemonRunning: false })).join('\n');
    assert.match(blocked, /why a service agent cannot start/);
    assert.match(blocked, /`lifeline stop`|`kill 4242`/);

    // Running daemon: nothing to explain, no extra row.
    const normal = agentStatusLines(held()).join('\n');
    assert.doesNotMatch(normal, /why a service agent cannot start/);
  });

  it('warns about duplicates only when more than one agent instance is running', () => {
    const two = agentStatusLines(held({ instances: { kind: 'ok', pids: [4242, 777] } })).join('\n');
    assert.match(two, /2 agent processes are running: 4242, 777/);
    assert.match(two, /registered last/);

    const one = agentStatusLines(held({ instances: { kind: 'ok', pids: [4242] } })).join('\n');
    assert.doesNotMatch(one, /registered last/);

    // A scan that could not read the process list is not "no duplicates".
    const unknown = agentStatusLines(held({ instances: { kind: 'unknown' } })).join('\n');
    assert.doesNotMatch(unknown, /registered last/);
  });

  it('never renders an empty line, and never lets a lock value or the path break a row', () => {
    // The path is sanitized in the same pass as the values, so it needs its own crafted input:
    // every *other* case here uses a clean `LOCK_PATH`, which would keep this green without `oneLine`.
    const craftedPath = '/Users/x/.lifeline/\nagent.lock';
    const rowSets = [
      agentStatusLines(held({
        lock: { kind: 'ok', lock: lockFile({ agentId: 'a\n[agent] FAKE', version: '1\n2' }) },
        lockPath: craftedPath,
      })),
      agentStatusLines(held({ lock: { kind: 'unreadable' }, lockPath: craftedPath })),
      agentStatusLines(held({ probe: { alive: false, commandLine: null }, lockPath: craftedPath })),
    ];
    for (const lines of rowSets) {
      assert.ok(lines.length > 0, 'every state prints at least one row');
      for (const line of lines) {
        assert.ok(line.trim().length > 0, 'status rows are never empty');
        assert.ok(!/[\n\r\u2028\u2029]/.test(line), 'a lock value or path must not break the row structure');
      }
    }
    // Sanitized, not dropped: the reader still has to be able to find the file.
    assert.match(rowSets[1]!.join('\n'), /agent\.lock/);
  });
});

/**
 * The wiring, asserted as text (the same approach as `tests/agent-startup-order.test.ts`): the pure
 * module cannot run a probe by construction, and `lifeline status` must not grow a new request.
 */
describe('agent status wiring', () => {
  it('keeps every probe out of the pure module', () => {
    const module = readRepoFile('../packages/cli/src/daemon/agent-status-lines.ts');
    for (const probe of ['daemonProbe(', 'scanAgentPids(', 'processCommandLine(', 'pidAlive(']) {
      assert.ok(
        !module.includes(probe),
        `${probe} must stay in the caller — the module is pure by construction`,
      );
    }
    assert.ok(!module.includes('/healthz'), 'the module must not know about the server');
    // The foreground note is *reused*, not restated: an identical literal here would stay green while
    // silently drifting from `stop.ts` the next time that wording changes.
    assert.match(module, /STOP_NOTE_FOREGROUND/);
    assert.ok(!module.includes('runs in the foreground'), 'import the note, do not copy its text');
  });

  it('feeds it the probes, probes lazily, and adds no request', () => {
    const status = readRepoFile('../packages/cli/src/commands/status.ts');
    const at = status.indexOf('agentStatusLines({');
    assert.notEqual(at, -1, 'status.ts must print the agent rows');
    const end = status.indexOf('log(line)', at);
    assert.notEqual(end, -1, 'the rows must be printed');
    const block = status.slice(at, end);
    assert.match(block, /instances: scanAgentPids\(\)/);
    assert.match(block, /daemonRunning: daemon\.running/);
    assert.match(block, /lockPath,/);
    // One variable for both the read and the row: the file we read and the file the row tells the
    // reader to delete have to be the same one.
    assert.match(status, /const lockPath = agentLockPath\(\)/);
    assert.match(status, /readAgentLock\(lockPath\)/);
    // `processCommandLine` spawns `ps` (a CIM query on Windows): it must not run for a dead pid.
    assert.match(block, /commandLine: holderAlive/);
    assert.ok(!block.includes('fetch('), 'the agent rows must not need the server');
    // Exactly the one pre-existing health check: a diagnosis command that grows requests stops
    // working exactly when the reader needs it (server down, network broken).
    assert.equal([...status.matchAll(/\bfetch\(/g)].length, 1, 'no request beyond the health check');
  });
});
