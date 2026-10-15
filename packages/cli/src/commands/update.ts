import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { DEFAULT_SERVER_URL as DEFAULT_SERVER_URL_BUILD } from '../build-config.js';
import { BUILD_VERSION as VERSION } from '../build-version.js';
import { loadCliConfig } from '../config.js';
import { bundleFileReplaced, bundleStamp, installedVersion, runInstaller, runtimeHome, runtimeNodeName } from '../installer.js';
import { log, resolveCliEntry } from '../ui.js';
import { fetchLatestVersion, isBundledRuntimeEntry, isNewer, PUBLIC_PREFIX } from '../version.js';
import { startWindowsDaemon, stopWindowsDaemon } from '../win-daemon.js';

/** Default origin for install.sh when no config is readable: baked in at build time (empty if unset). */
const DEFAULT_SERVER_URL = DEFAULT_SERVER_URL_BUILD;

export async function cmdUpdate(argv: string[]): Promise<void> {
  const force = argv.includes('--force');
  const home = runtimeHome();
  const base = (loadCliConfig()?.serverUrl ?? DEFAULT_SERVER_URL).replace(/\/+$/, '');
  // Open-source builds don't bake a default origin: with no serverUrl, don't guess — send the user to setup.
  if (!base) {
    console.error('No server configured. Run: lifeline setup --server-url <url>');
    process.exit(1);
  }

  const entry = resolveCliEntry();
  if (!isBundledRuntimeEntry(entry, home)) {
    const oneLiner
      = process.platform === 'win32'
        ? `irm ${base}${PUBLIC_PREFIX}/install.ps1 | iex`
        : `curl -fsSL ${base}${PUBLIC_PREFIX}/install.sh | sh`;
    console.error('This CLI was not installed by the one-liner installer, so it cannot update itself.');
    console.error(`  current entry: ${entry ?? process.argv[1] ?? 'unknown'}`);
    console.error('  pnpm install:  pnpm run build:cli && pnpm add -g .');
    console.error(`  one-liner:     ${oneLiner}`);
    process.exit(1);
  }

  const latest = await fetchLatestVersion(base);
  if (latest && !force && !isNewer(latest, VERSION)) {
    log(`Already up to date: v${VERSION}.`);
    return;
  }
  if (latest) {
    log(`Updating v${VERSION} → v${latest} (${base}) ...`);
  }
  else {
    log(`Reading the release manifest failed; installing from ${base} anyway ...`);
  }

  /**
   * On Windows the daemon MUST be **stopped before swapping the runtime**
   * (POSIX swaps first). The success path then runs `start` in the new bundle.
   *
   * Reason: file locks + the supervisor script. install.ps1 uses rename to dodge a running `node.exe`, but if the supervisor
   * is still alive it will respawn the process the instant runtime is renamed — the new process starts from a directory
   * that's being deleted, and the user sees "the agent vanished after the update". Stopping the task means nothing races to restart it.
   */
  const nodeBin = join(home, 'runtime', runtimeNodeName());
  const mjs = join(home, 'runtime', 'lifeline.mjs');
  const stampBefore = bundleStamp(mjs);
  const before = installedVersion(nodeBin, mjs);

  const onWindows = process.platform === 'win32';
  const stoppedForSwap = onWindows && stopWindowsDaemon();
  if (stoppedForSwap)
    log('Stopped the background agent for the swap.');

  // The installer runs `start`. Service markers would make that start skip ensure.
  const scriptEnv: NodeJS.ProcessEnv = { ...process.env, LIFELINE_SERVER: base, LIFELINE_HOME: home };
  delete scriptEnv.LIFELINE_SUPERVISED;
  delete scriptEnv.INVOCATION_ID;
  const status = await runInstaller(base, scriptEnv);

  /**
   * The installer's exit code is not the swap. On Unix `start` runs under `set -e`
   * after the new runtime is in place, so a failed start is non-zero even though
   * the new bundle is there. On Windows a terminating error can still leave status 0.
   * A `--force` reinstall of the same version keeps the version string; a replaced
   * bundle file still counts as landed. Otherwise the previous bundle is still
   * what `--version` runs.
   */
  const now = installedVersion(nodeBin, mjs);
  const replaced = bundleFileReplaced(stampBefore, bundleStamp(mjs));
  if (replaced && now == null) {
    // The file landed but `--version` did not run. Do not log `Installed: vnull`.
    if (stoppedForSwap) {
      if (startWindowsDaemon())
        console.error(`Update failed: ${mjs} did not run. The scheduled task was started again.`);
      else
        console.error(`Update failed: ${mjs} did not run. The scheduled task did not start.`);
    }
    else {
      console.error(`Update failed: ${mjs} did not run.`);
    }
    process.exit(1);
  }
  if (!replaced && (now == null || (status !== 0 && now === before))) {
    // On Windows the daemon was stopped *before* the swap, so a failed update
    // must start it again -- otherwise "just updating" leaves the user with a
    // dead agent and no obvious reason. A false result means the task is still down.
    if (onWindows && !startWindowsDaemon()) {
      console.error(`Update failed: ${mjs} did not run. The scheduled task did not start. The existing runtime was left in place.`);
      process.exit(1);
    }
    console.error(`Update failed: ${mjs} did not run. The existing runtime was left in place.`);
    process.exit(1);
  }
  log(`Installed: v${now} (${mjs})`);

  // This process is still the CLI being replaced. Its BUILD_VERSION would
  // disagree with the service-version the installer's `start` already stamped,
  // and ensuring here would write the old version back. The child is the new
  // bundle: a start that already succeeded noops, and a failed one retries.
  // Drop the service markers so that child does not skip ensure.
  const childEnv = { ...process.env };
  delete childEnv.LIFELINE_SUPERVISED;
  delete childEnv.INVOCATION_ID;
  try {
    execFileSync(nodeBin, [mjs, 'start'], { env: childEnv, stdio: 'inherit' });
  }
  catch {
    process.exit(1);
  }
  log('Check with: lifeline status');
}
