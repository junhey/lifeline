import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UplinkWatchdog as WD } from '../packages/agent/src/uplink-watchdog.js';

/** 手写假时钟：advance 按到期顺序触发，触发中新建的定时器也参与本轮回扫。 */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { fn: () => void; at: number }>();
  return {
    now: () => now,
    schedule(fn: () => void, ms: number) {
      const id = nextId++;
      timers.set(id, { fn, at: now + ms });
      return () => timers.delete(id);
    },
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        let dueId = -1;
        let due: { fn: () => void; at: number } | undefined;
        for (const [id, t] of timers) {
          if (t.at <= target && (due === undefined || t.at < due.at)) {
            due = t;
            dueId = id;
          }
        }
        if (due === undefined)
          break;
        now = due.at;
        timers.delete(dueId);
        due.fn();
      }
      now = target;
    },
    pending: () => timers.size,
  };
}

function makeWatchdog(clock: ReturnType<typeof fakeClock>) {
  const fired: Array<{ attempt: number; thresholdMs: number }> = [];
  const wd = new WD({
    thresholdMs: 1000,
    maxThresholdMs: 4000,
    onStuck: info => fired.push(info),
    schedule: clock.schedule,
  });
  return { wd, fired };
}

describe('UplinkWatchdog', () => {
  it('notifyDisconnected 后按阈值触发', () => {
    const clock = fakeClock();
    const { wd, fired } = makeWatchdog(clock);
    wd.notifyDisconnected();
    clock.advance(999);
    assert.equal(fired.length, 0);
    clock.advance(1);
    assert.equal(fired.length, 1);
    assert.equal(fired[0].attempt, 1);
    assert.equal(fired[0].thresholdMs, 1000);
  });

  it('初始连接就卡死：无 disconnect，仅 connect_error 也能 arm', () => {
    const clock = fakeClock();
    const { wd, fired } = makeWatchdog(clock);
    wd.notifyConnectError();
    clock.advance(1500);
    assert.equal(fired.length, 1);
  });

  it('连上即 disarm，永不触发', () => {
    const clock = fakeClock();
    const { wd, fired } = makeWatchdog(clock);
    wd.notifyDisconnected();
    clock.advance(500);
    wd.notifyConnected();
    clock.advance(10_000);
    assert.equal(fired.length, 0);
    assert.equal(clock.pending(), 0);
  });

  it('连上再断：streak 重启，回到基阈值', () => {
    const clock = fakeClock();
    const { wd, fired } = makeWatchdog(clock);
    wd.notifyDisconnected();
    clock.advance(1000); // fire #1
    wd.notifyConnected();
    clock.advance(999);
    wd.notifyDisconnected();
    clock.advance(999);
    assert.equal(fired.length, 1, '新 streak 用基阈值，不到 1000 不触发');
    clock.advance(1);
    assert.equal(fired.length, 2);
  });

  it('连续失败指数退避并封顶；连上归位', () => {
    const clock = fakeClock();
    const { wd, fired } = makeWatchdog(clock);
    wd.notifyDisconnected();
    clock.advance(1000); // fire1@1000, 阈值→2000
    clock.advance(1999);
    assert.equal(fired.length, 1);
    clock.advance(1); // fire2@3000, 阈值→4000
    clock.advance(3999);
    assert.equal(fired.length, 2);
    clock.advance(1); // fire3@7000, 阈值→4000（cap）
    clock.advance(4000); // fire4@11000
    assert.equal(fired.length, 4);
    assert.deepEqual(fired.map(f => f.thresholdMs), [1000, 2000, 4000, 4000]);
    wd.notifyConnected();
    wd.notifyDisconnected();
    clock.advance(999);
    assert.equal(fired.length, 4, '归位后又是基阈值');
    clock.advance(1);
    assert.equal(fired[4].thresholdMs, 1000);
  });

  it('触发后立即按新阈值重新 arm（重建中的新 socket 有完整窗口）', () => {
    const clock = fakeClock();
    const { wd, fired } = makeWatchdog(clock);
    wd.notifyDisconnected();
    clock.advance(1000);
    assert.equal(clock.pending(), 1, 'fire 后仍有挂起定时器');
    assert.equal(fired.length, 1);
  });

  it('已 arm 时重复 connect_error 不重复调度', () => {
    const clock = fakeClock();
    const { wd, fired } = makeWatchdog(clock);
    wd.notifyDisconnected();
    for (let i = 0; i < 10; i++) {
      wd.notifyConnectError();
      clock.advance(50);
    }
    clock.advance(600);
    assert.equal(fired.length, 1, '单计时器：快错误循环不会把阈值无限推后');
  });

  it('stop 后永久不触发', () => {
    const clock = fakeClock();
    const { wd, fired } = makeWatchdog(clock);
    wd.notifyDisconnected();
    clock.advance(500);
    wd.stop();
    clock.advance(10_000);
    assert.equal(fired.length, 0);
    wd.notifyDisconnected();
    clock.advance(10_000);
    assert.equal(fired.length, 0);
  });

  it('onStuck 抛错不影响下一轮重 arm', () => {
    const clock = fakeClock();
    const fired: Array<{ attempt: number; thresholdMs: number }> = [];
    const wd = new WD({
      thresholdMs: 1000,
      maxThresholdMs: 4000,
      onStuck: (info) => {
        fired.push(info);
        throw new Error('boom');
      },
      schedule: clock.schedule,
    });
    wd.notifyDisconnected();
    clock.advance(1000);
    assert.equal(fired.length, 1);
    assert.equal(clock.pending(), 1, '抛错后仍按新阈值重 arm');
    clock.advance(2000);
    assert.equal(fired.length, 2, '下一轮照常触发');
  });

  it('不传阈值时用生产默认值 5min / 60min 封顶前翻倍', () => {
    const clock = fakeClock();
    let fired = 0;
    const wd = new WD({
      onStuck: () => fired++,
      schedule: clock.schedule,
    });
    wd.notifyDisconnected();
    clock.advance(299_999);
    assert.equal(fired, 0, '默认阈值 5 分钟');
    clock.advance(1);
    assert.equal(fired, 1);
    clock.advance(600_000);
    assert.equal(fired, 2, '第二窗口翻倍为 10 分钟');
  });
});
