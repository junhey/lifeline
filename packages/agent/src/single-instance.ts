import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CONFIG_DIR } from '../../cli/src/config.js';
import {
  commandLineIsLifelineAgent,
  commandLineIsRunningAgent,
  pidAlive,
  processCommandLine,
  scanAgentPids,
} from '../../cli/src/daemon/agent-processes.js';
import { oneLine } from './log-line.js';

/**
 * One agent process per machine.
 *
 * Two agents for the same machine (a repo `pnpm run agent` beside the installed service, or an
 * old process that survived an update) fight over one server slot; the loser's reports are
 * dropped and the console quietly shows the wrong code. The server cannot order them by version
 * (`0.0.0-dev` says nothing about which commit is newer), so the machine decides locally: the
 * first process to hold `~/.lifeline/agent.lock` runs, the second exits with a message naming
 * the holder. There is no opt-out — running a repo agent is `lifeline stop` first.
 */

export interface AgentLockFile {
  pid: number;
  agentId: string;
  version: string;
  remoteUrl: string;
  startedAt: number;
}

/** `~/.lifeline/agent.lock` — the same HOME directory for the service and a repo run. */
export function agentLockPath(): string {
  return join(CONFIG_DIR, 'agent.lock');
}

export type LockDecision = 'acquire' | 'refuse';

export interface LockDecisionInput {
  /** Parsed contents; null when the file is absent or unparseable. */
  lock: AgentLockFile | null;
  /** false = the file exists but does not parse (and `lock` is null). */
  readable: boolean;
  alive: boolean;
  /** Tri-state: the command-line probe can fail, and a failed probe is not a free slot. */
  commandLine: 'agent' | 'not-agent' | 'unknown';
  /** Tri-state: the fallback process scan can fail too ("unknown" ≠ "none"). */
  scan: 'some' | 'none' | 'unknown';
}

/**
 * Pure decision table. A damaged file is **not** an absent one: the machine is only handed over
 * when the scan positively says nothing is alive — the same policy the daemon already applies to
 * an unreadable live pidfile (`unreadableLivePidfile`).
 */
export function decideLock(input: LockDecisionInput): LockDecision {
  if (!input.readable)
    return input.scan === 'none' ? 'acquire' : 'refuse';
  if (input.lock == null)
    return 'acquire';
  if (!input.alive)
    return 'acquire';
  if (input.commandLine === 'agent')
    return 'refuse';
  if (input.commandLine === 'unknown')
    return 'refuse';
  return 'acquire';
}

/** Largest timestamp `Date` can represent (±100 000 000 days). */
const MAX_DATE_MS = 8.64e15;

/**
 * A file that parses but carries nonsense is **unreadable**, not "old": `startedAt` is validated
 * as a representable date, because a lock a human edited (`1e999`) would otherwise reach the
 * refusal formatter and throw `RangeError`, printing no refusal at all — the opposite of the
 * "a damaged lock is still explainable" rule this module exists for.
 */
function isAgentLockFile(value: unknown): value is AgentLockFile {
  if (typeof value !== 'object' || value == null)
    return false;
  const record = value as Partial<AgentLockFile>;
  return typeof record.pid === 'number' && Number.isInteger(record.pid) && record.pid > 0
    && typeof record.agentId === 'string'
    && typeof record.version === 'string'
    && typeof record.remoteUrl === 'string'
    && typeof record.startedAt === 'number'
    && Number.isFinite(record.startedAt)
    && Math.abs(record.startedAt) <= MAX_DATE_MS;
}

/**
 * Three separate members, not one `'absent' | 'unreadable'` member: the combined form cannot be
 * narrowed by `=== 'absent'` / `=== 'unreadable'` checks, which silently turns downstream null
 * guards into dead code.
 */
export type AgentLockRead
  = | { kind: 'ok'; lock: AgentLockFile }
    | { kind: 'absent'; lock?: undefined }
    | { kind: 'unreadable'; lock?: undefined };

export function readAgentLock(path: string): AgentLockRead {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  }
  catch (err) {
    // A missing file is absent; a file we may not read is not a free slot.
    return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unreadable' };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isAgentLockFile(parsed) ? { kind: 'ok', lock: parsed } : { kind: 'unreadable' };
  }
  catch {
    return { kind: 'unreadable' };
  }
}

export interface LockSeams {
  /** Test seams: run inside the take-over / create sequence to force races deterministically. */
  beforeUnlink?: () => void;
  beforeCreate?: () => void;
  afterCreate?: () => void;
}

export interface AcquireInput {
  agentId: string;
  version: string;
  remoteUrl: string;
  /** Defaults to this process. */
  pid?: number;
  path?: string;
  now?: () => number;
  alive?: (pid: number) => boolean;
  commandLineOf?: (pid: number) => string | null;
  scanAgents?: () => 'some' | 'none' | 'unknown';
  seams?: LockSeams;
}

export type AcquireResult
  = | { ok: true; lock: AgentLockFile }
    | {
      ok: false;
      holder?: AgentLockFile;
      /**
       * `true` = the holder is the service entry (`lifeline stop` stops it), `false` = a repo or
       * built agent, `undefined` = its command line could not be read. Probed while deciding, so
       * the refusal never names a way to kill a pid it did not identify.
       */
      holderIsService?: boolean;
      unreadable?: boolean;
      notOwned?: boolean;
      error?: string;
    };

interface Evaluation {
  decision: LockDecision;
  /** The file exists (whatever its contents). */
  present: boolean;
  lock: AgentLockFile | null;
  unreadable: boolean;
  holderIsService?: boolean;
}

const MAX_ATTEMPTS = 3;

function sameJudgedFile(a: AgentLockFile, b: AgentLockFile): boolean {
  return a.pid === b.pid && a.startedAt === b.startedAt;
}

type RemovalOutcome = { ok: true } | { ok: false; reason: 'changed' | 'unlink-failed'; error?: string };

/**
 * Take over a stale or damaged lock file.
 *
 * A parsed file is re-read and must still be the one that was judged removable (`pid` +
 * `startedAt`), which stops the common interleaving
 * `unlink → create(A) → unlink(A) → create(B)`. It is compare-**then**-unlink, though, and cannot
 * close the window: read and unlink are two syscalls, so a taker that is preempted between them
 * can still delete a lock created after its re-read — both sides then log `ok`. The accepted bound
 * is not in this file: the server's registration rules decide the slot and make the loser visible
 * (a `takeover`, or an ignored duplicate) instead of letting both sides believe they won. Do not
 * describe this as a compare-and-swap.
 * The unreadable branch can only re-confirm that the file is still unreadable: there is no
 * identity to compare.
 *
 * The failure reason is reported, not just "false": "cannot remove it" and "somebody rewrote it"
 * are different stories to print, and the caller must not blame the wrong one.
 */
function removeJudgedFile(path: string, judged: Evaluation, seams?: LockSeams): RemovalOutcome {
  seams?.beforeUnlink?.();
  const current = readAgentLock(path);
  if (current.kind === 'absent')
    return { ok: true };
  if (judged.unreadable)
    return current.kind === 'unreadable' ? unlinkQuietly(path) : { ok: false, reason: 'changed' };
  // A stale judgement that turned unreadable (or vanished into a parse failure) counts as
  // "changed": re-evaluate rather than removing a file nobody can describe. The `judged.lock ==
  // null` half is defensive and unreachable from `acquireAgentLock` (an absent or unreadable
  // judgement never reaches this line); it is here so the union narrows.
  if (judged.lock == null || current.kind !== 'ok')
    return { ok: false, reason: 'changed' };
  if (!sameJudgedFile(current.lock, judged.lock))
    return { ok: false, reason: 'changed' };
  return unlinkQuietly(path);
}

function unlinkQuietly(path: string): RemovalOutcome {
  try {
    unlinkSync(path);
    return { ok: true };
  }
  catch (err) {
    return { ok: false, reason: 'unlink-failed', error: errorMessage(err) };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type CreateOutcome = { kind: 'created' | 'exists' } | { kind: 'failed'; error: string };

function createExclusively(path: string, record: AgentLockFile): CreateOutcome {
  try {
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
    return { kind: 'created' };
  }
  catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === 'EEXIST')
      return { kind: 'exists' };
    return { kind: 'failed', error: errorMessage(err) };
  }
}

function defaultScan(): 'some' | 'none' | 'unknown' {
  const scan = scanAgentPids();
  return scan.kind === 'unknown' ? 'unknown' : scan.pids.length > 0 ? 'some' : 'none';
}

/**
 * Acquire the machine lock, or report the holder.
 *
 * Refusals are non-zero exits at the call site: launchd and systemd only relaunch a failed
 * process, so a refusal must not look successful, and a lock that has gone stale by then is
 * taken over by the normal rule.
 */
export function acquireAgentLock(input: AcquireInput): AcquireResult {
  const path = input.path ?? agentLockPath();
  const pid = input.pid ?? process.pid;
  const now = input.now ?? Date.now;
  const alive = input.alive ?? pidAlive;
  const commandLineOf = input.commandLineOf ?? processCommandLine;
  const scanAgents = input.scanAgents ?? defaultScan;

  const evaluate = (): Evaluation => {
    const read = readAgentLock(path);
    if (read.kind === 'absent')
      return { decision: 'acquire', present: false, lock: null, unreadable: false };
    if (read.kind === 'unreadable') {
      const scan = scanAgents();
      return {
        decision: decideLock({ lock: null, readable: false, alive: false, commandLine: 'unknown', scan }),
        present: true,
        lock: null,
        unreadable: true,
      };
    }
    const lock = read.lock;
    // A lock naming **this** pid is either our own earlier record or a dead process whose pid was
    // reused (kill -9, reboot, Windows `Stop-Process -Force`, which is a normal stop path there).
    // Pids are unique among live processes *within one PID namespace*, so nobody else here can own
    // it (two containers sharing a ~/.lifeline is out of scope). Treating it as held would make the
    // agent refuse forever and name itself as the holder.
    if (lock.pid === pid)
      return { decision: 'acquire', present: true, lock, unreadable: false };
    const isAlive = alive(lock.pid);
    const line = isAlive ? commandLineOf(lock.pid) : null;
    const agentLine = line != null && commandLineIsRunningAgent(line) ? line : null;
    const commandLine: LockDecisionInput['commandLine']
      = agentLine != null ? 'agent' : line == null ? 'unknown' : 'not-agent';
    return {
      decision: decideLock({ lock, readable: true, alive: isAlive, commandLine, scan: 'none' }),
      present: true,
      lock,
      unreadable: false,
      // Decided from the probe above: the refusal must not re-probe (a second probe can fail or
      // read a different process) and must not guess how to stop a pid it could not identify.
      holderIsService: agentLine == null ? undefined : commandLineIsLifelineAgent(agentLine),
    };
  };

  const refusal = (state: Evaluation): AcquireResult =>
    state.unreadable
      ? { ok: false, unreadable: true }
      : { ok: false, holder: state.lock ?? undefined, holderIsService: state.holderIsService };

  const record: AgentLockFile = {
    pid,
    agentId: input.agentId,
    version: input.version,
    remoteUrl: input.remoteUrl,
    startedAt: now(),
  };

  try {
    // The agent takes its settings from the environment, so `~/.lifeline` may not exist yet
    // (containers, env-only runs): create it, as the CLI does before its own first write.
    mkdirSync(dirname(path), { recursive: true });
  }
  catch (err) {
    return { ok: false, error: `cannot create ${dirname(path)}: ${errorMessage(err)}` };
  }

  // Only the last obstacle is reported: mixed causes (an unlink denial followed by a rewrite) end
  // up as whichever came last, which is enough for a message a human reads.
  let lastObstacle: { reason: 'changed' | 'unlink-failed'; error?: string } | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const state = evaluate();
    if (state.decision === 'refuse')
      return refusal(state);
    if (state.present) {
      const removal = removeJudgedFile(path, state, input.seams);
      if (!removal.ok) {
        lastObstacle = removal;
        continue;
      }
    }
    input.seams?.beforeCreate?.();
    const create = createExclusively(path, record);
    if (create.kind === 'exists')
      continue;
    if (create.kind === 'failed')
      return { ok: false, error: `cannot write ${path}: ${create.error}` };
    input.seams?.afterCreate?.();
    const readBack = readAgentLock(path);
    if (readBack.kind === 'ok' && readBack.lock.pid === pid)
      return { ok: true, lock: readBack.lock };
    // Another process owns the file we just created: exit without unlinking it.
    return { ok: false, notOwned: true };
  }

  // Out of attempts: report the real obstacle ("cannot remove it" is not "it kept changing"), and
  // keep a refusal a refusal rather than attaching a misleading story to it.
  const final = evaluate();
  if (final.decision === 'refuse')
    return refusal(final);
  const unsettled = lastObstacle?.reason === 'unlink-failed'
    ? `cannot remove ${path}: ${lastObstacle.error ?? 'unknown error'}`
    : 'the lock file kept changing; nothing was removed';
  return final.lock == null
    ? { ok: false, unreadable: final.unreadable, error: unsettled }
    : { ok: false, holder: final.lock, holderIsService: final.holderIsService, error: unsettled };
}

/** Delete the lock only when this pid owns it. Missing file and foreign pid are both no-ops. */
export function releaseAgentLock(path: string = agentLockPath(), pid: number = process.pid): void {
  const read = readAgentLock(path);
  if (read.kind !== 'ok' || read.lock.pid !== pid)
    return;
  unlinkQuietly(path);
}

export interface LockRefusalInput {
  result: Extract<AcquireResult, { ok: false }>;
  /** This process, so the refusal carries the same identity facts the success banner prints. */
  identity: { pid: number; agentId: string; version: string; remoteUrl: string };
  lockPath: string;
}

/**
 * The refusal block printed by `index.ts`. It is never empty and its first line carries this
 * process's own identity — a refused start must still say who it is — then the cause, the holder
 * (when there really is one) and the way out.
 *
 * A way to stop the holder is only printed when the lock actually **refused**: on the unsettled and
 * unwritable paths `holder` is the stale record the take-over failed on, so `kill <pid>` there
 * could point at a reused pid, i.e. at an unrelated process.
 */
export function formatLockRefusal(input: LockRefusalInput): string[] {
  const { identity, result } = input;
  const lockPath = oneLine(input.lockPath);
  const held = result.holder != null && result.error == null;
  const cause = held ? 'another Lifeline agent holds this machine' : 'cannot take the machine lock';
  const lines = [
    `[agent] pid=${identity.pid} agentId=${oneLine(identity.agentId)} v${oneLine(identity.version)} remote=${oneLine(identity.remoteUrl)} — ${cause}; refusing to start`,
  ];
  if (result.holder != null) {
    const holder = result.holder;
    // Belt and braces: `readAgentLock` rejects unrepresentable dates, but this function must never
    // throw — a refusal that throws is a refusal nobody reads.
    const started = new Date(holder.startedAt);
    const startedText = Number.isNaN(started.getTime()) ? `unreadable (${holder.startedAt})` : started.toISOString();
    if (held) {
      lines.push(
        `[agent]   holder pid ${holder.pid} · v${oneLine(holder.version)} · ${oneLine(holder.agentId)}`
        + ` · started ${startedText}`,
      );
      // The tri-state comes from the probe the lock already made: `undefined` = unreadable, and
      // guessing a signal for a process we could not identify is how a refused start kills a
      // bystander.
      if (result.holderIsService === true)
        lines.push('[agent]   stop it with `lifeline stop`');
      else if (result.holderIsService === false)
        lines.push(`[agent]   stop it with \`kill ${holder.pid}\` (\`lifeline stop\` cannot stop a repo agent)`);
      else
        lines.push(`[agent]   its command line could not be read: inspect pid ${holder.pid} before signalling it`);
    }
    else {
      lines.push(`[agent]   the lock file still names pid ${holder.pid}, which is not the agent holding this machine`);
    }
  }
  if (result.unreadable)
    lines.push(`[agent]   ${lockPath} exists but cannot be read: inspect it, and delete it only if you are sure no agent is running`);
  if (result.notOwned)
    lines.push('[agent]   another process created the lock while this one was starting; start again');
  if (result.error != null)
    lines.push(`[agent]   ${oneLine(result.error)}`);
  lines.push(`[agent]   lock ${lockPath}`);
  return lines;
}
