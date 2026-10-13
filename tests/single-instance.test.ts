import type { AgentLockFile } from '../packages/agent/src/single-instance.js';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  acquireAgentLock,
  agentLockPath,
  decideLock,
  formatLockRefusal,
  readAgentLock,
  releaseAgentLock,
} from '../packages/agent/src/single-instance.js';
import { CONFIG_DIR } from '../packages/cli/src/config.js';

const sandbox = mkdtempSync(join(tmpdir(), 'lifeline-lock-'));
after(() => rmSync(sandbox, { recursive: true, force: true }));

let seq = 0;
function lockPath(): string {
  seq += 1;
  return join(sandbox, `agent-${seq}.lock`);
}

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

const AGENT_CMD = 'node /repo/packages/agent/src/index.ts';
const NOT_AGENT_CMD = 'node /repo/scripts/probe.ts';
const OUR_PID = 999_001;

/**
 * File modes are not enforced on Windows, and a privileged run ignores them.
 * The repo rule is "skip and explain, never silently pass" (`tests/ps1-ast.test.ts`).
 */
const modeEnforced = process.platform !== 'win32' && process.getuid?.() !== 0;
const modeSkip = modeEnforced ? false : 'file modes are not enforced here (win32 / root)';

const baseInput = {
  agentId: 'machine-test',
  version: '0.1.83',
  remoteUrl: 'https://example.test',
  pid: OUR_PID,
  now: () => 1_700_000_500_000,
};

describe('decideLock', () => {
  it('acquires when there is no lock file', () => {
    assert.equal(
      decideLock({ lock: null, readable: true, alive: false, commandLine: 'unknown', scan: 'none' }),
      'acquire',
    );
  });

  it('acquires over a stale holder: dead pid, or a live pid that is not an agent', () => {
    assert.equal(
      decideLock({ lock: lockFile(), readable: true, alive: false, commandLine: 'agent', scan: 'none' }),
      'acquire',
    );
    assert.equal(
      decideLock({ lock: lockFile(), readable: true, alive: true, commandLine: 'not-agent', scan: 'none' }),
      'acquire',
    );
  });

  it('refuses a live agent holder, and refuses when its command line cannot be read', () => {
    assert.equal(
      decideLock({ lock: lockFile(), readable: true, alive: true, commandLine: 'agent', scan: 'none' }),
      'refuse',
    );
    assert.equal(
      decideLock({ lock: lockFile(), readable: true, alive: true, commandLine: 'unknown', scan: 'none' }),
      'refuse',
    );
  });

  it('treats an unreadable file as held: a damaged lock is not an empty slot', () => {
    assert.equal(
      decideLock({ lock: null, readable: false, alive: false, commandLine: 'unknown', scan: 'some' }),
      'refuse',
    );
    assert.equal(
      decideLock({ lock: null, readable: false, alive: false, commandLine: 'unknown', scan: 'unknown' }),
      'refuse',
    );
    assert.equal(
      decideLock({ lock: null, readable: false, alive: false, commandLine: 'unknown', scan: 'none' }),
      'acquire',
    );
  });
});

describe('readAgentLock', () => {
  it('separates absent, ok and unreadable', () => {
    const path = lockPath();
    assert.equal(readAgentLock(path).kind, 'absent');

    writeFileSync(path, JSON.stringify(lockFile()));
    const ok = readAgentLock(path);
    assert.equal(ok.kind, 'ok');
    assert.equal(ok.lock.pid, 4242);

    writeFileSync(path, '{"pid": 42');
    assert.equal(readAgentLock(path).kind, 'unreadable');

    writeFileSync(path, JSON.stringify({ pid: 'not-a-number' }));
    assert.equal(readAgentLock(path).kind, 'unreadable');
  });

  it('treats an unrepresentable timestamp as a damaged file, not an old one', () => {
    const infinite = lockPath();
    writeFileSync(infinite, '{"pid":4242,"agentId":"x","version":"1","remoteUrl":"u","startedAt":1e999}');
    assert.equal(readAgentLock(infinite).kind, 'unreadable');

    const outOfRange = lockPath();
    writeFileSync(outOfRange, JSON.stringify({ ...lockFile(), startedAt: 9e15 }));
    assert.equal(readAgentLock(outOfRange).kind, 'unreadable');

    const refused = acquireAgentLock({
      ...baseInput,
      path: outOfRange,
      scanAgents: () => 'some',
      alive: () => false,
      commandLineOf: () => null,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.ok ? undefined : refused.unreadable, true);

    const taken = acquireAgentLock({
      ...baseInput,
      path: outOfRange,
      scanAgents: () => 'none',
      alive: () => false,
      commandLineOf: () => null,
    });
    assert.equal(taken.ok, true);
  });

  it('treats a file it cannot read as unreadable, never as absent', { skip: modeSkip }, () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify(lockFile()));
    chmodSync(path, 0o000);
    try {
      assert.equal(readAgentLock(path).kind, 'unreadable');
      const refused = acquireAgentLock({
        ...baseInput,
        path,
        scanAgents: () => 'some',
        alive: () => false,
        commandLineOf: () => null,
      });
      assert.equal(refused.ok, false);
      assert.equal(refused.ok ? undefined : refused.unreadable, true);
      const taken = acquireAgentLock({
        ...baseInput,
        path,
        scanAgents: () => 'none',
        alive: () => false,
        commandLineOf: () => null,
      });
      assert.equal(taken.ok, true);
    }
    finally {
      chmodSync(path, 0o600);
    }
  });
});

describe('agentLockPath', () => {
  it('lives in the lifeline home directory both the service and a repo agent resolve', () => {
    assert.equal(agentLockPath(), join(CONFIG_DIR, 'agent.lock'));
  });
});

describe('acquireAgentLock', () => {
  it('creates the lock with our identity', () => {
    const path = lockPath();
    const result = acquireAgentLock({
      ...baseInput,
      path,
      scanAgents: () => 'none',
      alive: () => false,
      commandLineOf: () => null,
    });
    assert.equal(result.ok, true);
    const written = JSON.parse(readFileSync(path, 'utf-8')) as AgentLockFile;
    assert.equal(written.pid, OUR_PID);
    assert.equal(written.agentId, 'machine-test');
    assert.equal(written.version, '0.1.83');
    assert.equal(written.remoteUrl, 'https://example.test');
    assert.equal(written.startedAt, 1_700_000_500_000);
  });

  it('takes over a lock that names this very pid even when the holder looks like an agent', () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify(lockFile({ pid: process.pid, agentId: 'machine-dead' })));
    // Explicit seams on purpose: without the self-pid rule this holder (alive + agent command line)
    // would be refused, and the refusal would name this very process as the holder. The real default
    // probes cannot express that state from inside a test runner.
    const result = acquireAgentLock({
      ...baseInput,
      path,
      pid: process.pid,
      scanAgents: () => 'some',
      alive: () => true,
      commandLineOf: () => AGENT_CMD,
    });
    assert.equal(result.ok, true);
    assert.equal((JSON.parse(readFileSync(path, 'utf-8')) as AgentLockFile).agentId, 'machine-test');
  });

  it('takes over a self-pid lock whose command line cannot be read', () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify(lockFile({ pid: process.pid, agentId: 'machine-dead' })));
    const result = acquireAgentLock({
      ...baseInput,
      path,
      pid: process.pid,
      scanAgents: () => 'some',
      alive: () => true,
      commandLineOf: () => null,
    });
    assert.equal(result.ok, true);
  });

  it('refuses a live agent holder and leaves the file byte-identical', () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify(lockFile()));
    const before = readFileSync(path, 'utf-8');

    const result = acquireAgentLock({
      ...baseInput,
      path,
      scanAgents: () => 'some',
      alive: () => true,
      commandLineOf: () => AGENT_CMD,
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.holder?.pid, 4242);
    assert.equal(readFileSync(path, 'utf-8'), before);
  });

  it('takes over a dead holder', () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify(lockFile()));
    const result = acquireAgentLock({
      ...baseInput,
      path,
      scanAgents: () => 'none',
      alive: () => false,
      commandLineOf: () => null,
    });
    assert.equal(result.ok, true);
    assert.equal((JSON.parse(readFileSync(path, 'utf-8')) as AgentLockFile).pid, OUR_PID);
  });

  it('takes over a live pid that is not an agent (pid reuse)', () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify(lockFile()));
    const result = acquireAgentLock({
      ...baseInput,
      path,
      scanAgents: () => 'some',
      alive: () => true,
      commandLineOf: () => NOT_AGENT_CMD,
    });
    assert.equal(result.ok, true);
  });

  it('refuses when the holder is alive but its command line cannot be read', () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify(lockFile()));
    const result = acquireAgentLock({
      ...baseInput,
      path,
      scanAgents: () => 'some',
      alive: () => true,
      commandLineOf: () => null,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.holder?.pid, 4242);
    // Unreadable holder: the refusal must not name a way to signal it, so the tri-state stays open.
    assert.equal(result.ok ? undefined : result.holderIsService, undefined);
  });

  it('reports whether the holder is the service, so the refusal hint is exact', () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify(lockFile()));

    const service = acquireAgentLock({
      ...baseInput,
      path,
      scanAgents: () => 'some',
      alive: () => true,
      commandLineOf: () => 'node /Users/x/.lifeline/runtime/lifeline.mjs run',
    });
    assert.equal(service.ok ? undefined : service.holderIsService, true);

    const repo = acquireAgentLock({
      ...baseInput,
      path,
      scanAgents: () => 'some',
      alive: () => true,
      commandLineOf: () => AGENT_CMD,
    });
    assert.equal(repo.ok ? undefined : repo.holderIsService, false);
  });

  it('takes over an unreadable file when nothing is alive, and refuses when something is', () => {
    const free = lockPath();
    writeFileSync(free, 'not json');
    const acquired = acquireAgentLock({
      ...baseInput,
      path: free,
      scanAgents: () => 'none',
      alive: () => false,
      commandLineOf: () => null,
    });
    assert.equal(acquired.ok, true);

    const held = lockPath();
    writeFileSync(held, 'not json');
    const refused = acquireAgentLock({
      ...baseInput,
      path: held,
      scanAgents: () => 'some',
      alive: () => false,
      commandLineOf: () => null,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.ok ? undefined : refused.unreadable, true);
    assert.equal(readFileSync(held, 'utf-8'), 'not json');
  });

  it('re-evaluates an EEXIST race instead of overwriting a live holder', () => {
    const path = lockPath();
    const result = acquireAgentLock({
      ...baseInput,
      path,
      scanAgents: () => 'some',
      alive: () => true,
      commandLineOf: () => AGENT_CMD,
      seams: { beforeCreate: () => writeFileSync(path, JSON.stringify(lockFile({ pid: 777 }))) },
    });
    assert.equal(result.ok, false);
    assert.equal((JSON.parse(readFileSync(path, 'utf-8')) as AgentLockFile).pid, 777);
  });

  it('takes over an EEXIST file whose holder is stale', () => {
    const path = lockPath();
    let wroteOnce = false;
    const result = acquireAgentLock({
      ...baseInput,
      path,
      scanAgents: () => 'none',
      alive: () => false,
      commandLineOf: () => null,
      seams: {
        beforeCreate: () => {
          if (wroteOnce)
            return;
          wroteOnce = true;
          writeFileSync(path, JSON.stringify(lockFile({ pid: 777 })));
        },
      },
    });
    assert.equal(result.ok, true);
    assert.equal((JSON.parse(readFileSync(path, 'utf-8')) as AgentLockFile).pid, OUR_PID);
  });

  it('does not unlink a file that changed since the decision (re-read before unlink)', () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify(lockFile({ pid: 777 })));
    let alive = false;
    const result = acquireAgentLock({
      ...baseInput,
      path,
      scanAgents: () => 'some',
      alive: () => alive,
      commandLineOf: () => AGENT_CMD,
      seams: {
        beforeUnlink: () => {
          alive = true;
          writeFileSync(path, JSON.stringify(lockFile({ pid: 888 })));
        },
      },
    });
    assert.equal(result.ok, false);
    assert.equal((JSON.parse(readFileSync(path, 'utf-8')) as AgentLockFile).pid, 888);
  });

  it('does not unlink a lock whose holder only re-stamped its start time', () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify(lockFile({ pid: 777, startedAt: 1_000 })));
    let alive = false;
    const result = acquireAgentLock({
      ...baseInput,
      path,
      scanAgents: () => 'some',
      alive: () => alive,
      commandLineOf: () => AGENT_CMD,
      seams: {
        beforeUnlink: () => {
          alive = true;
          writeFileSync(path, JSON.stringify(lockFile({ pid: 777, startedAt: 2_000 })));
        },
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.holder?.startedAt, 2_000);
    assert.equal((JSON.parse(readFileSync(path, 'utf-8')) as AgentLockFile).startedAt, 2_000);
  });

  it('reports notOwned when the read-back shows another pid, and does not unlink it', () => {
    const path = lockPath();
    const result = acquireAgentLock({
      ...baseInput,
      path,
      scanAgents: () => 'none',
      alive: () => false,
      commandLineOf: () => null,
      seams: { afterCreate: () => writeFileSync(path, JSON.stringify(lockFile({ pid: 555 }))) },
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.notOwned, true);
    assert.equal((JSON.parse(readFileSync(path, 'utf-8')) as AgentLockFile).pid, 555);
  });
});

describe('acquireAgentLock failure reporting', () => {
  it('reports an error instead of throwing when the lock path cannot be created', () => {
    const blocker = join(sandbox, 'blocker');
    writeFileSync(blocker, 'not a directory');
    const result = acquireAgentLock({
      ...baseInput,
      path: join(blocker, 'agent.lock'),
      scanAgents: () => 'none',
      alive: () => false,
      commandLineOf: () => null,
    });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error ?? '', /cannot create/);
  });

  it('gives up with an explanation when the lock file keeps changing', () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify(lockFile({ pid: 777 })));
    let rewrite = 700;
    const result = acquireAgentLock({
      ...baseInput,
      path,
      scanAgents: () => 'none',
      alive: () => false,
      commandLineOf: () => null,
      seams: {
        beforeUnlink: () => {
          rewrite += 1;
          writeFileSync(path, JSON.stringify(lockFile({ pid: rewrite })));
        },
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error ?? '', /kept changing/);
    assert.equal(existsSync(path), true);
  });

  it('creates a missing lock directory instead of failing (env-only run)', () => {
    const path = join(sandbox, 'nested', 'deeper', 'agent.lock');
    const result = acquireAgentLock({
      ...baseInput,
      path,
      scanAgents: () => 'none',
      alive: () => false,
      commandLineOf: () => null,
    });
    assert.equal(result.ok, true);
    assert.equal(existsSync(path), true);
  });

  it('reports the write error when the lock file itself cannot be written', { skip: modeSkip }, () => {
    const dir = join(sandbox, 'readonly');
    mkdirSync(dir);
    chmodSync(dir, 0o500);
    try {
      const result = acquireAgentLock({
        ...baseInput,
        path: join(dir, 'agent.lock'),
        scanAgents: () => 'none',
        alive: () => false,
        commandLineOf: () => null,
      });
      assert.equal(result.ok, false);
      assert.match(result.ok ? '' : result.error ?? '', /cannot write/);
    }
    finally {
      chmodSync(dir, 0o700);
    }
  });

  it('reports a removal failure as such, not as "the file kept changing"', { skip: modeSkip }, () => {
    const dir = join(sandbox, 'ro-unlink');
    mkdirSync(dir);
    const path = join(dir, 'agent.lock');
    writeFileSync(path, JSON.stringify(lockFile({ pid: 777 })));
    chmodSync(dir, 0o500);
    try {
      const result = acquireAgentLock({
        ...baseInput,
        path,
        scanAgents: () => 'none',
        alive: () => false,
        commandLineOf: () => null,
      });
      assert.equal(result.ok, false);
      const error = result.ok ? '' : result.error ?? '';
      assert.match(error, /cannot remove/);
      assert.doesNotMatch(error, /kept changing/);
    }
    finally {
      chmodSync(dir, 0o700);
    }
  });
});

describe('releaseAgentLock', () => {
  it('removes our own lock, leaves another pid\'s lock, and tolerates a missing file', () => {
    const mine = lockPath();
    writeFileSync(mine, JSON.stringify(lockFile({ pid: OUR_PID })));
    releaseAgentLock(mine, OUR_PID);
    assert.equal(existsSync(mine), false);

    const theirs = lockPath();
    writeFileSync(theirs, JSON.stringify(lockFile({ pid: 4242 })));
    releaseAgentLock(theirs, OUR_PID);
    assert.equal(existsSync(theirs), true);

    releaseAgentLock(lockPath(), OUR_PID);
  });
});

describe('formatLockRefusal', () => {
  const identity = { pid: 4242, agentId: 'machine-test', version: '0.1.83', remoteUrl: 'https://example.test' };
  const path = '/home/x/.lifeline/agent.lock';

  it('names the holder, the way out and the lock file, and never renders an empty line', () => {
    const lines = formatLockRefusal({
      result: { ok: false, holder: lockFile(), holderIsService: true },
      identity,
      lockPath: path,
    });
    const text = lines.join('\n');
    assert.ok(lines.length >= 3);
    for (const line of lines)
      assert.ok(line.trim().length > 0, 'refusal lines must never be empty');
    assert.match(lines[0], /pid=4242/);
    assert.match(lines[0], /agentId=machine-test/);
    assert.match(lines[0], /v0\.1\.83/);
    assert.match(lines[0], /remote=https:\/\/example\.test/);
    assert.match(text, /holder pid 4242 · v0\.1\.83 · machine-test/);
    assert.match(text, /started 2023-11-14T22:13:20\.000Z/);
    assert.match(text, /stop it with `lifeline stop`/);
    assert.ok(text.includes(path));
  });

  it('tells a repo holder apart: `kill <pid>`, because `lifeline stop` cannot stop it', () => {
    const text = formatLockRefusal({
      result: { ok: false, holder: lockFile({ pid: 777 }), holderIsService: false },
      identity,
      lockPath: path,
    }).join('\n');
    assert.match(text, /kill 777/);
    assert.doesNotMatch(text, /stop it with `lifeline stop`/);
  });

  it('does not name a signal for a holder it could not identify', () => {
    const text = formatLockRefusal({
      result: { ok: false, holder: lockFile({ pid: 777 }) },
      identity,
      lockPath: path,
    }).join('\n');
    assert.match(text, /could not be read: inspect pid 777/);
    assert.doesNotMatch(text, /kill 777/);
    assert.doesNotMatch(text, /lifeline stop/);
  });

  it('does not tell the reader to kill the stale record a failed take-over left behind', () => {
    const text = formatLockRefusal({
      result: { ok: false, holder: lockFile({ pid: 777 }), holderIsService: false, error: 'cannot remove /x: EPERM' },
      identity,
      lockPath: path,
    }).join('\n');
    assert.match(text, /still names pid 777, which is not the agent holding this machine/);
    assert.match(text, /cannot remove \/x: EPERM/);
    assert.doesNotMatch(text, /kill 777/);
    assert.doesNotMatch(text, /lifeline stop/);
    assert.doesNotMatch(text, /another Lifeline agent holds this machine/);
  });

  it('renders the unreadable, notOwned and error forms without claiming a holder', () => {
    const forms = [
      { ok: false, unreadable: true },
      { ok: false, notOwned: true },
      { ok: false, error: 'cannot write /x/agent.lock: EACCES' },
    ] as const;
    const rendered = forms.map(result => formatLockRefusal({ result, identity, lockPath: path }));
    assert.match(rendered[0]!.join('\n'), /cannot be read/);
    assert.match(rendered[1]!.join('\n'), /another process created the lock/);
    assert.match(rendered[2]!.join('\n'), /cannot write \/x\/agent\.lock: EACCES/);
    for (const lines of rendered) {
      for (const line of lines)
        assert.ok(line.trim().length > 0, 'refusal lines must never be empty');
      assert.doesNotMatch(lines[0]!, /another Lifeline agent holds this machine/);
    }
  });

  it('never throws on an unrepresentable holder timestamp', () => {
    const finite = formatLockRefusal({
      result: { ok: false, holder: lockFile({ startedAt: 9e15 }), holderIsService: false },
      identity,
      lockPath: path,
    }).join('\n');
    assert.match(finite, /unreadable \(9000000000000000\)/);

    const infinite = formatLockRefusal({
      result: { ok: false, holder: lockFile({ startedAt: Number.POSITIVE_INFINITY }), holderIsService: false },
      identity,
      lockPath: path,
    }).join('\n');
    assert.match(infinite, /unreadable \(Infinity\)/);
  });

  it('keeps a crafted agentId or version from forging a log line', () => {
    const benign = formatLockRefusal({
      result: { ok: false, holder: lockFile({ pid: 777 }), holderIsService: false },
      identity,
      lockPath: path,
    });
    const lines = formatLockRefusal({
      result: {
        ok: false,
        holder: lockFile({ agentId: 'a\u2028b\n[agent] FAKE', version: '1\n2' }),
        holderIsService: false,
      },
      identity: { ...identity, agentId: 'x\ny' },
      lockPath: path,
    });
    // Relative to a benign run, so a legitimate copy change does not trip this test.
    assert.equal(lines.length, benign.length);
    for (const line of lines)
      assert.ok(!/[\n\r\u2028\u2029]/.test(line), 'a value must not be able to break the line structure');
  });
});
