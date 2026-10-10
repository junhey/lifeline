# IDE Drivers (pluggable IDE adapters on the agent)

**English** | [简体中文](./zh-CN/ide-drivers.md)

## Topology

```
index.ts (walks registeredDrivers() and wires them)
  └─ createIdeSlot(kind)            ← skeleton only: lookup DRIVERS[kind], one lifecycle
       ├─ driver.bridgeOptions()     CDP bridge diffs (titleSuffixes/appNames/relauncher)
       ├─ driver.createExtractor()   DOMExtractor | CodeBuddyExtractor
       ├─ driver.createExecutor()    CommandExecutor | CodeBuddyExecutor
       ├─ driver.attachLive(handle)  how live state attaches after connect (the deepest split)
       └─ WindowMonitor              kind + driver.windowMonitor (declarative diffs)
```

**One driver = all wiring for one IDE**: `cdpUrlOf` (config field map), `portCandidates` (DevToolsActivePort discovery), `argvPaths` (CLI writes argv.json), `hasLiveApp` (probe — **quiet policy only, never a gate**), `openDiskAdapter` (on-disk session source: cursor SQLite / codebuddy JSON), `capabilities` (command matrix, e.g. `getPlanFull`).

## Design decisions (do not overturn these)

1. **Live-attach policy lives entirely on the driver, not as hook callbacks.** CodeBuddy is dual-connection: besides workbench CDP, live state uses a direct `CdpClient` to the coding-copilot webview, with generation (`liveGen`) and `nextReconnectDelay` backoff (engine in `cdp/relaunch-engine.ts`). Leave that state machine in the slot and `kind ===` forks grow back, so the whole block moved into `drivers/codebuddy/driver.ts`. Cursor `attachLive` is three lines (hang the workbench client).
2. **Per-slot state is a WeakMap.** The driver is a singleton; live state (gen / retry / client) on the driver instance would leak across slots — `codebuddy/driver.ts` keeps `liveStates = new WeakMap<LiveSlotHandle, LiveState>()`. Tests can build several same-kind slots without crosstalk.
3. **The driver drives live state through the `LiveSlotHandle` surface**, not slot-private fields. The surface (cdp / stateManager / extractor / executor / currentCdpUrl / test hooks) is built when `createIdeSlot` assembles; `CreateIdeSlotOptions` test hooks pass through as-is.
4. **window-monitor only lifts declarative diffs.** wsUrl filtering (`otherWindowsRequireWsUrl`) is on the driver; `pollWindowParallel` dispatch and `extractFromClient` guards stay inside the monitor (`pollCodeBuddyWindow` is bound to monitor-private state; lifting it explodes the interface; a new IDE needs a new window poll anyway).
5. **`connection:status` is per-IDE.** The agent reports per driver (payload includes `ide`); server `applyConnection` writes the matching slot. Old agents (≤0.1.72) without `ide` fall back to the cursor slot. The old `reportsConnectionStatus` quirk (cursor only) is gone.

## Checklist for a new IDE

1. `packages/protocol/src/wire.ts`: add one `IDE_KINDS` entry (types / zod / labels / lists all fan out)
2. `packages/agent/src/drivers/<kind>/`: one directory for that IDE — `driver.ts` (probe, ports, argv, disk source, capabilities) + `extractor.ts` / `executor.ts` / `live.ts` / `relaunch.ts` as needed (**the IDE's own diffs cannot be avoided**; mirror `cursor/` and `codebuddy/`)
3. `drivers/index.ts`: register
4. `window-monitor.ts`: window poll for that IDE (see decision 4)
5. CLI argv ensure/remove if that IDE needs it (table-driven at the function layer)
6. Zero server changes (`Partial<Record<IdeKind, …>>` already fans out)

## Pitfalls (criteria)

- **Runtime callback signatures include an `ide` parameter.** `ContentLiveRuntime` onSessionFull/Append/Patch/Sync is `(sessionId, messages, ide, seq)` — the runtime passes `adapter.ide`. Do not shadow it with an outer loop variable (equivalent, but missing the parameter fails TS).
- **`ContentSource.close()` is optional:** call `adapter.close?.()`.
- **`CursorWindow['kind']` is optional** (`kind?`): the driver interface types windowKind as `WindowKind`; callers `?? 'project'`.
- **Extractor callback `errorMessage` is `string | null | undefined`:** factory context types must match.
- **CodeBuddy 单选问卷的选项要点两次**（CDP 实测 2026-10-05，CodeBuddy CN 1.106.1）：IDE 自己的 `question-floating.react` 里选项 `onClick` = `onOptionSelect(v); setTimeout(() => onSubmit(), 0)`，而那个 `onSubmit` 闭包读的是**上一次**的 `selectedAnswer` —— 第一次点击只画上 `selected_`、不提交；第二次点击才提交，且提交的是**上一次**选中的那个（先点 A 再点 B，落到线上的是 A）。所以 `..._optionItem_`（single mode）必须走 `codebuddySingleOptionClickExpression`：点 → 等 `selected_` 落在这行 → 再点同一行（`selected_` 已存在时只点一次，那一下就是提交）；overlay 已经不在（答完/被关/折叠）时返回 ok 而不是 `Element not found`，否则「确认」那 ~1s 里再点另一个选项会给已答完的问卷弹报错。`..._option_`（multi mode，含多选）是 toggle 语义，必须保持一次点击 —— 双击会把刚选上的选项取消掉。**残留**：若用户在 IDE 里先手动点了一行（IDE 状态里持有一个未提交的答案），再在 Lifeline 上点**别的**选项，IDE 会在点击那一刻提交它自己持有的那个旧答案（`via: 'single-submitted'`）——这是 IDE 侧行为，agent 无法阻止。
- **Cursor 侧边栏「运行中」图标是 glass 点阵 loader**（CDP 实测 2026-10-10，Cursor 3.24.9）：运行中的会话行，前导图标是 `.agent-sidebar-cell-icon .ui-dot-grid-loader[data-shape="sine_3x3"]`（与 Agents 窗口的行同一个组件）；**旧 `.spinning-loader` / `.cursor-icon-modifier-spin` 在项目窗口里已不再出现**。`cursor/extractor.ts` 的 `cellIsRunning` 漏掉它就报 `active`，而 web 侧「行状态优先于窗口级 live」（`hasRowStatus`）→ 顶部写"空闲"、composer 不锁（用户反馈：会话明明在跑）。判定必须限定在 `.agent-sidebar-cell-icon` 槽位内：已完成行那里是 `.ui-agent-status-dot[data-variant=done-seen]`，不要把它当 running。
