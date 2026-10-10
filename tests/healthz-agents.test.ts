import type { Socket } from 'socket.io-client';
import type { ServerConfig } from '../packages/server/src/types.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { io as ioClient } from 'socket.io-client';
import { Relay } from '../packages/server/src/relay.js';
import { enrollAgentToken, TEST_AUTH_HEADER, TEST_OWNER } from './relay-auth-helpers.js';

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close();
        reject(new Error('no port'));
        return;
      }
      const { port } = addr;
      srv.close(err => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}

function serverConfig(port: number, dataDir: string): ServerConfig {
  return {
    serverPort: port,
    serverHost: '127.0.0.1',
    logLevel: 'error',
    authHeaderName: TEST_AUTH_HEADER,
    dataDir,
  };
}

describe('/healthz agents count', { concurrency: 1 }, () => {
  let dir: string;
  let port: number;
  let relay: Relay;
  let socket: Socket | null = null;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'healthz-agents-'));
    port = await getFreePort();
    relay = new Relay(serverConfig(port, dir));
    await relay.start();
  });

  afterEach(async () => {
    socket?.disconnect();
    socket = null;
    await relay.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('未连接 agent 时 agents=0；注册一个后 agents=1', { timeout: 15_000 }, async () => {
    const base = `http://127.0.0.1:${port}`;
    const before = (await (await fetch(`${base}/healthz`)).json()) as { ok: boolean; agents?: number };
    assert.deepEqual(before, { ok: true, agents: 0 });

    const token = await enrollAgentToken(base, TEST_OWNER, 'machine-healthz');
    socket = ioClient(`${base}/agent`, {
      path: '/agent-io',
      auth: { agentToken: token },
      transports: ['websocket'],
      reconnection: false,
    });
    socket.on('connect', () => {
      socket!.emit('agent:register', { agentId: 'machine-healthz', hostname: 'H', version: '9.9.9' });
    });

    // 注册是异步落账的：轮询 /healthz 直到计数变化（或超时失败）。
    const deadline = Date.now() + 5_000;
    let after: { ok: boolean; agents?: number } | undefined;
    while (Date.now() < deadline) {
      after = (await (await fetch(`${base}/healthz`)).json()) as { ok: boolean; agents?: number };
      if (after.agents === 1)
        break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(after?.agents, 1, '注册一个 agent 后 /healthz 的 agents 计数应为 1');
  });
});
