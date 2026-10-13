import { execFileSync, execSync } from 'node:child_process';
import {
  AGENT_SOURCE_ENTRY_TOKENS,
  queryWindowsStatement,
  windowsLifelinePidsPsCommand,
} from '../win-daemon.js';

const ANCESTOR_WALK_LIMIT = 64;

/** The first argv token of every real agent process: `node` on Unix, `node.exe` on Windows. */
const NODE_BASENAMES = new Set(['node', 'node.exe']);

/**
 * Split a command line into argv tokens, **quote-aware**: a Windows install path contains spaces
 * (`"C:\Program Files\nodejs\node.exe" …`), and splitting on whitespace alone turns it into
 * `C:\Program` + `Files\nodejs\node.exe"`, which loses the executable. NUL separates too (the old
 * `[\0\s]+` split did that deliberately).
 */
function commandLineTokens(commandLine: string | null): string[] {
  if (commandLine == null)
    return [];
  const tokens: string[] = [];
  for (const match of commandLine.matchAll(/"([^"]*)"|([^\0\s]+)/g)) {
    const token = match[1] ?? match[2];
    if (token)
      tokens.push(token);
  }
  return tokens;
}

/** Path separators are not normalized by the OS: compare on a `/`-normalized copy (Windows `C:\…`). */
function normalizeToken(token: string): string {
  return token.replace(/\\/g, '/');
}

/** Basename of an argv token, after separator normalization. */
function tokenBasename(token: string): string {
  const normalized = normalizeToken(token);
  const slash = normalized.lastIndexOf('/');
  return slash < 0 ? normalized : normalized.slice(slash + 1);
}

/**
 * Same token rule as `pidfileProbe`: the entry is `lifeline.mjs`, not a substring of another path.
 * **The service entry only** — `stopLifelinePid` signals whatever this matches, and the CLI's
 * stop paths must never signal a repo agent.
 */
export function commandLineIsLifelineAgent(commandLine: string | null): boolean {
  return commandLineTokens(commandLine).some((token) => {
    const normalized = normalizeToken(token);
    return normalized === 'lifeline.mjs' || normalized.endsWith('/lifeline.mjs');
  });
}

/**
 * A repo (`pnpm run agent` → `tsx packages/agent/src/index.ts`) or built
 * (`pnpm run start:agent` → `node dist/packages/agent/src/index.js`) agent.
 *
 * These entries carry no `run`/`start` token, so they are their own rule. The first token must be
 * a node executable: that costs nothing (every real agent is launched by node) and keeps a shell
 * tool which merely mentions the path — `rg packages/agent/src/index.ts` — out.
 *
 * Kept separate from `commandLineIsLifelineAgent` on purpose (that one gates `stopLifelinePid`,
 * which may signal a process). Exported for the diagnosis consumers landing in Task 5.
 */
export function commandLineIsAgentEntry(commandLine: string | null): boolean {
  const tokens = commandLineTokens(commandLine);
  const first = tokens[0];
  if (first == null || !NODE_BASENAMES.has(tokenBasename(first).toLowerCase()))
    return false;
  return tokens.some(token =>
    AGENT_SOURCE_ENTRY_TOKENS.some(entry => normalizeToken(token).endsWith(entry)),
  );
}

/**
 * Guard predicate. An agent has the lifeline entry token and a separate `run`
 * or `start` token, **or** it is the dev/built entry point. `daemon`, `update`, `status`,
 * `setup`, and `uninstall` are not agents. A substring such as `runtime` is not `run`.
 */
export function commandLineIsRunningAgent(commandLine: string | null): boolean {
  if (commandLineIsLifelineAgent(commandLine))
    return commandLineTokens(commandLine).some(token => token === 'run' || token === 'start');
  return commandLineIsAgentEntry(commandLine);
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
 *
 * A repo dev run is **two** processes — the tsx wrapper and the real child — and both match the
 * same entry. Report the agent instance, not the processes: when a matched pid's parent is also
 * matched, only the child counts. Windows listings carry the parent column; Unix asks `ps` for
 * the few matches. A parent that cannot be determined keeps the pid, so a failed lookup never
 * drops a real agent.
 */
export function runningAgentPids(
  rows: readonly ProcessCommandRow[],
  excludePids: ReadonlySet<number>,
  parentOf: (pid: number) => number | null = parentPidOf,
): number[] {
  const matched: number[] = [];
  for (const row of rows) {
    if (!Number.isInteger(row.pid) || row.pid <= 1 || excludePids.has(row.pid))
      continue;
    if (commandLineIsRunningAgent(row.commandLine))
      matched.push(row.pid);
  }
  if (matched.length <= 1)
    return matched;
  const parents = new Set<number>();
  for (const pid of matched) {
    const row = rows.find(candidate => candidate.pid === pid);
    const parent = row?.ppid ?? parentOf(pid);
    if (parent != null)
      parents.add(parent);
  }
  return matched.filter(pid => !parents.has(pid));
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

/**
 * `process.kill(pid, 0)` is the portable liveness probe. Windows denies `OpenProcess` for a
 * process we may not signal (`EPERM`) — that is **not** "gone". Only "no such process" is dead:
 * for a lock, a wrong "dead" verdict would hand the machine to a second agent.
 */
export function aliveFromKillError(code: string | undefined): boolean {
  return code === 'EPERM';
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  }
  catch (err) {
    return aliveFromKillError((err as NodeJS.ErrnoException | undefined)?.code);
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

/**
 * Tri-state process scan. `unknown` means the listing itself failed and must never be read as
 * "nothing is running": the lock treats a damaged lock file plus an unknown scan as held.
 */
export function scanAgentPids(): { kind: 'ok'; pids: number[] } | { kind: 'unknown' } {
  try {
    if (process.platform === 'win32') {
      return {
        kind: 'ok',
        pids: windowsAgentPids(queryWindowsStatement(windowsLifelinePidsPsCommand(process.pid))),
      };
    }
    return {
      kind: 'ok',
      pids: runningAgentPids(parsePsProcessRows(listUnixProcessTable()), selfAndAncestorPids()),
    };
  }
  catch {
    return { kind: 'unknown' };
  }
}

/**
 * Pids of lifeline agents, excluding this process and its ancestors. A failed scan is `[]`.
 *
 * Asymmetry worth knowing: the machine lock reads `unknown` as "possibly held" (refuse), while
 * this wrapper collapses it to "none" for the CLI callers that predate the tri-state.
 */
export function lifelineAgentPids(): number[] {
  const scan = scanAgentPids();
  return scan.kind === 'ok' ? scan.pids : [];
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
