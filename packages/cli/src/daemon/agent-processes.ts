import { execFileSync, execSync } from 'node:child_process';
import {
  queryWindowsStatement,
  windowsLifelinePidsPsCommand,
} from '../win-daemon.js';

const ANCESTOR_WALK_LIMIT = 64;

/** A Windows command line quotes paths. Drop one leading and one trailing `"`. */
function unquoteToken(token: string): string {
  let start = 0;
  let end = token.length;
  if (start < end && token[start] === '"')
    start++;
  if (end > start && token[end - 1] === '"')
    end--;
  return token.slice(start, end);
}

function commandLineTokens(commandLine: string | null): string[] {
  if (commandLine == null)
    return [];
  return commandLine.split(/[\0\s]+/).filter(Boolean).map(unquoteToken).filter(Boolean);
}

/** Same token rule as `pidfileProbe`: the entry is `lifeline.mjs`, not a substring of another path. */
export function commandLineIsLifelineAgent(commandLine: string | null): boolean {
  return commandLineTokens(commandLine).some(token =>
    token === 'lifeline.mjs'
    || token.endsWith('/lifeline.mjs')
    || token.endsWith('\\lifeline.mjs'),
  );
}

/**
 * Guard predicate. An agent has the lifeline entry token and a separate `run`
 * or `start` token. `daemon`, `update`, `status`, `setup`, and `uninstall`
 * are not agents. A substring such as `runtime` is not `run`.
 */
export function commandLineIsRunningAgent(commandLine: string | null): boolean {
  if (!commandLineIsLifelineAgent(commandLine))
    return false;
  return commandLineTokens(commandLine).some(token => token === 'run' || token === 'start');
}

export interface ProcessCommandRow {
  pid: number;
  commandLine: string;
  /** Present on Windows listings. Unix `ps` rows omit it. */
  ppid?: number;
}

/**
 * `ps` argv for the agent scan. On macOS, a numeric uid limits the scan to
 * that user. A failed `id -u` still omits `-a`, so other users are not listed.
 */
export function unixProcessListArgs(platform: NodeJS.Platform, uid: string | null): string[] {
  if (platform === 'darwin') {
    if (uid != null && /^\d+$/.test(uid))
      return ['-x', '-u', uid, '-o', 'pid=,command='];
    return ['-x', '-o', 'pid=,command='];
  }
  return ['-eo', 'pid=,args='];
}

/** Rows from `windowsLifelinePidsPsCommand`: `proc=<pid><TAB><ppid><TAB><command line>`. */
export function parseWindowsLifelineProcs(stdout: string): ProcessCommandRow[] {
  const rows: ProcessCommandRow[] = [];
  const text = stdout.replace(/^\uFEFF/, '');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s+/, '');
    if (!line.startsWith('proc='))
      continue;
    const tab = line.indexOf('\t');
    if (tab < 0)
      continue;
    const pid = Number(line.slice('proc='.length, tab));
    if (!Number.isInteger(pid) || pid <= 0)
      continue;
    const rest = line.slice(tab + 1);
    const tab2 = rest.indexOf('\t');
    if (tab2 < 0)
      continue;
    const ppid = Number(rest.slice(0, tab2));
    if (!Number.isInteger(ppid) || ppid < 0)
      continue;
    rows.push({ pid, ppid, commandLine: rest.slice(tab2 + 1).trim() });
  }
  return rows;
}

/**
 * This process and its ancestors, using parent pids already in `rows`.
 * A parent that is not in the listing ends the walk. No extra process query.
 */
export function ancestorPidsFromRows(
  rows: readonly { pid: number; ppid?: number }[],
  selfPid: number,
  parentPid: number,
): Set<number> {
  const parentOf = new Map<number, number>();
  for (const row of rows) {
    if (row.ppid != null)
      parentOf.set(row.pid, row.ppid);
  }
  const exclude = new Set<number>();
  if (Number.isInteger(selfPid) && selfPid > 1)
    exclude.add(selfPid);
  let pid = parentPid;
  for (let i = 0; i < ANCESTOR_WALK_LIMIT && Number.isInteger(pid) && pid > 1 && !exclude.has(pid); i++) {
    exclude.add(pid);
    const parent = parentOf.get(pid);
    if (parent == null)
      break;
    pid = parent;
  }
  return exclude;
}

/**
 * Pids whose command line is a running agent, minus `excludePids`.
 * Callers pass this process and its ancestors so a parent `start` that
 * spawned ensure is not a second agent. A `start` or `run` outside that
 * set still counts.
 */
export function runningAgentPids(
  rows: readonly ProcessCommandRow[],
  excludePids: ReadonlySet<number>,
): number[] {
  const pids: number[] = [];
  for (const row of rows) {
    if (!Number.isInteger(row.pid) || row.pid <= 1 || excludePids.has(row.pid))
      continue;
    if (commandLineIsRunningAgent(row.commandLine))
      pids.push(row.pid);
  }
  return pids;
}

export function processCommandLine(pid: number): string | null {
  try {
    if (process.platform === 'win32') {
      const text = queryWindowsStatement(
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue).CommandLine`,
      ).trim();
      return text || null;
    }
    const flag = process.platform === 'darwin' ? 'command=' : 'args=';
    const text = execSync(`ps -p ${pid} -o ${flag}`, { encoding: 'utf-8' }).trim();
    return text || null;
  }
  catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  }
  catch {
    return false;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function currentUid(): string | null {
  try {
    const uid = execFileSync('id', ['-u'], { encoding: 'utf-8' }).trim();
    return /^\d+$/.test(uid) ? uid : null;
  }
  catch {
    return null;
  }
}

function parentPidOf(pid: number): number | null {
  try {
    const text = execFileSync('ps', ['-p', String(pid), '-o', 'ppid='], { encoding: 'utf-8' }).trim();
    const parent = Number(text);
    return Number.isInteger(parent) && parent > 0 ? parent : null;
  }
  catch {
    return null;
  }
}

/** Unix ancestor walk via `ps`. Windows listings use `ancestorPidsFromRows` instead. */
export function selfAndAncestorPids(): Set<number> {
  const exclude = new Set<number>();
  if (Number.isInteger(process.pid) && process.pid > 1)
    exclude.add(process.pid);
  if (process.platform === 'win32')
    return exclude;
  let pid = process.ppid;
  for (let i = 0; i < ANCESTOR_WALK_LIMIT && Number.isInteger(pid) && pid > 1 && !exclude.has(pid); i++) {
    exclude.add(pid);
    const parent = parentPidOf(pid);
    if (parent == null)
      break;
    pid = parent;
  }
  return exclude;
}

function parsePsProcessRows(out: string): ProcessCommandRow[] {
  const rows: ProcessCommandRow[] = [];
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    const space = trimmed.search(/\s/);
    if (space <= 0)
      continue;
    const pid = Number(trimmed.slice(0, space));
    if (!Number.isInteger(pid) || pid <= 1)
      continue;
    rows.push({ pid, commandLine: trimmed.slice(space).trim() });
  }
  return rows;
}

function listUnixProcessTable(): string {
  const uid = process.platform === 'darwin' ? currentUid() : null;
  return execFileSync('ps', unixProcessListArgs(process.platform, uid), {
    encoding: 'utf-8',
    maxBuffer: 4 * 1024 * 1024,
  });
}

function windowsAgentPids(stdout: string): number[] {
  const rows = parseWindowsLifelineProcs(stdout);
  return runningAgentPids(rows, ancestorPidsFromRows(rows, process.pid, process.ppid));
}

/** Pids of lifeline `run` / `start` processes, excluding this process and its ancestors. */
export function lifelineAgentPids(): number[] {
  try {
    if (process.platform === 'win32')
      return windowsAgentPids(queryWindowsStatement(windowsLifelinePidsPsCommand(process.pid)));
    return runningAgentPids(parsePsProcessRows(listUnixProcessTable()), selfAndAncestorPids());
  }
  catch {
    return [];
  }
}

/**
 * Windows listing filtered by the same predicate as `lifelineAgentPids`.
 * The service process (`run`) stays in the set; `update` does not.
 * Ancestors come from the parent column of this listing, not a query per parent.
 */
export function listedLifelineAgentPids(stdout: string): number[] {
  return windowsAgentPids(stdout);
}

/** Lifeline processes that are not the service. `servicePid` null means every agent is other. */
export function lifelinePidsExcept(servicePid: number | null): number[] {
  return lifelineAgentPids().filter(pid => pid !== servicePid);
}

/**
 * SIGTERM a live `lifeline.mjs` and wait until it leaves the process table.
 * Returns false when the pid is still alive, so the caller does not spawn a second agent.
 */
export function stopLifelinePid(pid: number): boolean {
  if (!commandLineIsLifelineAgent(processCommandLine(pid)))
    return false;
  try {
    process.kill(pid, 'SIGTERM');
  }
  catch {
    return !pidAlive(pid);
  }
  const deadline = Date.now() + 2000;
  while (pidAlive(pid) && Date.now() < deadline)
    sleepSync(50);
  return !pidAlive(pid);
}
