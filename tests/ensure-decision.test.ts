import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  decideEnsure,
  isServiceInvocation,
  pidfileProbe,
} from '../packages/cli/src/daemon/ensure-decision.js';

describe('decideEnsure', () => {
  const base = {
    installed: true,
    registrationMatches: true,
    running: true,
    versionMatches: true,
  };

  it('returns reinstall when not installed', () => {
    assert.equal(
      decideEnsure({ ...base, installed: false }),
      'reinstall',
    );
    assert.equal(
      decideEnsure({ ...base, installed: false, running: true, registrationMatches: true }),
      'reinstall',
    );
  });

  it('returns reinstall when registration differs', () => {
    assert.equal(
      decideEnsure({ ...base, registrationMatches: false }),
      'reinstall',
    );
    assert.equal(
      decideEnsure({ ...base, registrationMatches: false, running: true, versionMatches: true }),
      'reinstall',
    );
  });

  it('returns noop when installed, registered, running, version matches', () => {
    assert.equal(decideEnsure({ ...base }), 'noop');
  });

  it('returns restart-in-place when running and version differs', () => {
    assert.equal(
      decideEnsure({ ...base, versionMatches: false }),
      'restart-in-place',
    );
  });

  it('returns start-only when not running', () => {
    assert.equal(
      decideEnsure({ ...base, running: false }),
      'start-only',
    );
    assert.equal(
      decideEnsure({ ...base, running: false, versionMatches: false }),
      'start-only',
    );
  });
});

describe('isServiceInvocation', () => {
  const bareStart = {
    command: 'start' as const,
    foreground: false,
    supervisedEnv: false,
    selfIsLaunchdJob: false,
    systemdInvocationId: false,
    ancestorCommandLines: [] as string[],
  };

  it('is false for bare start with all flags false', () => {
    assert.equal(isServiceInvocation(bareStart), false);
  });

  it('is true for run even when every flag is false', () => {
    assert.equal(
      isServiceInvocation({ ...bareStart, command: 'run' }),
      true,
    );
  });

  it('is true when foreground alone is set', () => {
    assert.equal(isServiceInvocation({ ...bareStart, foreground: true }), true);
  });

  it('is true when supervisedEnv alone is set', () => {
    assert.equal(isServiceInvocation({ ...bareStart, supervisedEnv: true }), true);
  });

  it('is true when selfIsLaunchdJob alone is set', () => {
    assert.equal(isServiceInvocation({ ...bareStart, selfIsLaunchdJob: true }), true);
  });

  it('is true when systemdInvocationId alone is set', () => {
    assert.equal(isServiceInvocation({ ...bareStart, systemdInvocationId: true }), true);
  });

  it('is true when an ancestor command line contains daemon.ps1', () => {
    assert.equal(
      isServiceInvocation({
        ...bareStart,
        ancestorCommandLines: ['powershell.exe -File C:\\Lifeline\\daemon.ps1'],
      }),
      true,
    );
  });

  it('is false when ancestors are unrelated', () => {
    assert.equal(
      isServiceInvocation({
        ...bareStart,
        ancestorCommandLines: ['node.exe C:\\foo\\lifeline.mjs start', 'cmd.exe /c echo hi'],
      }),
      false,
    );
  });
});

describe('pidfileProbe', () => {
  const stale = {
    installed: false,
    running: false,
    registrationMatches: true,
  };

  it('treats absent pid as stale', () => {
    assert.deepEqual(
      pidfileProbe({ pid: null, alive: false, commandLine: null }),
      stale,
    );
  });

  it('treats dead pid as stale', () => {
    assert.deepEqual(
      pidfileProbe({ pid: 99, alive: false, commandLine: 'node /x/lifeline.mjs run' }),
      stale,
    );
  });

  it('treats alive process without lifeline.mjs token as stale', () => {
    assert.deepEqual(
      pidfileProbe({ pid: 1, alive: true, commandLine: 'node /usr/bin/node' }),
      stale,
    );
  });

  it('recognizes alive lifeline.mjs with run', () => {
    assert.deepEqual(
      pidfileProbe({
        pid: 42,
        alive: true,
        commandLine: 'node /home/u/.lifeline/runtime/lifeline.mjs run',
      }),
      { installed: true, running: true, registrationMatches: true },
    );
  });

  it('does not treat a runtime directory path as the run argument', () => {
    assert.deepEqual(
      pidfileProbe({
        pid: 42,
        alive: true,
        commandLine: 'node /home/u/.lifeline/runtime/lifeline.mjs start',
      }),
      { installed: true, running: true, registrationMatches: false },
    );
  });

  it('parses NUL-separated argv on Windows-style command lines', () => {
    assert.deepEqual(
      pidfileProbe({
        pid: 7,
        alive: true,
        commandLine: 'node.exe\0C:\\Lifeline\\lifeline.mjs\0run',
      }),
      { installed: true, running: true, registrationMatches: true },
    );
  });
});
