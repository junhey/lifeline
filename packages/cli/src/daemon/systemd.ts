import type { DaemonProbe } from '../commands/daemon.js';
import type { DaemonOpts, DaemonOutcome } from '../ui.js';
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BUILD_VERSION } from '../build-version.js';
import { applyCodeBuddyCdpArgv, applyCursorCdpArgv, revertCodeBuddyCdpArgvIfManaged, revertCursorCdpArgvIfManaged } from '../cdp-argv-state.js';
import { CONFIG_DIR, loadCliConfig, LOG_DIR, saveCliConfig } from '../config.js';
import { rebuildSqliteFor } from '../installer.js';
import { log, requireConfig, resolveCliEntry, tryRun } from '../ui.js';
import { lifelinePidsExcept, processCommandLine, stopLifelinePid } from './agent-processes.js';
import { decideEnsure, pidfileProbe } from './ensure-decision.js';
import { readServiceVersion, writeServiceVersion } from './service-version.js';

export const LINUX_SERVICE_UNIT = 'lifeline.service';

/** systemd --user is absent in most containers; fall back to a detached process. */
export function hasSystemdUserManager(): boolean {
  try {
    execSync('systemctl --user show-environment', { stdio: 'ignore' });
    return true;
  }
  catch {
    return false;
  }
}

/** systemd ExecStart splits on spaces; quote absolute paths that contain them. */
function systemdArg(path: string): string {
  return path.includes(' ') ? `"${path}"` : path;
}

export function systemdUserUnit(nodeBin: string, cliEntry: string): string {
  return `[Unit]
Description=Lifeline agent
After=network-online.target

[Service]
Type=simple
ExecStart=${systemdArg(nodeBin)} ${systemdArg(cliEntry)} run
Environment=LIFELINE_SUPERVISED=1
Restart=on-failure
RestartSec=10
StandardOutput=append:${join(LOG_DIR, 'agent.out.log')}
StandardError=append:${join(LOG_DIR, 'agent.err.log')}

[Install]
WantedBy=default.target
`;
}

export function linuxUserUnitPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME || join(process.env.HOME ?? '~', '.config');
  return join(configHome, 'systemd', 'user', LINUX_SERVICE_UNIT);
}

export function unixDaemonPidPath(): string {
  return join(CONFIG_DIR, 'daemon.pid');
}

export function startDetachedAgent(cliEntry: string): number | undefined {
  mkdirSync(LOG_DIR, { recursive: true });
  const out = openSync(join(LOG_DIR, 'agent.out.log'), 'a');
  const err = openSync(join(LOG_DIR, 'agent.err.log'), 'a');
  const child = spawn(process.execPath, [cliEntry, 'run'], {
    detached: true,
    stdio: ['ignore', out, err],
    env: { ...process.env, LIFELINE_SUPERVISED: '1' },
    // Windows: without this, the fallback path (when scheduled-task registration fails) pops a console window.
    // No-op on POSIX.
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

export function readUnixDaemonPid(pidPath: string): number | null {
  try {
    const pid = Number(readFileSync(pidPath, 'utf-8').trim());
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  }
  catch {
    return null;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  }
  catch {
    return false;
  }
}

export function systemdUnitActive(): boolean {
  return execSync(`systemctl --user is-active ${LINUX_SERVICE_UNIT} || true`, {
    encoding: 'utf-8',
  }).trim() === 'active';
}

/** Live pidfile process whose command line is `lifeline.mjs`. Null when the file is stale or unreadable. */
export function pidfileServicePid(): number | null {
  const pid = readUnixDaemonPid(unixDaemonPidPath());
  if (pid == null || !pidAlive(pid))
    return null;
  const commandLine = processCommandLine(pid);
  if (commandLine == null)
    return null;
  return pidfileProbe({ pid, alive: true, commandLine }).installed ? pid : null;
}

/**
 * Alive pidfile pid whose command line could not be read.
 * That is not a stale file: deleting it and spawning would start a second agent.
 */
export function unreadableLivePidfile(): number | null {
  const pid = readUnixDaemonPid(unixDaemonPidPath());
  if (pid == null || !pidAlive(pid))
    return null;
  return processCommandLine(pid) == null ? pid : null;
}

/** A dead pid, or a live pid that is not `lifeline.mjs`, is deleted before the next spawn. */
export function clearStalePidfile(): void {
  const pidPath = unixDaemonPidPath();
  if (!existsSync(pidPath))
    return;
  const pid = readUnixDaemonPid(pidPath);
  const alive = pid != null && pidAlive(pid);
  if (!alive) {
    unlinkSync(pidPath);
    return;
  }
  const commandLine = processCommandLine(pid);
  // Alive but unreadable: keep the file. The caller must not spawn.
  if (commandLine == null)
    return;
  if (!pidfileProbe({ pid, alive: true, commandLine }).installed)
    unlinkSync(pidPath);
}

export function probePidfileRegistration(): DaemonProbe {
  const pid = readUnixDaemonPid(unixDaemonPidPath());
  const alive = pid != null && pidAlive(pid);
  const commandLine = alive && pid != null ? processCommandLine(pid) : null;
  return pidfileProbe({ pid, alive, commandLine });
}

function probeSystemdUnit(): DaemonProbe {
  const unitPath = linuxUserUnitPath();
  const installed = existsSync(unitPath);
  const cliEntry = resolveCliEntry();
  let registrationMatches = false;
  if (installed && cliEntry) {
    try {
      registrationMatches = readFileSync(unitPath, 'utf-8') === systemdUserUnit(process.execPath, cliEntry);
    }
    catch {
      registrationMatches = false;
    }
  }
  return {
    installed,
    running: systemdUnitActive(),
    registrationMatches,
  };
}

export function probeUnixDaemon(): DaemonProbe {
  if (hasSystemdUserManager())
    return probeSystemdUnit();
  return probePidfileRegistration();
}

function systemdMainPid(): number | null {
  try {
    const raw = execSync(`systemctl --user show -p MainPID --value ${LINUX_SERVICE_UNIT}`, {
      encoding: 'utf-8',
    }).trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  }
  catch {
    return null;
  }
}

function finishUnix(opts: DaemonOpts, outcome: DaemonOutcome, lines: string[]): DaemonOutcome {
  if (opts.quiet)
    return outcome;
  for (const line of lines)
    log(line);
  for (const note of outcome.notes)
    log(`  note   ${note}`);
  return outcome;
}

function otherAgentOutcome(opts: DaemonOpts, pids: number[]): DaemonOutcome {
  return finishUnix(opts, {
    ok: false,
    summary: `another lifeline agent is already running (pid ${pids.join(', ')})`,
    notes: [],
  }, [
    'Could not start the daemon.',
    `  another lifeline agent is already running (pid ${pids.join(', ')})`,
  ]);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The spawned pid has to show `lifeline.mjs` on its command line before the version file is written. */
export function pidfileAgentUp(pid: number | undefined): boolean {
  if (pid == null)
    return false;
  const deadline = Date.now() + 4000;
  do {
    if (!pidAlive(pid))
      return false;
    if (pidfileProbe({ pid, alive: true, commandLine: processCommandLine(pid) }).installed)
      return true;
    sleepSync(50);
  } while (Date.now() < deadline);
  return false;
}

function applyIdeArgv(): void {
  const cfg = loadCliConfig();
  if (cfg)
    saveCliConfig(applyCodeBuddyCdpArgv(applyCursorCdpArgv(cfg).config).config);
}

function ensurePidfileAgent(
  opts: DaemonOpts,
  ensure: 'start-only' | 'restart-in-place' | 'reinstall',
  cliEntry: string,
  nodeBin: string,
): DaemonOutcome {
  const pidPath = unixDaemonPidPath();
  const unread = unreadableLivePidfile();
  if (unread != null) {
    return finishUnix(opts, {
      ok: false,
      summary: `could not read the command line of the pidfile agent (pid ${unread})`,
      notes: [],
    }, [
      'Could not start the daemon.',
      `  could not read the command line of the pidfile agent (pid ${unread})`,
    ]);
  }
  const servicePid = pidfileServicePid();
  const foreign = lifelinePidsExcept(servicePid);
  if (foreign.length > 0)
    return otherAgentOutcome(opts, foreign);

  // Not installed is spawn-only: the probe said there is no live lifeline.mjs to kill.
  // restart-in-place and reinstall SIGTERM that pid before spawning a second one.
  if ((ensure === 'restart-in-place' || ensure === 'reinstall') && servicePid != null) {
    if (!stopLifelinePid(servicePid))
      return otherAgentOutcome(opts, [servicePid]);
  }
  clearStalePidfile();

  const notes: string[] = ['no systemd --user here, so it is not restarted after logout or reboot'];
  if (ensure === 'reinstall') {
    const sqliteError = rebuildSqliteFor(nodeBin);
    if (sqliteError)
      notes.push(`better-sqlite3 rebuild failed (${sqliteError}); chat history may be unavailable.`);
    applyIdeArgv();
  }

  mkdirSync(LOG_DIR, { recursive: true });
  const pid = startDetachedAgent(cliEntry);
  if (pid)
    writeFileSync(pidPath, `${pid}\n`);
  const up = pidfileAgentUp(pid);
  if (up)
    writeServiceVersion(BUILD_VERSION);
  const summary = pid ? `started in the background (pid ${pid})` : 'not started';
  return finishUnix(opts, { ok: Boolean(pid) && up, summary: up ? summary : 'not started', notes }, [
    `systemd --user unavailable; ${up ? summary : 'not started'}.`,
    `  logs   ${join(LOG_DIR, 'agent.out.log')}`,
    'Check with: lifeline status',
  ]);
}

/**
 * Linux daemon: prefer systemd --user (starts on login, restarts after exit);
 * in a container / without systemd, fall back to a detached background process + pidfile (no auto-restart).
 */
export function cmdDaemonUnix(action: string, opts: DaemonOpts = {}, probe?: DaemonProbe): DaemonOutcome | undefined {
  const unitPath = linuxUserUnitPath();
  const pidPath = unixDaemonPidPath();
  const systemd = hasSystemdUserManager();

  if (action === 'install') {
    requireConfig();
    const cliEntry = resolveCliEntry();
    if (!cliEntry) {
      console.error(`Cannot resolve CLI entry (argv[1]=${process.argv[1]}). Run via the installed command.`);
      process.exit(1);
    }
    const nodeBin = process.execPath;
    const seen = probe ?? probeUnixDaemon();
    const ensure = decideEnsure({
      installed: seen.installed,
      registrationMatches: seen.registrationMatches,
      running: seen.running,
      versionMatches: readServiceVersion() === BUILD_VERSION,
    });
    if (ensure === 'noop') {
      return finishUnix(opts, {
        ok: true,
        summary: systemd
          ? `already running (systemd --user ${LINUX_SERVICE_UNIT})`
          : 'already running',
        notes: [],
      }, [
        systemd
          ? `Already running: ${LINUX_SERVICE_UNIT}`
          : 'Already running.',
        `  logs   ${join(LOG_DIR, 'agent.out.log')}`,
        'Check with: lifeline status',
      ]);
    }

    // No unit file is not "not installed" when a pidfile agent is already up.
    // That process is the registration; spawning beside it would be a second agent.
    if (!systemd)
      return ensurePidfileAgent(opts, ensure, cliEntry, nodeBin);

    // Alive pidfile whose command line cannot be read blocks every unit action.
    // Do not start, restart, or enable beside a process we cannot identify.
    const unread = unreadableLivePidfile();
    if (unread != null) {
      return finishUnix(opts, {
        ok: false,
        summary: `could not read the command line of the pidfile agent (pid ${unread})`,
        notes: [],
      }, [
        'Could not start the daemon.',
        `  could not read the command line of the pidfile agent (pid ${unread})`,
      ]);
    }

    const servicePid = systemdMainPid();
    if (servicePid != null || !systemdUnitActive()) {
      const foreign = lifelinePidsExcept(servicePid);
      if (foreign.length > 0)
        return otherAgentOutcome(opts, foreign);
    }

    mkdirSync(LOG_DIR, { recursive: true });
    const notes: string[] = [];
    let ok = false;
    let summary = 'not started';
    let headline = `Could not start ${LINUX_SERVICE_UNIT}.`;

    if (ensure === 'start-only') {
      const failed = tryRun(`systemctl --user start ${LINUX_SERVICE_UNIT}`);
      ok = !failed;
      summary = failed ? 'not started' : `started (systemd --user ${LINUX_SERVICE_UNIT})`;
      if (failed) {
        notes.push(`systemctl: ${failed}`);
        notes.push(`retry by hand: systemctl --user start ${LINUX_SERVICE_UNIT}`);
      }
      headline = ok ? `Started: ${LINUX_SERVICE_UNIT}` : headline;
    }
    else if (ensure === 'restart-in-place') {
      const failed = tryRun(`systemctl --user restart ${LINUX_SERVICE_UNIT}`);
      ok = !failed;
      summary = failed ? 'not started' : `restarted (systemd --user ${LINUX_SERVICE_UNIT})`;
      if (failed) {
        notes.push(`systemctl: ${failed}`);
        notes.push(`retry by hand: systemctl --user restart ${LINUX_SERVICE_UNIT}`);
      }
      headline = ok ? `Restarted: ${LINUX_SERVICE_UNIT}` : headline;
    }
    else if (ensure === 'reinstall') {
      // Sampled before the write: enable --now does not restart a unit that is already active,
      // so the old ExecStart would keep running and the version file would still be stamped.
      const wasActive = systemdUnitActive();
      const sqliteError = rebuildSqliteFor(nodeBin);
      if (sqliteError)
        notes.push(`better-sqlite3 rebuild failed (${sqliteError}); chat history may be unavailable.`);
      mkdirSync(dirname(unitPath), { recursive: true });
      writeFileSync(unitPath, systemdUserUnit(nodeBin, cliEntry), 'utf-8');
      execSync('systemctl --user daemon-reload');
      const linger = `user services stop at logout unless lingering is on: loginctl enable-linger ${process.env.USER ?? '$USER'}`;
      if (wasActive) {
        const enableFailed = tryRun(`systemctl --user enable ${LINUX_SERVICE_UNIT}`);
        const restartFailed = tryRun(`systemctl --user restart ${LINUX_SERVICE_UNIT}`);
        const active = systemdUnitActive();
        ok = !restartFailed && active;
        summary = ok ? `restarted (systemd --user ${LINUX_SERVICE_UNIT})` : 'not started';
        if (!ok) {
          notes.push(`systemctl: ${restartFailed ?? 'unit did not become active after restart'}`);
          notes.push(`retry by hand: systemctl --user restart ${LINUX_SERVICE_UNIT}`);
        }
        else {
          if (enableFailed)
            notes.push(`systemctl: ${enableFailed}`);
          notes.push(linger);
        }
        headline = ok ? `Restarted: ${LINUX_SERVICE_UNIT}` : headline;
      }
      else {
        const failed = tryRun(`systemctl --user enable --now ${LINUX_SERVICE_UNIT}`);
        ok = !failed;
        summary = failed ? 'not started' : `started (systemd --user ${LINUX_SERVICE_UNIT})`;
        if (failed) {
          notes.push(`systemctl: ${failed}`);
          notes.push(`retry by hand: systemctl --user enable --now ${LINUX_SERVICE_UNIT}`);
        }
        else {
          notes.push(linger);
        }
        headline = ok ? `Installed and started: ${LINUX_SERVICE_UNIT}` : headline;
      }
      applyIdeArgv();
    }

    if (ok && systemdUnitActive())
      writeServiceVersion(BUILD_VERSION);
    return finishUnix(opts, { ok, summary, notes }, [
      headline,
      `  unit   ${unitPath}`,
      `  logs   ${join(LOG_DIR, 'agent.out.log')}`,
      'Check with: lifeline status',
    ]);
  }

  if (action === 'uninstall') {
    if (systemd) {
      execSync(`systemctl --user disable --now ${LINUX_SERVICE_UNIT} 2>/dev/null || true`);
      execSync(`systemctl --user reset-failed ${LINUX_SERVICE_UNIT} 2>/dev/null || true`);
    }
    if (existsSync(unitPath)) {
      unlinkSync(unitPath);
      log(`Removed ${unitPath}`);
      if (systemd)
        execSync('systemctl --user daemon-reload 2>/dev/null || true');
    }
    const pid = readUnixDaemonPid(pidPath);
    if (pid && pidAlive(pid)) {
      try {
        process.kill(pid, 'SIGTERM');
        log(`Stopped background agent (pid ${pid})`);
      }
      catch {
        /* already gone */
      }
    }
    if (existsSync(pidPath))
      unlinkSync(pidPath);
    revertCursorCdpArgvIfManaged();
    revertCodeBuddyCdpArgvIfManaged();
    return;
  }

  console.error(`Unknown daemon action: ${action} (expected install | uninstall | status)`);
  process.exit(1);
}
