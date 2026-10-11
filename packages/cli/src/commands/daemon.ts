import type { DaemonOpts, DaemonOutcome } from '../ui.js';
import { cmdDaemonLaunchd, probeLaunchdDaemon } from '../daemon/launchd.js';
import { cmdDaemonUnix, probeUnixDaemon } from '../daemon/systemd.js';
import { cmdDaemonWindows, probeWindowsDaemon } from '../daemon/windows.js';
import { log } from '../ui.js';

export interface DaemonProbe {
  installed: boolean;
  running: boolean;
  registrationMatches: boolean;
  note?: string;
}

/** Platform snapshot used by ensure and daemon status. */
export function daemonProbe(): DaemonProbe {
  if (process.platform === 'win32')
    return probeWindowsDaemon();
  if (process.platform !== 'darwin')
    return probeUnixDaemon();
  return probeLaunchdDaemon();
}

export function logDaemonStatus(probe: DaemonProbe): void {
  const label = !probe.installed ? 'not installed' : probe.running ? 'running' : 'stopped';
  log(`daemon   ${label}`);
  if (probe.note)
    log(`  note   ${probe.note}`);
}

/** `lifeline daemon <install|uninstall|status>` — dispatch to the platform implementation. */
export function cmdDaemon(action: string, opts: DaemonOpts = {}): DaemonOutcome | undefined {
  if (action === 'status') {
    logDaemonStatus(daemonProbe());
    return;
  }
  const probe = action === 'install' ? daemonProbe() : undefined;
  if (process.platform === 'win32')
    return cmdDaemonWindows(action, opts, probe);
  if (process.platform !== 'darwin')
    return cmdDaemonUnix(action, opts, probe);
  return cmdDaemonLaunchd(action, opts, probe);
}

/** Install-or-start path shared by `lifeline start` and `daemon install`. */
export function ensureDaemon(opts: DaemonOpts = {}): DaemonOutcome | undefined {
  return cmdDaemon('install', opts);
}
