import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  aliveFromKillError,
  ancestorPidsFromRows,
  commandLineIsLifelineAgent,
  commandLineIsRunningAgent,
  parseWindowsLifelineProcs,
  pidAlive,
  runningAgentPids,
  unixProcessListArgs,
} from '../packages/cli/src/daemon/agent-processes.js';
import { windowsLifelinePidsPsCommand } from '../packages/cli/src/win-daemon.js';

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

  it('recognizes the tsx dev entry, both the wrapper and the child process', () => {
    // Measured shapes: `pnpm run agent` = a wrapper plus a real child, same entry, no run/start token.
    const wrapper = 'node /repo/node_modules/.bin/../tsx/dist/cli.mjs packages/agent/src/index.ts';
    const child = '/Users/x/.local/share/fnm/node-versions/v22.22.0/installation/bin/node --require /repo/node_modules/.pnpm/tsx@4.23.14/node_modules/tsx/dist/preflight.cjs --import file:///repo/node_modules/tsx/dist/loader.mjs packages/agent/src/index.ts';
    assert.equal(commandLineIsRunningAgent(wrapper), true);
    assert.equal(commandLineIsRunningAgent(child), true);
  });

  it('recognizes the built entry on both platforms, with either path separator', () => {
    assert.equal(commandLineIsRunningAgent('node dist/packages/agent/src/index.js'), true);
    assert.equal(
      commandLineIsRunningAgent('"C:\\Program Files\\nodejs\\node.exe" C:\\repo\\packages\\agent\\src\\index.ts'),
      true,
    );
    assert.equal(
      commandLineIsRunningAgent('node.exe C:\\repo\\dist\\packages\\agent\\src\\index.js'),
      true,
    );
  });

  it('stays out of anything that is not a node process, or not the entry', () => {
    // A shell tool that merely mentions the path is not an agent (first token is not node).
    assert.equal(commandLineIsRunningAgent('rg packages/agent/src/index.ts'), false);
    assert.equal(commandLineIsRunningAgent('/bin/sh -c "tsx packages/agent/src/index.ts"'), false);
    assert.equal(commandLineIsRunningAgent('node --import tsx --test tests/uplink.test.ts'), false);
    assert.equal(commandLineIsRunningAgent('node /repo/packages/agent/src/entry.ts'), false);
    // The dev entry is not the service entry: stopLifelinePid may only signal the service.
    assert.equal(commandLineIsLifelineAgent('node /repo/packages/agent/src/index.ts'), false);
  });
});

describe('runningAgentPids', () => {
  const noParent = (): number | null => null as number | null;

  it('drops an ancestor start and keeps a start that is not an ancestor', () => {
    const rows = [
      { pid: 10, commandLine: 'node /Users/x/.lifeline/runtime/lifeline.mjs start' },
      { pid: 11, commandLine: 'node /Users/x/.lifeline/runtime/lifeline.mjs run' },
      { pid: 12, commandLine: 'node /Users/x/.lifeline/runtime/lifeline.mjs update' },
      { pid: 13, commandLine: 'node /Users/x/.lifeline/runtime/lifeline.mjs start --foreground' },
    ];
    assert.deepEqual(runningAgentPids(rows, new Set([10]), noParent), [11, 13]);
  });

  it('keeps the service run from a Windows proc listing and drops update', () => {
    const stdout = [
      'proc=42\t99\tnode.exe C:\\h\\.lifeline\\runtime\\lifeline.mjs run',
      'proc=43\t99\tnode.exe C:\\h\\.lifeline\\runtime\\lifeline.mjs update',
      'proc=44\t99\tnode.exe C:\\h\\.lifeline\\runtime\\lifeline.mjs start',
    ].join('\n');
    const rows = parseWindowsLifelineProcs(stdout);
    assert.deepEqual(runningAgentPids(rows, new Set(), noParent), [42, 44]);
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
    assert.deepEqual(runningAgentPids(rows, exclude, noParent), [42]);
  });

  it('reports one instance for a tsx wrapper/child pair: only the child counts', () => {
    const rows = [
      { pid: 100, commandLine: 'node /repo/node_modules/tsx/dist/cli.mjs packages/agent/src/index.ts' },
      { pid: 101, commandLine: 'node --import file:///repo/node_modules/tsx/dist/loader.mjs packages/agent/src/index.ts' },
      { pid: 55, commandLine: 'node /repo/scripts/probe.ts' },
    ];
    const parentOf = (pid: number): number | null => (pid === 100 ? 1 : pid === 101 ? 100 : null);
    assert.deepEqual(runningAgentPids(rows, new Set(), parentOf), [101]);
  });

  it('keeps a pid whose parent cannot be determined', () => {
    const rows = [
      { pid: 100, commandLine: 'node /repo/packages/agent/src/index.ts' },
      { pid: 101, commandLine: 'node /repo/packages/agent/src/index.ts' },
    ];
    assert.deepEqual(runningAgentPids(rows, new Set(), noParent), [100, 101]);
  });

  it('collapses the pair from a Windows listing using its parent column', () => {
    const stdout = [
      'proc=100\t1\tnode.exe C:\\repo\\node_modules\\tsx\\dist\\cli.mjs packages\\agent\\src\\index.ts',
      'proc=101\t100\tnode.exe --import file:///C:/repo/node_modules/tsx/dist/loader.mjs packages\\agent\\src\\index.ts',
    ].join('\n');
    const rows = parseWindowsLifelineProcs(stdout);
    assert.deepEqual(runningAgentPids(rows, new Set(), noParent), [101]);
  });
});

describe('pidAlive', () => {
  it('treats a process we may not signal as alive, and only "no such process" as dead', () => {
    assert.equal(aliveFromKillError('EPERM'), true);
    assert.equal(aliveFromKillError('ESRCH'), false);
    assert.equal(aliveFromKillError(undefined), false);
    assert.equal(pidAlive(process.pid), true);
  });
});

describe('windowsLifelinePidsPsCommand', () => {
  it('matches the service entry and the dev/built entries in one filter', () => {
    const command = windowsLifelinePidsPsCommand();
    assert.ok(command.includes('lifeline.mjs'), 'service entry missing');
    assert.ok(command.includes('packages/agent/src/index.ts'), 'dev entry (posix) missing');
    assert.ok(command.includes('packages\\agent\\src\\index.ts'), 'dev entry (windows) missing');
    assert.ok(command.includes('dist/packages/agent/src/index.js'), 'built entry (posix) missing');
    assert.ok(command.includes('dist\\packages\\agent\\src\\index.js'), 'built entry (windows) missing');
  });

  it('keeps the entry condition parenthesized so the self-exclusion stays outside it', () => {
    const command = windowsLifelinePidsPsCommand(4242);
    assert.ok(command.includes('Where-Object { $_.CommandLine -and ('), 'filter shape changed');
    assert.ok(command.includes(') -and $_.ProcessId -ne 4242 }'), 'self-exclusion moved inside the entry condition');
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
