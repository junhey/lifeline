import type { Server as HttpServer } from 'node:http';
import type { Socket } from 'socket.io-client';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { afterEach, describe, it } from 'node:test';
import { Server as SocketServer } from 'socket.io';
import { io } from 'socket.io-client';
import { Uplink } from '../packages/agent/src/uplink.js';

/** 计数 socketFactory：默认实现 io 的包装，同时数（重）建次数。 */
function countingFactory(count: { n: number }) {
  return (url: string, opts: Parameters<typeof io>[1]): Socket => {
    count.n += 1;
    return io(url, opts);
  };
}

async function startServer(port = 0): Promise<{ http: HttpServer; sio: SocketServer; port: number }> {
  const http = createServer();
  const sio = new SocketServer(http, { path: '/agent-io' });
  sio.of('/agent').use((_socket, next) => next()); // auth 放行
  sio.of('/agent').on('connection', (socket) => {
    socket.on('agent:register', () => {
      socket.emit('agent:sync', { reason: 'connected' });
    });
  });
  await new Promise<void>(resolve => http.listen(port, () => resolve()));
  return { http, sio, port: (http.address() as { port: number }).port };
}

/** 先关 sio（销毁 WS）再关 http——http.close() 会等现存连接，顺序反了会死等。 */
async function stopServer(server: { http: HttpServer; sio: SocketServer }): Promise<void> {
  await new Promise<void>(r => server.sio.close(() => r()));
  await new Promise<void>(r => server.http.close(() => r()));
}

describe('Uplink × real socket.io', () => {
  const closers: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const close of closers.splice(0).reverse())
      await close();
  });

  it('事故复现：服务端 DISCONNECT 包 → 客户端 inert 停止重连，watchdog 超阈值重建恢复', { timeout: 15_000 }, async () => {
    // 服务端 socket.disconnect(false) = 只发 DISCONNECT 包不关连接（包必达，
    // 无竞态）。客户端收到后 Socket.destroy() → 永不自动重连——这正是部署时
    // Relay.stop 的 disconnectSockets 诱发 issue #1 的孤儿形态之一。部署时用
    // disconnect(true)（发完包再关连接），包是否赶在连接死掉前到达是竞态，
    // 两种结局分别落在本用例与下一用例。
    const server = await startServer();
    closers.push(() => stopServer(server));

    const count = { n: 0 };
    const uplink = new Uplink(`http://127.0.0.1:${server.port}`, 't', 'machine-it', undefined, undefined, {
      socketFactory: countingFactory(count),
      watchdogThresholdMs: 1_000,
      watchdogMaxThresholdMs: 2_000,
    });
    closers.push(() => uplink.disconnect());

    await once(uplink, 'connected');
    const sockets = await server.sio.of('/agent').fetchSockets();
    assert.equal(sockets.length, 1);
    sockets[0].disconnect(false);

    // socket.io-client 此时已 inert（不会自动重连）；只有 watchdog 能救。
    await once(uplink, 'connected');
    assert.equal(count.n, 2, 'inert 被孤儿化后由 watchdog 重建恢复');
    assert.ok(uplink.connected);
  });

  it('短暂服务器重启（transport close 正常路径）：socket.io 自身退避重连，watchdog 不干预', { timeout: 15_000 }, async () => {
    const server = await startServer();
    const count = { n: 0 };
    const uplink = new Uplink(`http://127.0.0.1:${server.port}`, 't', 'machine-it1', undefined, undefined, {
      socketFactory: countingFactory(count),
      watchdogThresholdMs: 6_000, // 远大于正常重连耗时
      watchdogMaxThresholdMs: 12_000,
    });
    // 构造后立即挂 closer：断言失败也保证 disconnect，重连定时器不拖住进程
    closers.push(() => uplink.disconnect());
    await once(uplink, 'connected');

    // 服务器下线又上线：客户端只看到 transport close（没有 DISCONNECT 包），
    // 走 socket.io-client 自己的 1s 退避重连。
    const port = server.port;
    await stopServer(server);
    const server2 = await startServer(port);
    closers.push(() => stopServer(server2));

    await once(uplink, 'connected');
    assert.equal(count.n, 1, '正常重连不该触发重建');
  });

  it('服务器不可用超过阈值 → watchdog 重建；服务器恢复后连上', { timeout: 15_000 }, async () => {
    const server = await startServer();
    const count = { n: 0 };
    const uplink = new Uplink(`http://127.0.0.1:${server.port}`, 't', 'machine-it2', undefined, undefined, {
      socketFactory: countingFactory(count),
      watchdogThresholdMs: 400,
      watchdogMaxThresholdMs: 800,
    });
    closers.push(() => uplink.disconnect());
    await once(uplink, 'connected');

    const port = server.port;
    await stopServer(server);

    await new Promise(r => setTimeout(r, 2_000));
    assert.ok(count.n >= 2, `断线超阈值应触发重建（实际 ${count.n} 次）`);

    const server2 = await startServer(port);
    closers.push(() => stopServer(server2));

    // watchdog 退避最多 800ms + socket.io 退避 1s 起，必须重连上
    await once(uplink, 'connected');
    assert.ok(uplink.connected);
  });
});
