import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ancestorPidsFromRows,
  commandLineIsLifelineAgent,
  commandLineIsRunningAgent,
  parseWindowsLifelineProcs,
  runningAgentPids,
  unixProcessListArgs,
} from '../packages/cli/src/daemon/agent-processes.js';

describe('commandLineIsRunningAgent', () => {
  const entry = '/Users/x/.lifeline/runtime/lifeline.mjs';

  it('treats lifeline.mjs update as not an agent', () => {
    assert.equal(commandLineIsRunningAgent(`node ${entry} update`), false);
    assert.equal(commandLineIsRunningAgent(`node ${entry} daemon`), false);
    assert.equal(commandLineIsRunningAgent(`node ${entry} status`), false);
    assert.equal(commandLineIsRunningAgent(`node ${entry} setup`), false);
    assert.equal(commandLineIsRunningAgent(`node ${entry} uninstall`), false);
  });

  it('treats lifeline.mjs start and lifeline.mjs run as agents', () => {
    assert.equal(commandLineIsRunningAgent(`node ${entry} start`), true);
    assert.equal(commandLineIsRunningAgent(`node ${entry} run`), true);
  });

  it('treats start --foreground as an agent', () => {
    assert.equal(commandLineIsRunningAgent(`node ${entry} start --foreground`), true);
  });

  it('does not treat a runtime substring as run', () => {
    assert.equal(commandLineIsRunningAgent(`node ${entry} runtime`), false);
    assert.equal(commandLineIsRunningAgent(`node ${entry} runner`), false);
    assert.equal(commandLineIsRunningAgent('/opt/runtime/node /opt/runtime/lifeline.mjs update'), false);
    assert.equal(
      commandLineIsRunningAgent('"C:\\Users\\A B\\.lifeline\\runtime\\node.exe" "C:\\Users\\A B\\.lifeline\\runtime\\lifeline.mjs" runtime'),
      false,
    );
  });

  it('recognizes the quoted shim and supervisor command lines, including a path with a space', () => {
    // install.ps1 shim: a quoted path ending in lifeline.mjs, then the arguments.
    const shim = '"C:\\Users\\x\\.lifeline\\runtime\\node.exe" "C:\\Users\\x\\.lifeline\\runtime\\lifeline.mjs" start';
    // win-daemon.ts supervisor: the mjs path is quoted, then `run`. The user path contains a space.
    const supervisor = '"C:\\Program Files\\node.exe" "C:\\Users\\A B\\.lifeline\\runtime\\lifeline.mjs" run';
    const quotedUpdate = '"C:\\Program Files\\node.exe" "C:\\Users\\A B\\.lifeline\\runtime\\lifeline.mjs" update';
    assert.equal(commandLineIsRunningAgent(shim), true);
    assert.equal(commandLineIsRunningAgent(supervisor), true);
    assert.equal(commandLineIsRunningAgent(quotedUpdate), false);
    // stopLifelinePid uses this entry check. A quoted pidfile agent must still match.
    assert.equal(commandLineIsLifelineAgent(supervisor), true);
    assert.equal(commandLineIsLifelineAgent(shim), true);
  });
});

describe('runningAgentPids', () => {
  it('drops an ancestor start and keeps a start that is not an ancestor', () => {
    const rows = [
      { pid: 10, commandLine: 'node /Users/x/.lifeline/runtime/lifeline.mjs start' },
      { pid: 11, commandLine: 'node /Users/x/.lifeline/runtime/lifeline.mjs run' },
      { pid: 12, commandLine: 'node /Users/x/.lifeline/runtime/lifeline.mjs update' },
      { pid: 13, commandLine: 'node /Users/x/.lifeline/runtime/lifeline.mjs start --foreground' },
    ];
    assert.deepEqual(runningAgentPids(rows, new Set([10])), [11, 13]);
  });

  it('keeps the service run from a Windows proc listing and drops update', () => {
    const stdout = [
      'proc=42\t99\tnode.exe C:\\h\\.lifeline\\runtime\\lifeline.mjs run',
      'proc=43\t99\tnode.exe C:\\h\\.lifeline\\runtime\\lifeline.mjs update',
      'proc=44\t99\tnode.exe C:\\h\\.lifeline\\runtime\\lifeline.mjs start',
    ].join('\n');
    const rows = parseWindowsLifelineProcs(stdout);
    assert.deepEqual(runningAgentPids(rows, new Set()), [42, 44]);
  });

  it('walks parents from the listing and still keeps a service run', () => {
    const stdout = [
      'proc=10\t1\tnode.exe C:\\h\\.lifeline\\runtime\\lifeline.mjs start',
      'proc=42\t99\t"C:\\Program Files\\node.exe" "C:\\Users\\A B\\.lifeline\\runtime\\lifeline.mjs" run',
      'proc=7\t10\tnode.exe C:\\h\\.lifeline\\runtime\\lifeline.mjs update',
    ].join('\n');
    const rows = parseWindowsLifelineProcs(stdout);
    const exclude = ancestorPidsFromRows(rows, 7, 10);
    assert.equal(exclude.has(7), true);
    assert.equal(exclude.has(10), true);
    assert.equal(exclude.has(42), false);
    assert.deepEqual(runningAgentPids(rows, exclude), [42]);
  });
});

describe('unixProcessListArgs', () => {
  it('scans only the current uid on macOS when id -u works', () => {
    assert.deepEqual(unixProcessListArgs('darwin', '501'), ['-x', '-u', '501', '-o', 'pid=,command=']);
    const fallback = unixProcessListArgs('darwin', null);
    assert.deepEqual(fallback, ['-x', '-o', 'pid=,command=']);
    assert.equal(fallback.includes('-a'), false);
    assert.equal(fallback.includes('-ax'), false);
  });

  it('keeps the all-process listing on linux', () => {
    assert.deepEqual(unixProcessListArgs('linux', null), ['-eo', 'pid=,args=']);
  });
});
