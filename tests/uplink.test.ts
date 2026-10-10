import type { Socket } from 'socket.io-client';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Uplink } from '../packages/agent/src/uplink.js';

/**
 * 假 socket：只实现 Uplink 用到的面。fire() 模拟服务端事件；
 * disconnect/removeAllListeners 记录调用，供断言 rebuild 的拆除序列。
 */
class FakeSocket {
  handlers = new Map<string, Array<(payload?: unknown) => void>>();
  anyHandlers: Array<(event: string, ...args: unknown[]) => void> = [];
  sent: Array<{ event: string; payload: unknown }> = [];
  disconnectCalls = 0;
  removeAllListenersCalls = 0;
  connected = false;

  on(event: string, fn: (payload?: unknown) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(fn);
    this.handlers.set(event, list);
    return this;
  }

  onAny(fn: (event: string, ...args: unknown[]) => void): this {
    this.anyHandlers.push(fn);
    return this;
  }

  emit(event: string, payload: unknown): this {
    this.sent.push({ event, payload });
    return this;
  }

  removeAllListeners(): this {
    this.removeAllListenersCalls += 1;
    this.handlers.clear();
    this.anyHandlers = [];
    return this;
  }

  disconnect(): this {
    this.disconnectCalls += 1;
    this.connected = false;
    return this;
  }

  fire(event: string, ...args: unknown[]): void {
    for (const fn of this.handlers.get(event) ?? []) {
      fn(...(args as []));
    }
    for (const fn of this.anyHandlers) {
      fn(event, ...args);
    }
  }
}

function makeUplink(thresholdMs = 25) {
  const sockets: FakeSocket[] = [];
  const uplink = new Uplink('http://server.test', 'token-1', 'machine-x', ['cursor'], false, {
    socketFactory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      // 重建出的 socket 在下一 tick 自动 connect（handler 在构造/rebuild 里同步
      // 挂好后才轮到它）：模拟"服务端可用"，watchdog 应就此 disarm，不再连环重建。
      if (sockets.length > 1)
        setTimeout(() => s.fire('connect'), 0);
      return s as unknown as Socket;
    },
    watchdogThresholdMs: thresholdMs,
    watchdogMaxThresholdMs: thresholdMs * 4,
  });
  return { uplink, sockets };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('Uplink watchdog rebuild', () => {
  it('connect 后发 agent:register 并转发 connected；send 走当前 socket', async () => {
    const { uplink, sockets } = makeUplink();
    let connectedCount = 0;
    uplink.on('connected', () => connectedCount++);

    sockets[0].fire('connect');
    assert.equal(connectedCount, 1);
    const register = sockets[0].sent.find(s => s.event === 'agent:register');
    assert.ok(register, 'connect 后必须发 agent:register');
    assert.equal((register!.payload as { agentId: string }).agentId, 'machine-x');

    uplink.send('state:full', { hello: 1 });
    assert.equal(sockets[0].sent.at(-1)!.event, 'state:full');

    sockets[0].fire('disconnect', 'transport close');
    sockets[0].fire('connect_error', new Error('websocket error'));
    // 未超阈值：不重建
    await sleep(5);
    assert.equal(sockets.length, 1);
  });

  it('断线超过阈值 → 拆旧建新：旧 socket removeAllListeners+disconnect，新 socket 重发 register', async () => {
    const { uplink, sockets } = makeUplink(20);
    const disconnectedEvents: string[] = [];
    uplink.on('disconnected', () => disconnectedEvents.push('d'));
    sockets[0].fire('connect');
    sockets[0].fire('disconnect', 'transport close');
    sockets[0].fire('connect_error', new Error('websocket error'));

    await sleep(150);
    assert.equal(sockets.length, 2, 'watchdog 触发重建');
    assert.ok(sockets[0].removeAllListenersCalls >= 1, '旧 socket 摘除监听');
    assert.ok(sockets[0].disconnectCalls >= 1, '旧 socket 显式关闭');
    assert.equal(disconnectedEvents.length, 1, '旧 socket 的 disconnect 只上报一次');

    // 新 socket 走完整握手
    let connectedCount = 0;
    uplink.on('connected', () => connectedCount++);
    sockets[1].fire('connect');
    assert.equal(connectedCount, 1, '重建后 connected 重新发出（index.ts 依赖它重跑 sendFullState）');
    assert.ok(sockets[1].sent.some(s => s.event === 'agent:register'), '新 socket 重发 agent:register');
    uplink.send('state:patch', {});
    assert.equal(sockets[1].sent.at(-1)!.event, 'state:patch', 'send 路由到当前 socket');
    assert.equal(sockets[0].disconnectCalls, 1, '连上后不再动旧 socket');
  });

  it('正常退出（disconnect()）不触发重建', async () => {
    const { uplink, sockets } = makeUplink(20);
    sockets[0].fire('connect');
    sockets[0].fire('disconnect', 'transport close'); // 先 arm watchdog（pending timer）
    uplink.disconnect(); // shutdown 必须取消 pending timer，而非只挡未 arm 的状态
    assert.ok(sockets[0].disconnectCalls >= 1);
    await sleep(120);
    assert.equal(sockets.length, 1, 'shutdown 路径永久停用 watchdog');
  });

  it('重建后旧 socket 事件不再影响 uplink', async () => {
    const { sockets } = makeUplink(20);
    sockets[0].fire('connect');
    sockets[0].fire('disconnect', 'transport close');
    await sleep(150);
    assert.equal(sockets.length, 2);
    const before = sockets[1].sent.length;
    sockets[0].fire('connect'); // 僵尸事件
    sockets[0].fire('agent:sync', { reason: 'stale' });
    await sleep(30);
    assert.equal(sockets[1].sent.length, before, '旧 socket 的事件被摘除，不会驱动新逻辑');
    assert.equal(sockets.length, 2);
  });
});
