# Agent 生命周期：一台机器一个进程

[English](../agent-lifecycle.md) | **简体中文**

> 同一台机器上为什么第二个 agent 会被拒、服务端如何决定槽位归谁，以及三个诊断面（服务端日志、
> 控制台提示、`lifeline status`）各自告诉你什么。

## 规则

一台机器只跑一个 agent 进程。两个比一个好不了：服务端槽位属于**最后注册**的那个，于是两个进程都在
上报时，页面可能连着几分钟显示**错的代码版本**，而盯着页面的人通常没法 ssh 上来查原因。

两道独立的闸，因为任何一道单独都有洞：

| 闸 | 位置 | 挡住什么 |
|---|---|---|
| 机器锁 | `packages/agent/src/single-instance.ts` | 第二个正在**启动**的进程（包括 supervisor 的重启循环）。 |
| 注册身份 | `packages/server/src/register-outcome.ts`（+ `agent-hub.ts`） | 第二个**已经在跑**的进程（锁出现之前就启动的，或来自别的 checkout）。 |
| `agent:superseded` | `packages/agent/src/superseded-outcome.ts` | 被顶替的进程自己：它下台，而不是去抢槽位。 |

没有开关可以并存。开发路径只有一条：先 `lifeline stop`，再 `pnpm run agent`。

## 锁

- **路径**：`<CONFIG_DIR>/agent.lock`，默认 `~/.lifeline/agent.lock`（`agentLockPath()`）。
- **内容**：`{ pid, agentId, version, remoteUrl, startedAt }`，JSON，由取到锁的进程写入。
- **时机**：配置加载之后、**一切可观察动作之前** —— 在 `loadSelectors`、驱动 banner、`detectLiveIdes()`
  （CDP）与 uplink 之前。所以被拒的进程从不注册、从不探调试端口、也不打驱动 banner。
- **拒绝**（`formatLockRefusal`，stderr 上一整块非空文本，非零退出）：本进程自己的身份行
  （`pid= … agentId= … v… remote=`）、持有者（pid、version、agentId、ISO 起始时间）、出路、锁路径。
  出路取自锁**已经探到的三态**：service 入口（`lifeline.mjs`）→ `lifeline stop`；repo/built agent →
  `kill <pid>`；命令行读不到 → **不给任何信号**（"inspect pid N before signalling it"）——被判为陈旧的
  pid 可能已经被无关进程复用。
- **释放**：正常退出（SIGINT/SIGTERM）时，以及被顶替的进程退出之前。`releaseAgentLock()` 只删**自己的**
  记录（`lock.pid === process.pid`）——槽位已被接管时它是 no-op，绝不碰赢家的锁。

两条看着别扭、但故意的策略：

- **探针失败不等于槽位空闲**：进程活着 + 命令行读不到 → 拒绝。只有扫描明确说没有 agent 在跑，机器才交出去。
- **损坏的锁文件不等于没有锁文件**：不可读/解析失败 → 除非扫描说 `none`，否则拒绝。`lifeline status`
  打的就是同一结论。

被 supervisor 拉起（launchd / systemd / Windows）的进程退出后会被重启；赢家让着锁，于是每次重启都被拒并非零
退出，supervisor 会按 throttle 节流下一次尝试 —— **每个 throttle 周期一次"被拒启动"就是预期输出**，每次都是
一行可读日志。不要用"退出 0"去"修"它：`KeepAlive { SuccessfulExit: false }` / `Restart=on-failure` 只重启
失败的进程。

## 注册：槽位归谁

`agent:register` 带 `instanceId`（`randomUUID()`，每个进程铸造一次，重连与 uplink 重建都保持不变）。
`decideRegister` 给每次注册分类：

| 结果 | 条件 | 效果 |
|---|---|---|
| `register` | 该 agentId 还没有连接，或同一 socket 重注册 | socket 成为 active；不告警、不发事件、不动记录。 |
| `reconnect` | 两侧都有 `instanceId` 且相等 | 新 socket 成为 active 并收到 `agent:sync`；**不**告警、**不**发 `agent:superseded`、记录不动、idle / patch epoch **不清**。 |
| `takeover` | 新来的带 `instanceId` 且与记录的不同（或记录没有），或两者都没有但 socket 不同 | 新 socket 顶替旧的；顺序：告警 → `agent:superseded` → `duplicateAgent` 记录。 |
| `takeover-after-drop` | 同上，但旧 socket 已经没了（笔记本休眠、换网络） | 同样的告警/事件/记录；`conn.instanceId` 变为 undefined。 |
| `ignore-duplicate` | 新来的**没有** `instanceId`，记录的**有**，且那个 socket 仍连着 | 新来的什么都拿不到：上报被丢弃，它的 socket id 被记住以备提升，不发事件，既有记录不动 —— 只有一行告警。 |

"谁带的是新代码"没法从版本号读出来，所以这种不对称是刻意的：能自报身份的进程，下一次注册总能拿回槽位；
不能自报身份的进程，只在没有"当前代码"的进程占着时才能拿到槽位。**失败**的注册绝不会被记成
`instanceId: undefined` 的连接（那会让它看起来像老代码进程，下一次就把槽位交给它）。

服务端**从不**主动断开被顶替的 socket。服务端发起的断开会阻止客户端重连，但 `UplinkWatchdog` 到阈值就会
重建连接并把槽位抢回来 —— 那是长达数分钟的乒乓，比"稳定的赢家 + 惰性的输家"糟糕得多。当前 agent 的 socket
消失时，仍连着的被忽略 socket 会被**提升**（成为 active、收到 `agent:sync`，并把该行身份 —— `instanceId`、
`cliVersion`、patch epoch —— 清空，因为它们描述的是已经离开的那个进程）。仍连着的被顶替 socket 会加入候选集，
机器因此是被交接下去，而不是变黑。

## 被顶替的进程

`agent:superseded` 以独立事件到达 agent（不走 `onAny` 的命令通道），订阅点在握手之后 —— 监听器存在之前到达的
事件会被丢掉，而漏掉这一个不是自愈的。`readSuperseded` 随后判决：

- **`by.instanceId` 非空（trim 之后）** → 接手的是当前代码的进程。断开连接、释放锁、非零退出（supervisor 会
  重启它；赢家的锁会拒绝那次启动）。继续活着只会让槽位来回弹。断开不是协议步骤：它关掉约 100ms 的 flush 窗口 ——
  在那窗口里一条掉线的 socket 可能重连并重注册，反过来告诉赢家"你也被顶替了"。
- **`by.instanceId` 缺失** → 一个老代码进程拿到了服务端**已经认为掉线**的槽位。打印一行点名 peer（`version`、
  `socketId`，有 `hostname` 就带上）的告警，并**继续持有锁运行**：本进程带 `instanceId`，下一次注册就是
  `takeover`，槽位会拿回来。在那之前服务端会丢弃本机的上报 —— 告警就说了这一点，它是"这一行是旧数据"的信号，
  不是"马上自愈"的承诺。

两种情况下，agent 都**不**因为收到这个事件而去重连、重注册或发 `agent:sync`。

## 诊断

1. **服务端日志** —— 每次 takeover 一行 `console.warn`：agentId、hostname、旧/新 socket id、旧/新
   `cliVersion`（或 `unknown`）、旧/新 `instanceId`（或 `none`）、时间戳。被忽略的重复注册只打自己那行。
2. **控制台** —— `duplicateAgent` 提示，点名被顶替的进程（`{ at, version, socketId, instanceId }`），在告警与
   事件之后写入，描述的是**被顶替**的那个。它在那条 socket 最终断开时清除。绝不写进 `machines` 行。
3. **`lifeline status`** —— `agent` 行（`packages/cli/src/daemon/agent-status-lines.ts`），只用锁文件与本地进程
   扫描构建（不发服务端请求，也不需要读者自己跑 `ps`）：持有者（pid、version、agentId、起始时间）+ 精确停止提示；
   `stale lock` 点名记录里的 pid 与要删的文件；`cannot be read` 并给出扫描结论（还在跑 → 不要删 / 没找到 agent 进程 /
   扫描本身失败，无法核实）；扫描到多于一个 agent 实例时列出 pid 的重复告警。锁被持有而服务探针说 daemon 没在跑时，
   这些行会说"锁就是服务 agent 起不来的原因"。持有者是 service 入口形态时，提示会复用 `STOP_NOTE_FOREGROUND`：
   `lifeline start --foreground` 与 `lifeline run` 的命令行和 service 一样，而 `lifeline stop` 停不掉前台进程。

## 两道闸修不了的两个坑

- **绝不能让两台机器共用一个 `agentId`**（复制过 `~/.lifeline/config.json`）。锁是本机的，看不见另一台机器：
  双方各自下台 → 释放**自己**的锁 → supervisor 重启 → 互相驱逐，每个 supervisor throttle 一个来回。告警里的
  `hostname` 就是让这种情况可读的东西。
- **被拒绝的启动不是一个要去追的错误**。`lifeline status` 显示一个你不认识的活持有者时，去停那个持有者（提示写了
  怎么停），不要删锁文件；只有当锁指向一个已死的 pid，或一个活着但不是 agent 的 pid 时，那个文件才轮到你删。

## 验证

```bash
node --import tsx --test tests/single-instance.test.ts tests/agent-startup-order.test.ts \
  tests/register-outcome.test.ts tests/agent-directory.test.ts \
  tests/superseded-outcome.test.ts tests/agent-status-lines.test.ts
npx tsc --noEmit && pnpm lint && pnpm test
```

手工演练（起第二个 agent、看拒绝文案、看控制台提示、看 status 行、Windows 的 CIM 路径）在
`openspec/changes/enforce-single-agent-per-machine/tasks.md`。⚠️ 直接跑 repo agent —— `pnpm run agent`，
不只是 `lifeline start` —— 会让 `cdp-bridge` **退出并重启**没有调试端口的 IDE（已实测），所以演练请在"愿意让
IDE 重启"的机器上做。
