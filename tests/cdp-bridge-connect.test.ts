import type { CdpClient } from '../packages/agent/src/cdp/client.js';
import type { ProbeResult } from '../packages/agent/src/cdp/probe.js';
import type { CdpIssue, CdpIssueKind } from '../packages/protocol/src/index.js';
import type { ServerConfig } from '../packages/server/src/types.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { CDPBridge } from '../packages/agent/src/cdp/bridge.js';

const workbench = 'vscode-file://vscode-app/Applications/Cursor.app/workbench.html';
const CDP_URL = 'http://127.0.0.1:9222';

function dummyConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    cdpUrl: 'http://127.0.0.1:9222',
    codebuddyCdpUrl: 'http://127.0.0.1:9223',
    serverPort: 3000,
    serverHost: '127.0.0.1',
    pollIntervalMs: 300,
    debounceMs: 10,
    selectorsPath: './selectors.json',
    logLevel: 'error',
    windowTitleQualifier: true,
    dataDir: '/tmp',
    mode: 'local',
    remoteUrl: '',
    agentToken: '',
    agentsWindow: true,
    ...overrides,
  };
}

class FakeCdpClient extends EventEmitter {
  private connected = false;

  async connect(_wsUrl: string): Promise<void> {
    this.connected = true;
  }

  disconnect(): void {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async evaluate(): Promise<unknown> {
    return null;
  }
}

function pageTarget() {
  return {
    id: 'home',
    type: 'page',
    title: 'demo-repo',
    url: workbench,
    webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/home',
  };
}

function probeOk(target = pageTarget()): ProbeResult {
  return {
    kind: 'ok',
    cdpUrl: CDP_URL,
    port: 9222,
    detail: '1 workbench',
    target,
    at: Date.now(),
  };
}

function probeFail(kind: CdpIssueKind, extra: Partial<ProbeResult> = {}): ProbeResult {
  return {
    kind,
    cdpUrl: CDP_URL,
    port: 9222,
    detail: extra.detail ?? kind,
    at: Date.now(),
    ...extra,
  };
}

describe('CDPBridge.connect', () => {
  it('does not tear down a live debugger when a second connect() overlaps', async () => {
    const clients: FakeCdpClient[] = [];
    let release!: () => void;
    const firstFetch = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fetches = 0;

    const bridge = new CDPBridge(dummyConfig(), {
      relauncher: { maybeRelaunch: async () => 'skipped-cooldown' },
      probe: async () => {
        fetches += 1;
        if (fetches === 1)
          await firstFetch;
        return probeOk();
      },
      createClient: () => {
        const client = new FakeCdpClient();
        clients.push(client);
        return client as unknown as CdpClient;
      },
    });

    const first = bridge.connect();
    await new Promise(resolve => setImmediate(resolve));
    const second = bridge.connect();
    release();
    await Promise.all([first, second]);

    assert.equal(clients.length, 1);
    assert.equal(bridge.isConnected(), true);
    assert.equal(clients[0].isConnected(), true);
  });

  it('keeps the live client if connect() is called again after success', async () => {
    const clients: FakeCdpClient[] = [];
    const bridge = new CDPBridge(dummyConfig(), {
      relauncher: { maybeRelaunch: async () => 'skipped-cooldown' },
      probe: async () => probeOk(),
      createClient: () => {
        const client = new FakeCdpClient();
        clients.push(client);
        return client as unknown as CdpClient;
      },
    });

    await bridge.connect();
    const live = bridge.getClient();
    await bridge.connect();

    assert.equal(clients.length, 1);
    assert.equal(bridge.getClient(), live);
  });

  it('does not quit Cursor when /json times out', async () => {
    let relaunch = 0;

    const bridge = new CDPBridge(dummyConfig(), {
      relauncher: {
        maybeRelaunch: async () => {
          relaunch += 1;
          return 'skipped-cooldown';
        },
      },
      probe: async () => probeFail('unknown', { detail: 'This operation was aborted' }),
      createClient: () => new FakeCdpClient() as unknown as CdpClient,
    });
    bridge.on('error', () => {});

    await bridge.connect();
    await bridge.disconnect();

    assert.equal(relaunch, 0);
  });

  it('asks to relaunch, and stays quiet when the IDE process is not running', async () => {
    let relaunch = 0;
    let relaunchPort = -1;
    const issues: Array<CdpIssue | null> = [];
    const bridge = new CDPBridge(dummyConfig(), {
      relauncher: {
        maybeRelaunch: async (port) => {
          relaunch += 1;
          relaunchPort = port;
          return 'skipped-not-running'; // ← IDE process is not running
        },
      },
      probe: async () => probeFail('no-listener', { detail: 'ECONNREFUSED' }),
      createClient: () => new FakeCdpClient() as unknown as CdpClient,
    });
    bridge.on('issue', (issue: CdpIssue | null) => issues.push(issue));
    bridge.on('error', () => {});

    await bridge.connect();
    await bridge.disconnect();

    assert.equal(relaunch, 1);
    // **Default-pass 0** (random port, then read back from the file) — "reserve no port" is the
    // core win of this change; must not fall back to the configured port just because "the file
    // has not been read yet" (that would demand 9222 again; see the next test).
    assert.equal(relaunchPort, 0);
    // Process not running = "waiting", not a fault: do not report.
    // (On a machine with only Cursor, the CodeBuddy slot stays quiet via this.)
    assert.equal(issues.length, 0);
  });

  it('stays quiet while an IDE update is in progress (ShipIt swapping the .app)', async () => {
    let relaunch = 0;
    const issues: Array<CdpIssue | null> = [];
    const bridge = new CDPBridge(dummyConfig(), {
      relauncher: {
        // IDE process still visible (quitting) + updater running → stand down
        maybeRelaunch: async () => {
          relaunch += 1;
          return 'skipped-update-in-progress';
        },
      },
      probe: async () => probeFail('no-listener', { detail: 'ECONNREFUSED' }),
      createClient: () => new FakeCdpClient() as unknown as CdpClient,
    });
    bridge.on('issue', (issue: CdpIssue | null) => issues.push(issue));
    bridge.on('error', () => {});

    await bridge.connect();
    await bridge.disconnect();

    assert.equal(relaunch, 1);
    // Update in progress = "waiting for the installer", not a fault: quiet, no issue.
    assert.equal(issues.length, 0);
  });

  it('goes quiet (30s) when the burst fuse trips instead of 500ms-storming', async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (msg?: unknown) => {
      lines.push(String(msg));
    };
    let bridge!: CDPBridge;
    try {
      const issues: Array<CdpIssue | null> = [];
      bridge = new CDPBridge(dummyConfig(), {
        relauncher: { maybeRelaunch: async () => 'skipped-throttled' },
        probe: async () => probeFail('no-listener', { detail: 'ECONNREFUSED' }),
        createClient: () => new FakeCdpClient() as unknown as CdpClient,
      });
      bridge.on('issue', (issue: CdpIssue | null) => issues.push(issue));
      bridge.on('error', () => {});

      await bridge.connect();

      assert.equal(issues.length, 1, '保险丝拦住是真实故障，仍然要上报');
      assert.equal(issues[0]?.relaunch, 'skipped-throttled');
      const reconnect = lines.filter(l => l.includes('Reconnecting in'));
      assert.ok(reconnect.some(l => l.includes('30000ms')), reconnect.join(' | '));
      assert.ok(!reconnect.some(l => l.includes('500ms')), '10 分钟窗口内不得 500ms 风暴刷日志');
    }
    finally {
      console.log = original;
      await bridge?.disconnect();
    }
  });

  it('goes quiet (30s) while a quit is pending instead of 500ms-storming', async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (msg?: unknown) => {
      lines.push(String(msg));
    };
    let bridge!: CDPBridge;
    try {
      const issues: Array<CdpIssue | null> = [];
      bridge = new CDPBridge(dummyConfig(), {
        // 保存弹窗卡住：quit 反复失败 —— 不得 500ms 风暴（没有 10 分钟上界的那种）
        relauncher: { maybeRelaunch: async () => 'skipped-quit-pending' },
        probe: async () => probeFail('no-listener', { detail: 'ECONNREFUSED' }),
        createClient: () => new FakeCdpClient() as unknown as CdpClient,
      });
      bridge.on('issue', (issue: CdpIssue | null) => issues.push(issue));
      bridge.on('error', () => {});

      await bridge.connect();

      assert.equal(issues.length, 1, 'quit 卡住是真实状态，仍然要上报');
      assert.equal(issues[0]?.relaunch, 'skipped-quit-pending');
      const reconnect = lines.filter(l => l.includes('Reconnecting in'));
      assert.ok(reconnect.some(l => l.includes('30000ms')), reconnect.join(' | '));
      assert.ok(!reconnect.some(l => l.includes('500ms')), '保存弹窗卡住期间不得 500ms 风暴刷日志');
    }
    finally {
      console.log = original;
      await bridge?.disconnect();
    }
  });

  it('quiet-wakes and probes as soon as the IDE process appears', async () => {
    let relaunch = 0;
    let probes = 0;
    let running = false;
    const bridge = new CDPBridge(dummyConfig(), {
      relauncher: { maybeRelaunch: async () => { relaunch += 1; return 'skipped-not-running'; } },
      probe: async () => {
        probes += 1;
        return probeFail('no-listener', { detail: 'ECONNREFUSED' });
      },
      createClient: () => new FakeCdpClient() as unknown as CdpClient,
      quietWake: { isRunning: () => running, pollMs: 20 },
    });
    bridge.on('issue', () => {});
    bridge.on('error', () => {});

    try {
      await bridge.connect();
      assert.equal(probes, 1);
      running = true; // 用户手动打开了 IDE
      await new Promise(r => setTimeout(r, 80));
      assert.equal(probes, 2, '上升沿立刻补一次探测，不等 30s 兜底');
      assert.equal(relaunch, 2);
    }
    finally {
      await bridge.disconnect();
    }
    running = false;
    await new Promise(r => setTimeout(r, 60));
    assert.equal(probes, 2, 'disconnect 之后 watcher 必须停');
  });

  it('does not re-probe while the IDE stays down (CDP cadence stays 30s)', async () => {
    let probes = 0;
    const bridge = new CDPBridge(dummyConfig(), {
      relauncher: { maybeRelaunch: async () => 'skipped-not-running' },
      probe: async () => {
        probes += 1;
        return probeFail('no-listener');
      },
      createClient: () => new FakeCdpClient() as unknown as CdpClient,
      quietWake: { isRunning: () => false, pollMs: 20 },
    });
    bridge.on('issue', () => {});
    bridge.on('error', () => {});
    try {
      await bridge.connect();
      await new Promise(r => setTimeout(r, 100)); // 5 个 tick 全在"没在跑"
      assert.equal(probes, 1);
    }
    finally {
      await bridge.disconnect();
    }
  });

  it('tracks the rising edge from a true baseline too (update relaunch, no-exe reopen)', async () => {
    let probes = 0;
    let running = true;
    const bridge = new CDPBridge(dummyConfig(), {
      relauncher: { maybeRelaunch: async () => 'skipped-no-exe' },
      probe: async () => {
        probes += 1;
        return probeFail('no-listener');
      },
      createClient: () => new FakeCdpClient() as unknown as CdpClient,
      quietWake: { isRunning: () => running, pollMs: 20 },
    });
    bridge.on('issue', () => {});
    bridge.on('error', () => {});
    try {
      await bridge.connect(); // no-exe → 静默；基线 = 在跑
      await new Promise(r => setTimeout(r, 60));
      assert.equal(probes, 1, '没有沿 → 不触发');
      running = false; // 更新换包：进程消失
      await new Promise(r => setTimeout(r, 60));
      assert.equal(probes, 1, '下降沿不触发');
      running = true; // ShipIt 拉起新版本
      await new Promise(r => setTimeout(r, 80));
      assert.equal(probes, 2, 'true 基线也要能捕捉 消失→再现');
    }
    finally {
      await bridge.disconnect();
    }
  });

  it('keeps using port 0 while the port file keeps moving after each relaunch', async () => {
    let mtime = 100;
    const ports: number[] = [];
    const bridge = new CDPBridge(dummyConfig(), {
      relauncher: { maybeRelaunch: async (port) => { ports.push(port); return 'relaunched'; } },
      resolveUrl: async () => ({
        cdpUrl: 'http://127.0.0.1:49999',
        source: 'config-fallback' as const,
        hasPortFile: false,
        fileMtime: mtime++,
      }),
      probe: async () => probeFail('no-listener', { detail: 'ECONNREFUSED' }),
      createClient: () => new FakeCdpClient() as unknown as CdpClient,
    });
    bridge.on('issue', () => {});
    bridge.on('error', () => {});
    for (let i = 0; i < 3; i++) await bridge.connect();
    await bridge.disconnect();

    assert.deepEqual(ports, [0, 0, 0], '文件每次都跟着动 → 位置没问题 → 一直传 0，不预留端口');
  });

  it('clears a spurious file-location verdict as soon as the file port is adopted', async () => {
    // Harmless false positive: the poll right after relaunch often happens before the IDE writes the file → latches first;
    // but once resolution adopts the file port (hasPortFile), the latch clears immediately and the next round is 0 again.
    const ports: number[] = [];
    let mtime: number | undefined = 111;
    let hasPortFile = false;
    const bridge = new CDPBridge(dummyConfig(), {
      relauncher: { maybeRelaunch: async (port) => { ports.push(port); return 'relaunched'; } },
      resolveUrl: async () => ({
        cdpUrl: 'http://127.0.0.1:49999',
        source: (hasPortFile ? 'active-port-file' : 'config-fallback') as 'active-port-file' | 'config-fallback',
        hasPortFile,
        fileMtime: mtime,
      }),
      probe: async () => probeFail('no-listener', { detail: 'ECONNREFUSED' }),
      createClient: () => new FakeCdpClient() as unknown as CdpClient,
    });
    bridge.on('issue', () => {});
    bridge.on('error', () => {});

    await bridge.connect(); // Not relaunched yet → 0
    assert.deepEqual(ports, [0]);

    await bridge.connect(); // mtime unchanged → latch → configured port
    assert.deepEqual(ports, [0, 9222]);

    hasPortFile = true; // The IDE finally wrote the file and we adopted it
    mtime = 222;
    await bridge.connect();
    assert.deepEqual(ports, [0, 9222, 0], '采纳到文件端口 = 位置没问题 → 闩被清掉，回到 0');

    // **Must tear down**: this last connect ended as no-listener → a 500ms auto-reconnect timer is armed.
    // Without teardown it spins forever (relaunch → probe still no-listener → relaunch again…),
    // and node:test waits for this file's process to exit → the whole `npm test` never returns.
    await bridge.disconnect();
  });

  it('switches to the configured port when the file never moves after a relaunch', async () => {
    // Custom `--user-data-dir`: the file we read is not the one this IDE writes → after relaunch it has not moved.
    // Passing 0 then forever reads a dead file and keeps killing the IDE (review must-fix 2) → use the configured port (it does not depend on the file).
    const ports: number[] = [];
    const bridge = new CDPBridge(dummyConfig(), {
      relauncher: { maybeRelaunch: async (port) => { ports.push(port); return 'relaunched'; } },
      resolveUrl: async () => ({
        cdpUrl: 'http://127.0.0.1:49999',
        source: 'config-fallback' as const,
        hasPortFile: false,
        fileMtime: 111, // Always the same value
      }),
      probe: async () => probeFail('no-listener', { detail: 'ECONNREFUSED' }),
      createClient: () => new FakeCdpClient() as unknown as CdpClient,
    });
    bridge.on('issue', () => {});
    bridge.on('error', () => {});
    for (let i = 0; i < 3; i++) await bridge.connect();
    await bridge.disconnect();

    // First time cannot tell (not relaunched yet) → 0; second time sees "file unchanged after relaunch" → switch to the configured port.
    assert.deepEqual(ports, [0, 9222, 9222]);
  });

  it('reports and keeps trying when the IDE is running but its CDP port is closed', async () => {
    // Regression guard for review must-fix 1: a Setapp / custom-dir install is "not found" by detectLiveIdes(),
    // but it is actually running (the relauncher returns warming-up / relaunched, not not-running) —
    // must still report + self-heal; a roster miss must not silence it.
    const issues: Array<CdpIssue | null> = [];
    const bridge = new CDPBridge(dummyConfig(), {
      relauncher: { maybeRelaunch: async () => 'skipped-warming-up' },
      probe: async () => probeFail('no-listener', { detail: 'ECONNREFUSED' }),
      createClient: () => new FakeCdpClient() as unknown as CdpClient,
    });
    bridge.on('issue', (issue: CdpIssue | null) => issues.push(issue));
    bridge.on('error', () => {});

    await bridge.connect();
    await bridge.disconnect();

    assert.equal(issues[0]?.kind, 'no-listener');
    assert.equal(issues[0]?.relaunch, 'skipped-warming-up');
  });

  it('self-heals when 9222 is occupied (not-cdp http) by relaunching on port 0', async () => {
    // Chrome (or any non-IDE) holding the configured fallback port used to only
    // surface "关掉它，或换一个端口" and never self-heal. Relaunch this IDE on
    // a random port; never re-bind the occupied configured port.
    const ports: number[] = [];
    const issues: Array<CdpIssue | null> = [];
    const bridge = new CDPBridge(dummyConfig(), {
      relauncher: {
        maybeRelaunch: async (port) => {
          ports.push(port);
          return 'relaunched';
        },
      },
      probe: async () => probeFail('not-cdp', {
        notCdpCause: 'http',
        occupant: 'Google Chrome (pid 3132)',
        detail: 'CDP target discovery failed: HTTP 404',
      }),
      createClient: () => new FakeCdpClient() as unknown as CdpClient,
    });
    bridge.on('issue', (issue: CdpIssue | null) => issues.push(issue));
    bridge.on('error', () => {});

    await bridge.connect();
    await bridge.disconnect();

    assert.deepEqual(ports, [0]);
    assert.equal(issues[0]?.kind, 'not-cdp');
    assert.equal(issues[0]?.notCdpCause, 'http');
    assert.equal(issues[0]?.relaunch, 'relaunched');
  });

  it('self-heals a foreign CDP on the configured port with port 0 (not the configured port)', async () => {
    const ports: number[] = [];
    const issues: Array<CdpIssue | null> = [];
    const bridge = new CDPBridge(dummyConfig(), {
      relauncher: {
        maybeRelaunch: async (port) => {
          ports.push(port);
          return 'relaunched';
        },
      },
      probe: async () => probeFail('not-cdp', {
        notCdpCause: 'foreign',
        browser: 'Chrome/148.0.7778.280',
        detail: 'CDP browser is Chrome/148.0.7778.280, not Cursor',
      }),
      createClient: () => new FakeCdpClient() as unknown as CdpClient,
    });
    bridge.on('issue', (issue: CdpIssue | null) => issues.push(issue));
    bridge.on('error', () => {});

    await bridge.connect();
    await bridge.disconnect();

    assert.deepEqual(ports, [0], 'occupied/foreign configured port must not be re-requested');
    assert.equal(issues[0]?.kind, 'not-cdp');
    assert.equal(issues[0]?.relaunch, 'relaunched');
  });

  it('does not attach when probe returns no-window and emits that issue', async () => {
    let created = 0;
    let relaunch = 0;
    const issues: Array<CdpIssue | null> = [];
    const bridge = new CDPBridge(dummyConfig(), {
      relauncher: {
        maybeRelaunch: async () => {
          relaunch += 1;
          return 'skipped-cooldown';
        },
      },
      probe: async () => probeFail('no-window', { detail: '0 个 target' }),
      createClient: () => {
        created += 1;
        return new FakeCdpClient() as unknown as CdpClient;
      },
    });
    bridge.on('issue', (issue: CdpIssue | null) => issues.push(issue));

    await bridge.connect();
    await bridge.disconnect();

    assert.equal(created, 0);
    assert.equal(relaunch, 0);
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.kind, 'no-window');
    assert.equal(issues[0]?.scope, 'workbench');
  });
});

describe('CDPBridge.refreshWindows', () => {
  const agentManagerUrl = 'vscode-file://vscode-app/Applications/CodeBuddy CN.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/agentManager.html';

  function targets() {
    return [
      pageTarget(),
      {
        id: 'agents',
        type: 'page',
        title: 'Cursor Agents',
        url: workbench,
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/agents',
      },
      {
        id: 'agentmanager',
        type: 'page',
        title: agentManagerUrl,
        url: agentManagerUrl,
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/agentmanager',
      },
      {
        id: 'cb',
        type: 'page',
        title: 'demo-app',
        url: workbench,
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/cb',
      },
    ];
  }

  it('includes the Cursor Agents window as kind=agents, keeps CodeBuddy agentManager out', async () => {
    const bridge = new CDPBridge(dummyConfig(), {
      relauncher: { maybeRelaunch: async () => 'skipped-cooldown' },
      fetchTargets: async () => targets(),
      createClient: () => new FakeCdpClient() as unknown as CdpClient,
    });

    const windows = await bridge.refreshWindows();

    // Project window + Agents window (CodeBuddy's agentManager still does not count as a window)
    assert.deepEqual(windows.map(w => w.id), ['home', 'agents', 'cb']);
    assert.deepEqual(windows.map(w => w.kind ?? 'project'), ['project', 'agents', 'project']);
    assert.deepEqual(windows.map(w => w.title), ['demo-repo', 'Agents', 'demo-app']);
    assert.equal(windows[1].wsUrl, 'ws://127.0.0.1:9222/devtools/page/agents');
  });

  it('drops the Agents window when AGENTS_WINDOW=0', async () => {
    const bridge = new CDPBridge(dummyConfig({ agentsWindow: false }), {
      relauncher: { maybeRelaunch: async () => 'skipped-cooldown' },
      fetchTargets: async () => targets(),
      createClient: () => new FakeCdpClient() as unknown as CdpClient,
    });

    const windows = await bridge.refreshWindows();

    assert.deepEqual(windows.map(w => w.id), ['home', 'cb']);
  });
});
