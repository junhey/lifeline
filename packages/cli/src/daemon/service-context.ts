import type { SpawnSyncReturns } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { windowsTaskInvocation } from '../win-daemon.js';
import { isServiceInvocation } from './ensure-decision.js';
import { currentProcessIsLaunchdJob } from './launchd.js';

const ANCESTOR_LIMIT = 4;

function commandFromArgv(argv: string[]): 'start' | 'run' | 'other' {
  for (const arg of argv) {
    if (arg === 'run' || arg === 'start')
      return arg;
  }
  return 'other';
}

function spawnFailed(result: SpawnSyncReturns<string>): boolean {
  return result.error != null || result.status !== 0;
}

function spawnFailure(result: SpawnSyncReturns<string>, fallback: string): Error {
  if (result.error)
    return result.error;
  const stderr = (result.stderr ?? '').trim();
  return new Error(stderr || fallback);
}

/** `ps` exit 1 with empty output is "no such process", which ends the walk. */
function unixProcessGone(result: SpawnSyncReturns<string>): boolean {
  const stdout = (result.stdout ?? '').trim();
  const stderr = (result.stderr ?? '').trim();
  return result.status !== 0 && !result.error && !stdout && !stderr;
}

function unixParentPid(pid: number): number | null {
  const result = spawnSync('ps', ['-ww', '-p', String(pid), '-o', 'ppid='], { encoding: 'utf-8' });
  if (unixProcessGone(result))
    return null;
  if (spawnFailed(result))
    throw spawnFailure(result, 'ps parent query failed');
  const text = (result.stdout ?? '').trim();
  const ppid = Number(text);
  if (!text || !Number.isInteger(ppid))
    throw new Error('ps parent parse failed');
  return ppid;
}

function unixCommandLine(pid: number): string {
  const column = process.platform === 'darwin' ? 'command=' : 'args=';
  const result = spawnSync('ps', ['-ww', '-p', String(pid), '-o', column], { encoding: 'utf-8' });
  if (unixProcessGone(result))
    return '';
  if (spawnFailed(result))
    throw spawnFailure(result, 'ps command query failed');
  return (result.stdout ?? '').trim();
}

function unixParent(pid: number): { ppid: number; commandLine: string } | null {
  const ppid = unixParentPid(pid);
  if (ppid == null)
    return null;
  if (ppid <= 0)
    return { ppid, commandLine: '' };
  return { ppid, commandLine: unixCommandLine(ppid) };
}

function windowsParent(pid: number): { ppid: number; commandLine: string } | null {
  const statement = [
    `$proc = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction Stop`,
    'if (-not $proc) { exit 0 }',
    '$ppid = [int]$proc.ParentProcessId',
    '$parent = Get-CimInstance Win32_Process -Filter "ProcessId=$ppid" -ErrorAction Stop',
    'Write-Output $ppid',
    'if ($parent -and $parent.CommandLine) { Write-Output $parent.CommandLine }',
  ].join('; ');
  const invocation = windowsTaskInvocation(statement);
  const result = spawnSync(invocation.cmd, invocation.args, {
    encoding: 'utf-8',
    timeout: 30_000,
    windowsHide: true,
  });
  if (spawnFailed(result))
    throw spawnFailure(result, 'parent process query failed');
  const text = (result.stdout ?? '').replace(/^\uFEFF/, '').trim();
  if (!text)
    return null;
  const nl = text.indexOf('\n');
  const ppid = Number((nl === -1 ? text : text.slice(0, nl)).trim());
  if (!Number.isInteger(ppid))
    throw new Error('parent pid missing');
  const commandLine = nl === -1 ? '' : text.slice(nl + 1).trim();
  return { ppid, commandLine };
}

function readParent(pid: number): { ppid: number; commandLine: string } | null {
  if (!Number.isInteger(pid) || pid <= 0)
    throw new Error('pid is not a process id');
  if (process.platform === 'win32')
    return windowsParent(pid);
  return unixParent(pid);
}

/** At most four parents. A throw means the caller treats the ancestor signal as false. */
function ancestorCommandLines(startPid: number): string[] {
  const lines: string[] = [];
  let pid = startPid;
  for (let i = 0; i < ANCESTOR_LIMIT; i++) {
    const parent = readParent(pid);
    if (parent == null)
      break;
    if (parent.commandLine) {
      lines.push(parent.commandLine);
      // Later parents are irrelevant once the supervisor script is in the chain, and a
      // failure further up must not discard this hit.
      if (parent.commandLine.includes('daemon.ps1'))
        break;
    }
    if (parent.ppid <= 0 || parent.ppid === pid)
      break;
    pid = parent.ppid;
  }
  return lines;
}

export function detectServiceInvocation(argv: string[]): boolean {
  let ancestors: string[] = [];
  try {
    ancestors = ancestorCommandLines(process.pid);
  }
  catch {
    ancestors = [];
  }
  return isServiceInvocation({
    command: commandFromArgv(argv),
    foreground: argv.includes('--foreground') || argv.includes('-f'),
    supervisedEnv: Boolean(process.env.LIFELINE_SUPERVISED),
    selfIsLaunchdJob: currentProcessIsLaunchdJob(process.pid),
    systemdInvocationId: Boolean(process.env.INVOCATION_ID),
    ancestorCommandLines: ancestors,
  });
}
