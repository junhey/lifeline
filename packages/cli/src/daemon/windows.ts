import type { DaemonProbe } from '../commands/daemon.js';
import type { DaemonOpts, DaemonOutcome } from '../ui.js';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILD_VERSION } from '../build-version.js';
import { applyCodeBuddyCdpArgv, applyCursorCdpArgv, revertCodeBuddyCdpArgvIfManaged, revertCursorCdpArgvIfManaged } from '../cdp-argv-state.js';
import { CONFIG_DIR, loadCliConfig, LOG_DIR, saveCliConfig } from '../config.js';
import { rebuildSqliteFor } from '../installer.js';
import { log, requireConfig, resolveCliEntry } from '../ui.js';
import {
  isUnlimitedExecution,
  parseWindowsAgentPids,
  parseWindowsTaskStatus,
  pollNewLifelinePids,
  queryWindowsStatement,
  runWindowsStatement,
  startWindowsDaemon,
  stopWindowsDaemon,
  WINDOWS_DAEMON_SCRIPT_NAME,
  WINDOWS_DAEMON_TASK,
  windowsDaemonScript,
  windowsLifelinePidsPsCommand,
  windowsRegisterPsCommand,
  windowsStatusPsCommand,
  windowsUnregisterPsCommand,
  writeWindowsDaemonScript,
} from '../win-daemon.js';
import { lifelinePidsExcept, listedLifelineAgentPids, stopLifelinePid } from './agent-processes.js';
import { decideEnsure } from './ensure-decision.js';
import { readServiceVersion, writeServiceVersion } from './service-version.js';
import { clearStalePidfile, pidAlive, pidfileAgentUp, pidfileServicePid, probePidfileRegistration, readUnixDaemonPid, startDetachedAgent, unixDaemonPidPath, unreadableLivePidfile } from './systemd.js';

/** On-disk path of the supervisor script (counterpart of Linux's unit and macOS's plist). */
export function windowsDaemonScriptPath(): string {
  return join(CONFIG_DIR, WINDOWS_DAEMON_SCRIPT_NAME);
}

/** The writer prefixes a BOM so PowerShell 5.1 reads UTF-8. Compare the script text without it. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

function windowsScriptMatches(nodeBin: string, cliEntry: string): boolean {
  const scriptPath = windowsDaemonScriptPath();
  if (!existsSync(scriptPath))
    return false;
  try {
    return stripBom(readFileSync(scriptPath, 'utf-8')) === stripBom(windowsDaemonScript(nodeBin, cliEntry));
  }
  catch {
    return false;
  }
}

function executionLimitNote(limit: string | undefined): string | undefined {
  if (limit && !isUnlimitedExecution(limit))
    return `ExecutionTimeLimit is ${limit} (expected PT0S/00:00:00): the scheduler will kill the agent.`;
  return undefined;
}

export function probeWindowsDaemon(): DaemonProbe {
  const task = parseWindowsTaskStatus(queryWindowsStatement(windowsStatusPsCommand()));
  const note = executionLimitNote(task.executionTimeLimit);
  if (task.state) {
    const cliEntry = resolveCliEntry();
    const probe: DaemonProbe = {
      installed: true,
      running: task.running,
      registrationMatches: cliEntry != null && windowsScriptMatches(process.execPath, cliEntry),
    };
    if (note)
      probe.note = note;
    return probe;
  }
  // No scheduled task: the pidfile process is the registration. A missing task is not
  // "not installed" while that process is still alive.
  const pidProbe = probePidfileRegistration();
  if (!note)
    return pidProbe;
  return { ...pidProbe, note };
}

/**
 * Node pids under the scheduled-task supervisor (powershell running this daemon.ps1).
 * `null` when the process query itself failed — the caller must not treat that as "no service agent".
 */
function windowsTaskAgentPids(scriptPath: string): number[] | null {
  const script = scriptPath.replace(/'/g, '\'\'');
  const stdout = queryWindowsStatement([
    `$script = '${script}'`,
    `$map = @{}`,
    `foreach ($p in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) { $map[[int]$p.ProcessId] = $p }`,
    `$agents = @()`,
    `foreach ($p in @($map.Values)) {`,
    `  if ($p.Name -ne 'node.exe' -or -not $p.CommandLine -or $p.CommandLine -notlike '*lifeline.mjs*') { continue }`,
    `  $cur = [int]$p.ProcessId`,
    `  $guard = 0`,
    `  $hit = $false`,
    `  while ($guard -lt 6 -and -not $hit -and $map.ContainsKey($cur)) {`,
    `    $proc = $map[$cur]`,
    `    if ($proc.CommandLine -and $proc.CommandLine.ToLower().Contains($script.ToLower())) { $hit = $true }`,
    `    else { $cur = [int]$proc.ParentProcessId; $guard++ }`,
    `  }`,
    `  if ($hit) { $agents += [int]$p.ProcessId }`,
    `}`,
    `'agent=' + (($agents | Select-Object -Unique) -join ',')`,
  ].join('; '));
  if (!stdout.includes('agent='))
    return null;
  return parseWindowsAgentPids(stdout);
}

/** Lifeline node pids that are not the scheduled-task agent. `null` when the task tree could not be read. */
function lifelinePidsOutsideTask(scriptPath: string): number[] | null {
  const service = windowsTaskAgentPids(scriptPath);
  if (service == null)
    return null;
  const servicePids = new Set(service);
  return listedLifelineAgentPids(
    queryWindowsStatement(windowsLifelinePidsPsCommand(process.pid)),
  ).filter(pid => !servicePids.has(pid));
}

function finishWindows(opts: DaemonOpts, outcome: DaemonOutcome, lines: string[]): DaemonOutcome {
  if (opts.quiet)
    return outcome;
  for (const line of lines)
    log(line);
  for (const note of outcome.notes)
    log(`  note   ${note}`);
  return outcome;
}

function blockedByAgent(opts: DaemonOpts, pids: number[]): DaemonOutcome {
  const summary = `another lifeline agent is already running (pid ${pids.join(', ')})`;
  return finishWindows(opts, { ok: false, summary, notes: [] }, [
    `Could not start ${WINDOWS_DAEMON_TASK}.`,
    `  ${summary}`,
  ]);
}

/** The task was stopped for the swap and Start-ScheduledTask returned false. Do not report it as running. */
function taskDidNotStart(opts: DaemonOpts, detail?: string): DaemonOutcome {
  const lines = [
    `Could not start ${WINDOWS_DAEMON_TASK}.`,
    '  the scheduled task did not start',
  ];
  if (detail)
    lines.push(`  ${detail}`);
  return finishWindows(opts, {
    ok: false,
    summary: 'the scheduled task did not start',
    notes: [],
  }, lines);
}

function applyIdeArgv(): void {
  const cfg = loadCliConfig();
  if (cfg)
    saveCliConfig(applyCodeBuddyCdpArgv(applyCursorCdpArgv(cfg).config).config);
}

/**
 * Windows daemon: a scheduled task runs a supervisor script.
 *
 * Same split as Linux — prefer the system mechanism (Task Scheduler here); if registration fails, degrade to a detached
 * process + pidfile (the agent still runs, but a crash does not self-heal; the note explains this).
 *
 * **Cannot rely on `RestartOnFailure`**: measured, it never restarts on a non-zero exit (see the top of `win-daemon.ts`).
 * Self-healing comes from the supervisor script's own loop.
 */
export function cmdDaemonWindows(action: string, opts: DaemonOpts = {}, probe?: DaemonProbe): DaemonOutcome | undefined {
  const scriptPath = windowsDaemonScriptPath();
  const pidPath = unixDaemonPidPath();

  if (action === 'install') {
    requireConfig();
    const cliEntry = resolveCliEntry();
    if (!cliEntry) {
      console.error(`Cannot resolve CLI entry (argv[1]=${process.argv[1]}). Run via the installed command.`);
      process.exit(1);
    }
    const nodeBin = process.execPath;
    const seen = probe ?? probeWindowsDaemon();
    const ensure = decideEnsure({
      installed: seen.installed,
      registrationMatches: seen.registrationMatches,
      running: seen.running,
      versionMatches: readServiceVersion() === BUILD_VERSION,
    });
    if (ensure === 'noop') {
      return finishWindows(opts, {
        ok: true,
        summary: `already running (scheduled task ${WINDOWS_DAEMON_TASK})`,
        notes: seen.note ? [seen.note] : [],
      }, [
        `Already running: ${WINDOWS_DAEMON_TASK}`,
        `  script ${scriptPath}`,
        `  logs   ${join(LOG_DIR, 'agent.out.log')}`,
        'Check with: lifeline status',
      ]);
    }

    // Before stopWindowsDaemon and before Start-ScheduledTask. An unreadable live
    // pidfile is not stale: do not stop the task and do not start a second agent.
    const unreadPid = unreadableLivePidfile();
    if (unreadPid != null) {
      return finishWindows(opts, {
        ok: false,
        summary: `could not read the command line of the pidfile agent (pid ${unreadPid})`,
        notes: [],
      }, [
        `Could not start ${WINDOWS_DAEMON_TASK}.`,
        `  could not read the command line of the pidfile agent (pid ${unreadPid})`,
      ]);
    }

    /**
     * Spawn the pidfile fallback. SIGTERM a live `lifeline.mjs` first on restart/reinstall.
     * A probe that says not installed has nothing to kill — delete a stale pidfile and spawn.
     * Never spawn beside a lifeline process that is not this pidfile.
     */
    function startPidfileAgent(entry: string, notes: string[]): { ok: boolean; summary: string; blocked?: number[] } {
      const unread = unreadableLivePidfile();
      if (unread != null) {
        return {
          ok: false,
          summary: `could not read the command line of the pidfile agent (pid ${unread})`,
        };
      }
      const servicePid = pidfileServicePid();
      const foreign = lifelinePidsExcept(servicePid);
      if (foreign.length > 0)
        return { ok: false, summary: 'not started', blocked: foreign };
      if (servicePid != null && !stopLifelinePid(servicePid))
        return { ok: false, summary: 'not started', blocked: [servicePid] };
      clearStalePidfile();
      const pid = startDetachedAgent(entry);
      if (pid)
        writeFileSync(pidPath, `${pid}\n`);
      const up = pidfileAgentUp(pid);
      if (up)
        writeServiceVersion(BUILD_VERSION);
      if (!pid)
        notes.push('retry by hand: lifeline start');
      return {
        ok: Boolean(pid) && up,
        summary: up && pid ? `started in the background (pid ${pid})` : 'not started',
      };
    }

    const task = parseWindowsTaskStatus(queryWindowsStatement(windowsStatusPsCommand()));
    if (task.state && ensure === 'start-only') {
      const before = listedLifelineAgentPids(
        queryWindowsStatement(windowsLifelinePidsPsCommand(process.pid)),
      );
      if (before.length > 0)
        return blockedByAgent(opts, before);
      const started = startWindowsDaemon();
      const fresh = pollNewLifelinePids({
        before,
        list: () => listedLifelineAgentPids(
          queryWindowsStatement(windowsLifelinePidsPsCommand(process.pid)),
        ),
      });
      if (started && fresh.length > 0)
        writeServiceVersion(BUILD_VERSION);
      const notes: string[] = [];
      if (seen.note)
        notes.push(seen.note);
      const agentUp = started && fresh.length > 0;
      const summary = !started
        ? 'not started'
        : agentUp
          ? `started (scheduled task ${WINDOWS_DAEMON_TASK})`
          : 'scheduled task running; the agent process was not visible yet';
      if (!started) {
        notes.push('retry by hand: lifeline start');
      }
      else if (!agentUp) {
        notes.push('the agent process was not visible yet — check lifeline status');
      }
      return finishWindows(opts, { ok: started, summary, notes }, [
        !started
          ? `Could not start ${WINDOWS_DAEMON_TASK}.`
          : agentUp
            ? `Started: ${WINDOWS_DAEMON_TASK}`
            : `${WINDOWS_DAEMON_TASK} is running; the agent process was not visible yet. Check: lifeline status`,
        `  script ${scriptPath}`,
        `  logs   ${join(LOG_DIR, 'agent.out.log')}`,
        'Check with: lifeline status',
      ]);
    }

    if (!task.state && ensure === 'restart-in-place') {
      const notes: string[] = ['no scheduled task here, so it is not restarted after a crash'];
      const spawned = startPidfileAgent(cliEntry, notes);
      if (spawned.blocked)
        return blockedByAgent(opts, spawned.blocked);
      return finishWindows(opts, { ok: spawned.ok, summary: spawned.summary, notes }, [
        spawned.ok ? 'Restarted the background agent.' : `Could not start ${WINDOWS_DAEMON_TASK}.`,
        `  logs   ${join(LOG_DIR, 'agent.out.log')}`,
        'Check with: lifeline status',
      ]);
    }

    if (!task.state) {
      const unread = unreadableLivePidfile();
      if (unread != null) {
        return finishWindows(opts, {
          ok: false,
          summary: `could not read the command line of the pidfile agent (pid ${unread})`,
          notes: [],
        }, [
          `Could not start ${WINDOWS_DAEMON_TASK}.`,
          `  could not read the command line of the pidfile agent (pid ${unread})`,
        ]);
      }
      const servicePid = pidfileServicePid();
      const foreign = lifelinePidsExcept(servicePid);
      if (foreign.length > 0)
        return blockedByAgent(opts, foreign);
      if (servicePid != null && !stopLifelinePid(servicePid))
        return blockedByAgent(opts, [servicePid]);
      clearStalePidfile();
    }

    const notes: string[] = [];
    const taskWasRunning = Boolean(task.state && task.running);
    // A foreground agent is not the service. Refuse before stop so the task is not left stopped.
    // The service's own node is excluded and is still replaced by the stop-then-register below.
    if (task.state) {
      const outside = lifelinePidsOutsideTask(scriptPath);
      if (outside != null && outside.length > 0)
        return blockedByAgent(opts, outside);
    }
    /**
     * Stop the previous daemon cleanly first — and it must happen before writing the script / registering.
     *
     * Measured on a real machine (2026-09-20): an agent started via the fallback path (`startDetachedAgent`) is not in the task tree,
     * so `Register-ScheduledTask -Force` does not touch it — and it keeps holding `agent.out.log`, so the new supervisor's
     * `1>>` cannot open every round and node is never spawned (the error goes into Task Scheduler's black hole). Symptom: after the upgrade
     * the web page still says "update available", because the running process is still the old one.
     *
     * Use **the same entry** (`cmdStop` / `cmdUpdate` both use it): stop's criterion is "orphans whose parent is already dead",
     * so a user-run foreground `lifeline start` is unaffected and will not be killed by mistake.
     */
    stopWindowsDaemon({ scriptPath });
    /**
     * Baseline for the read-back check ("before start" snapshot): lifeline processes **still alive** after stop.
     *
     * Two uses: ① set-difference against the after-start snapshot — only **new** pids count as "the agent this run started";
     * ② ones stop cannot collect (a user's foreground `lifeline start`) must be stated: while they hold `agent.out.log`
     * the new agent cannot start (the measured `1>>` failure; see supervisor.log in the supervisor script).
     *
     * `excludePid: process.pid` cannot be omitted: the CLI's own command line is
     * `node.exe …lifeline.mjs daemon install`, which also matches the probe criterion (found in code review on a real machine).
     */
    const pidsBefore = listedLifelineAgentPids(
      queryWindowsStatement(windowsLifelinePidsPsCommand(process.pid)),
    );
    if (pidsBefore.length > 0) {
      if (taskWasRunning && !startWindowsDaemon()) {
        return taskDidNotStart(
          opts,
          `another lifeline agent is already running (pid ${pidsBefore.join(', ')})`,
        );
      }
      return blockedByAgent(opts, pidsBefore);
    }

    if (ensure === 'reinstall') {
      const sqliteError = rebuildSqliteFor(nodeBin);
      if (sqliteError)
        notes.push(`better-sqlite3 rebuild failed (${sqliteError}); chat history may be unavailable.`);
      // UTF-8 with BOM: the script embeds a path that may not be ASCII (Chinese username).
      writeWindowsDaemonScript(scriptPath, nodeBin, cliEntry);
    }
    mkdirSync(LOG_DIR, { recursive: true });

    let ok = runWindowsStatement(windowsRegisterPsCommand({ scriptPath }));
    let summary: string;
    /** Task running ≠ agent running: only a new pid in the process-table set-difference counts as actually up. */
    let agentUp = true;
    let taskReportsRunning = false;
    if (ok) {
      summary = `started (scheduled task ${WINDOWS_DAEMON_TASK})`;
      // Read-back check: ExecutionTimeLimit defaults to 72 hours; the agent would vanish **silently** after three days.
      const status = parseWindowsTaskStatus(queryWindowsStatement(windowsStatusPsCommand()));
      if (status.executionTimeLimit && !isUnlimitedExecution(status.executionTimeLimit)) {
        notes.push(
          `ExecutionTimeLimit is ${status.executionTimeLimit} (expected PT0S/00:00:00): the scheduler will kill the agent.`,
        );
      }
      taskReportsRunning = Boolean(status.running);
      if (!status.running)
        notes.push('the task is registered but did not report Running yet; check `lifeline status`.');
      // Task Running only means the supervisor is running. Cold start on a real machine
      // (PowerShell 5.1 plus Defender scanning the new script) can take about 10s, so a
      // single 3s snapshot misses and the missing version stamp makes the next start restart.
      const fresh = pollNewLifelinePids({
        before: pidsBefore,
        list: () => listedLifelineAgentPids(
          queryWindowsStatement(windowsLifelinePidsPsCommand(process.pid)),
        ),
      });
      if (fresh.length === 0) {
        agentUp = false;
        if (taskReportsRunning) {
          summary = 'scheduled task running; the agent process was not visible yet';
          notes.push('the agent process was not visible yet — check lifeline status');
        }
        else {
          summary = 'installed, but the agent process did not come up';
          notes.push(
            `the agent process did not come up — check ${LOG_DIR}; if the launch itself failed, supervisor.log says why`,
          );
        }
      }
      else {
        writeServiceVersion(BUILD_VERSION);
      }
    }
    else {
      notes.push('the scheduled task could not be registered, so it is not restarted after a crash');
      const spawned = startPidfileAgent(cliEntry, notes);
      // Unreadable command line and a detached process that did not come up have no
      // blocked list. The task was already stopped; put it back before any failure return.
      if (!spawned.ok && taskWasRunning && !startWindowsDaemon())
        return taskDidNotStart(opts, spawned.summary);
      if (spawned.blocked)
        return blockedByAgent(opts, spawned.blocked);
      ok = spawned.ok;
      agentUp = spawned.ok;
      summary = spawned.summary;
    }

    if (ensure === 'reinstall')
      applyIdeArgv();

    // Spell out the three exits separately; don't paper over "didn't come up" with a single "Installed and started".
    return finishWindows(opts, { ok, summary, notes }, [
      !ok
        ? `Could not start ${WINDOWS_DAEMON_TASK}.`
        : agentUp
          ? `Installed and started: ${WINDOWS_DAEMON_TASK}`
          : taskReportsRunning
            ? `${WINDOWS_DAEMON_TASK} is running; the agent process was not visible yet. Check: lifeline status`
            : `Installed ${WINDOWS_DAEMON_TASK}, but the agent is not running.`,
      `  script ${scriptPath}`,
      `  logs   ${join(LOG_DIR, 'agent.out.log')}`,
      'Check with: lifeline status',
    ]);
  }

  if (action === 'uninstall') {
    runWindowsStatement(windowsUnregisterPsCommand(WINDOWS_DAEMON_TASK, scriptPath));
    if (existsSync(scriptPath)) {
      unlinkSync(scriptPath);
      log(`Removed ${scriptPath}`);
    }
    const pid = readUnixDaemonPid(pidPath);
    if (pid && pidAlive(pid)) {
      try {
        process.kill(pid);
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
