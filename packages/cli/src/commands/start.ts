import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyCodeBuddyCdpArgv, applyCursorCdpArgv } from '../cdp-argv-state.js';
import { ensureAgentId, saveCliConfig } from '../config.js';
import { detectServiceInvocation } from '../daemon/service-context.js';
import { log, requireConfig } from '../ui.js';
import { daemonProbe, ensureDaemon } from './daemon.js';

export async function cmdStart(): Promise<void> {
  const argv = process.argv.slice(2);
  // Foreground is not a service respawn: a debug run must refuse while the service is up.
  if (argv.includes('--foreground') || argv.includes('-f')) {
    if (daemonProbe().running) {
      console.error('The background agent is already running. `lifeline stop` must come first.');
      process.exit(1);
    }
    await runAgent();
    return;
  }
  if (detectServiceInvocation(argv)) {
    await runAgent();
    return;
  }
  const outcome = ensureDaemon();
  if (outcome && !outcome.ok)
    process.exit(1);
}

export async function runAgent(): Promise<void> {
  const config = ensureAgentId(requireConfig());

  try {
    saveCliConfig(applyCodeBuddyCdpArgv(applyCursorCdpArgv(config).config).config);
  }
  catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log(`Failed to write remote-debugging-port into argv.json: ${detail}`);
  }

  // The agent reads its settings from the environment (dotenv-style), so map
  // the CLI config onto process.env before importing it. The agent module's
  // top-level main() takes over from here.
  process.env.CDP_URL = config.cdpUrl;
  process.env.REMOTE_URL = config.serverUrl;
  process.env.AGENT_TOKEN = config.agentToken;
  process.env.POLL_INTERVAL_MS = String(config.pollIntervalMs);
  process.env.DEBOUNCE_MS = String(config.debounceMs);
  if (config.agentId)
    process.env.AGENT_ID = config.agentId;

  // Selectors: explicit config wins; otherwise use the packages/agent/selectors.json
  // shipped inside the package (launchd's cwd is "/", so the agent's cwd-relative
  // default would miss and fall back to weaker built-ins).
  // NOTE: relative depth is computed by **bundle semantics** (dist/cli/lifeline.mjs → two levels up = repo root),
  // identical to the old algorithm in index.ts; after esbuild inlines this file into the bundle,
  // import.meta.url points at the bundle itself.
  if (config.selectorsPath) {
    process.env.SELECTORS_PATH = config.selectorsPath;
  }
  else {
    const bundled = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'packages',
      'agent',
      'selectors.json',
    );
    if (existsSync(bundled))
      process.env.SELECTORS_PATH = bundled;
  }

  await import('../../../agent/src/index.js');
}
