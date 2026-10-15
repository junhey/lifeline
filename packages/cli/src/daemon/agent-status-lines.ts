import type { AgentLockRead } from '../../../agent/src/single-instance.js';
import { oneLine } from '../../../agent/src/log-line.js';
import { decideLock } from '../../../agent/src/single-instance.js';
import { commandLineIsLifelineAgent, commandLineIsRunningAgent } from './agent-processes.js';
import { STOP_NOTE_FOREGROUND } from './stop.js';

/**
 * The `agent` rows of `lifeline status`.
 *
 * This is the diagnosis surface for the incident (工蜂 Issue #2): a second agent on the machine makes
 * the console show the wrong code, and the person reading the page cannot ssh in to find out why. The
 * rows are built from the lock file and the local process scan only — no server request, and no `ps`
 * needed from the reader — and the stop hint is exact, because the difference between `lifeline stop`
 * and `kill <pid>` decides whether the reader stops the agent or nothing at all.
 *
 * Pure on purpose: every probe arrives as an input, so the whole diagnosis (including the hint that
 * must **not** point at an unidentifiable pid) is unit-tested.
 */

/** Column width shared with the neighbouring rows (`cli      `, `server   `, …). */
const LABEL = 'agent    ';

export interface AgentStatusInput {
  /** The lock file as read from disk. */
  lock: AgentLockRead;
  /** Probes for the pid the lock names; ignored when the read is not `ok`. */
  probe: { alive: boolean; commandLine: string | null };
  /** Live agent instances from the local scan (`kind: 'unknown'` = the scan itself failed). */
  instances: { kind: 'ok'; pids: number[] } | { kind: 'unknown' };
  /** Only the "why a service agent cannot start" row depends on this. */
  daemonRunning: boolean;
  /** Named in the stale row, so the reader can delete exactly that file. */
  lockPath: string;
}

/**
 * `lifeline stop` can only stop the service entry (`lifeline.mjs`); a repo or built agent is under no
 * supervisor, so it is `kill <pid>`.
 */
function stopHint(pid: number, commandLine: string): string {
  return commandLineIsLifelineAgent(commandLine)
    ? `${LABEL}stop it with \`lifeline stop\``
    : `${LABEL}stop it with \`kill ${pid}\` (\`lifeline stop\` cannot stop a repo agent)`;
}

export function agentStatusLines(input: AgentStatusInput): string[] {
  const { lock, probe, instances, daemonRunning, lockPath } = input;
  const path = oneLine(lockPath);
  const lines: string[] = [];

  if (lock.kind === 'absent') {
    lines.push(`${LABEL}no agent holds the machine lock`);
  }
  else if (lock.kind === 'unreadable') {
    // The same rule the acquire path refuses by: a damaged file is not an absent one, and only a scan
    // that positively found nothing hands the machine over. Without this the row would invite the
    // reader to delete a file an agent is holding — in the one situation where they cannot verify it.
    const scan = instances.kind === 'unknown' ? 'unknown' : instances.pids.length > 0 ? 'some' : 'none';
    const held = decideLock({ lock: null, readable: false, alive: false, commandLine: 'unknown', scan }) === 'refuse';
    // "A scan that failed" is checked first on purpose: `decideLock` refuses for it as well (a failed
    // probe is not a free slot), and telling the reader that an agent is running would be inventing
    // evidence — the one thing they cannot check for themselves.
    const verdict = scan === 'unknown'
      ? ' — the process scan itself failed, so nothing here is verified'
      : held
        ? ' and an agent process is still running — do not delete it'
        : ' — no agent process is running';
    lines.push(`${LABEL}${path} exists but cannot be read${verdict}`);
  }
  else {
    const file = lock.lock;
    const commandLine = probe.commandLine;
    const isAgent = commandLine != null && commandLineIsRunningAgent(commandLine);
    // "Held vs stale" is `decideLock`, the rule the acquire path refuses by — restating it here would
    // let the two drift, and the reader would be told "live holder" about a lock no agent will honor.
    const held = decideLock({
      lock: file,
      readable: true,
      alive: probe.alive,
      commandLine: commandLine == null ? 'unknown' : isAgent ? 'agent' : 'not-agent',
      scan: 'none',
    }) === 'refuse';

    if (held) {
      lines.push(
        `${LABEL}pid ${file.pid} · v${oneLine(file.version)} · ${oneLine(file.agentId)}`
        + ` · started ${new Date(file.startedAt).toISOString()}`,
      );
      // No hint at all when the command line could not be read: naming a signal for a process we
      // could not identify is how a reader kills a bystander whose pid was reused.
      if (commandLine == null) {
        lines.push(`${LABEL}its command line could not be read: inspect pid ${file.pid} before signalling it`);
      }
      else {
        lines.push(stopHint(file.pid, commandLine));
        // `lifeline stop` stops the supervisor, and a foreground `start --foreground` has the same
        // command line as the service: without this the reader runs the hint and the holder stays.
        if (commandLineIsLifelineAgent(commandLine))
          lines.push(STOP_NOTE_FOREGROUND);
      }
      if (!daemonRunning) {
        lines.push(`${LABEL}this is why a service agent cannot start: the service entry refuses while a live agent holds the lock`);
      }
    }
    else {
      const reason = probe.alive ? 'running but not a lifeline agent' : 'not running';
      lines.push(`${LABEL}stale lock: it names pid ${file.pid} (${reason}) — delete ${path} if you are sure no agent is running`);
    }
  }

  // Only when there really is more than one: a single-agent machine must not be told to look for a
  // duplicate. A scan that failed is not "no duplicates", so it prints nothing either (the row would
  // be about our own probe, not about the machine).
  if (instances.kind === 'ok' && instances.pids.length > 1) {
    lines.push(
      `${LABEL}${instances.pids.length} agent processes are running: ${instances.pids.join(', ')}`
      + ' — the server slot belongs to whichever registered last',
    );
  }
  return lines;
}
