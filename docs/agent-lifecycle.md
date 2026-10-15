# Agent lifecycle: one process per machine

**English** | [简体中文](./zh-CN/agent-lifecycle.md)

> Why a second agent on the same machine is refused, how the server decides who owns the slot, and what
> each of the three diagnosis surfaces (`server log`, console notice, `lifeline status`) tells you.

## The rule

One agent process per machine. Two of them are worse than one: the server slot belongs to whichever
registered last, so the console can show the **wrong code** for minutes while both processes keep
reporting, and the person staring at the page usually cannot ssh in to find out why.

Two independent guards, because either one alone has a hole:

| Guard | Where | Catches |
|---|---|---|
| Machine lock | `packages/agent/src/single-instance.ts` | A second process **starting** (including a supervisor relaunch loop). |
| Registration identity | `packages/server/src/register-outcome.ts` (+ `agent-hub.ts`) | A second process that is **already running** (started before the lock existed, or from another checkout). |
| `agent:superseded` | `packages/agent/src/superseded-outcome.ts` | The displaced process itself: it stands down instead of fighting for the slot. |

There is no opt-out. The documented dev path is `lifeline stop` first, then `pnpm run agent`.

## The lock

- **Path**: `<CONFIG_DIR>/agent.lock` — `~/.lifeline/agent.lock` by default (`agentLockPath()`).
- **Contents**: `{ pid, agentId, version, remoteUrl, startedAt }`, JSON, written by the taking process.
- **When**: after config load, **before** anything observable — before `loadSelectors`, the driver
  banner, `detectLiveIdes()` (CDP) and the uplink. A refused start therefore never registers, never
  probes a debug port and never prints a driver banner.
- **Refusal** (`formatLockRefusal`, one non-empty block on stderr, non-zero exit): this process's own
  identity line (`pid= … agentId= … v… remote=`), the holder (pid, version, agentId, ISO start time),
  the way out, and the lock path. The way out is chosen from the tri-state the lock already probed —
  `lifeline stop` for the service entry (`lifeline.mjs`), `kill <pid>` for a repo/built agent, and
  **no signal at all** when the holder's command line could not be read ("inspect pid N before
  signalling it"): a pid that was classified stale may already be a bystander's.
- **Release**: on shutdown (SIGINT/SIGTERM) and before a superseded process exits. `releaseAgentLock()`
  only deletes **its own** record (`lock.pid === process.pid`) — if the slot was taken over meanwhile,
  it is a no-op and the winner's lock is never touched.

Two policies that look wrong but are deliberate:

- **A failed probe is not a free slot.** Alive + command line unreadable → refuse. Only a scan that
  positively finds no agent hands the machine over.
- **A damaged lock file is not an absent one.** Unreadable/unparseable → refuse unless the scan says
  `none`. That is also what `lifeline status` prints for it.

A supervised agent that exits is relaunched by launchd / systemd / the Windows supervisor. Since the
winner holds the lock, every relaunch is refused and exits non-zero, and the supervisor throttles the
next attempt — **one refused start per throttle interval is the expected output**, and each one is a
legible log line. Do not "fix" it by exiting zero: `KeepAlive { SuccessfulExit: false }` /
`Restart=on-failure` only relaunch a failed process.

## Registration: who owns the slot

`agent:register` carries an `instanceId` (`randomUUID()`, minted once per process, stable across
reconnects and uplink rebuilds). `decideRegister` classifies every registration:

| Outcome | When | Effect |
|---|---|---|
| `register` | No connection for this agentId, or the same socket re-registering | Socket becomes active; no warn, no event, no record. |
| `reconnect` | Both sides carry an `instanceId` and they are equal | New socket becomes active and gets `agent:sync`; **no** warn, **no** `agent:superseded`, record untouched, idle / patch epoch **not** cleared. |
| `takeover` | The newcomer carries an `instanceId` and the recorded one differs (or is absent), or both omit it and the socket differs | New socket replaces the old; warn → `agent:superseded` → `duplicateAgent` record. |
| `takeover-after-drop` | Same, but the incumbent socket is gone (laptop sleep, network change) | Same warn/event/record; `conn.instanceId` becomes undefined. |
| `ignore-duplicate` | The newcomer carries **no** `instanceId`, the recorded connection **does**, and that socket is still connected | The newcomer gets nothing: its reports are dropped, its socket id is remembered for promotion, no event, existing record untouched — only a warn. |

Which process carries newer code cannot be read from a version string, so the asymmetry is deliberate:
a process that names itself always wins the slot back on its next registration; a process that cannot
name itself only gets the slot when nobody current is holding it. A **failed** registration is never
recorded as a connection with `instanceId: undefined` (that would look like an old-code process and
hand it the slot on the next attempt).

The server never disconnects the displaced socket. A server-initiated disconnect stops client-side
reconnection, but `UplinkWatchdog` rebuilds the connection at its threshold and takes the slot back —
a multi-minute ping-pong, worse than a stable winner with an inert loser. When the current agent's
socket goes away, a still-connected ignored socket is **promoted** (it becomes active, gets
`agent:sync`, and the row's identity — `instanceId`, `cliVersion`, patch epoch — is cleared, because it
described the process that left). Displaced sockets that are still connected join the candidate set, so
the machine is handed on instead of going dark.

## The displaced process

`agent:superseded` reaches the agent as its own event (not through the `onAny` command path) and is
subscribed right after the handshake — an event that arrives before the listener exists is dropped, and
missing this one is not self-healing. `readSuperseded` then decides:

- **`by.instanceId` non-empty (after trimming)** → a current-code process takes over. Disconnect, release
  the lock, exit non-zero (the supervisor relaunches it; the winner's lock refuses that start).
  Staying alive would only flap the slot. The disconnect is not a protocol step: it closes the ~100 ms
  flush window in which a dropped socket could reconnect and re-register, telling the winner that *it*
  was superseded too.
- **`by.instanceId` absent** → an old-code process took a slot the server already considered dropped. Log
  a warning naming the peer (`version`, `socketId`, `hostname` when sent) and **keep running with the
  lock**: this process carries an `instanceId`, so its next registration is a `takeover` and takes the
  slot back. Until then the server drops what this machine reports — the warning says so, and it is a
  stale-row signal, not something that fixes itself immediately.

In neither case does the agent reconnect, re-register or emit `agent:sync` in reaction to the event.

## Diagnosis

1. **Server log** — one `console.warn` per takeover: agentId, hostname, old/new socket id, old/new
   `cliVersion` (or `unknown`), old/new `instanceId` (or `none`), timestamp. An ignored duplicate logs
   only its own line.
2. **Console** — a `duplicateAgent` notice naming the displaced process (`{ at, version, socketId,
   instanceId }`), written after the warn and the event, describing the **displaced** process. It clears
   when that socket finally drops. Never persisted to the `machines` row.
3. **`lifeline status`** — the `agent` rows (`packages/cli/src/daemon/agent-status-lines.ts`), built from
   the lock file and the local process scan only (no server request, no `ps` needed from the reader):
   holder (pid, version, agentId, start time) with the exact stop hint; `stale lock` naming the recorded
   pid and the file to delete; `cannot be read` plus what the scan makes of it (still running → do not
   delete / no agent process found / scan failed, nothing verified); and a duplicate warning listing the
   pids when more than one agent instance is running. When the lock is held while the service probe says
   the daemon is not running, the rows say that the lock is why a service agent cannot start.
   The holder row reuses `STOP_NOTE_FOREGROUND` when the holder looks like the service entry: `lifeline
   start --foreground` and `lifeline run` have the same command line, and `lifeline stop` does not stop
   a foreground process.

## Two pitfalls the guards cannot fix

- **Never let two machines share one `agentId`** (a copied `~/.lifeline/config.json`). The lock is
  machine-local, so it cannot see the other machine: each side's stand-down frees its *own* lock, its
  supervisor relaunches it, and the two take turns evicting each other at one round per supervisor
  throttle. The peer's `hostname` in the warn is what makes this legible.
- **A refused start is not an error to chase.** If `lifeline status` shows a live holder you do not
  recognise, stop that holder (the hint says how) instead of deleting the lock file; a lock naming a dead
  pid, or a live pid that is not an agent, is the only case where the file is yours to delete.

## Verify

```bash
node --import tsx --test tests/single-instance.test.ts tests/agent-startup-order.test.ts \
  tests/register-outcome.test.ts tests/agent-directory.test.ts \
  tests/superseded-outcome.test.ts tests/agent-status-lines.test.ts
npx tsc --noEmit && pnpm lint && pnpm test
```

### Drills (the parts no test can reach)

⚠️ Running the repo agent directly — `pnpm run agent`, not only `lifeline start` — makes `cdp-bridge`
**quit and relaunch** an IDE that has no debug port, on that machine only. A start refuses *before* any
CDP work only when a lock is already held, so every drill below needs a machine whose IDE you are willing
to have restarted (and that already ran `lifeline setup`).

1. **Two agents**: `pnpm run agent` in one terminal (it wins the lock), then a second one in another — it
   must refuse with its identity line, the holder row and the `kill <pid>` hint (a repo agent is not
   stoppable through `lifeline stop`), exit non-zero, and **not** probe CDP or print a driver banner.
2. **`lifeline status`** (`npx tsx packages/cli/src/index.ts status` from the checkout): one holder row
   (pid, version, agentId, start time) with the same hint, and the duplicate warning once both are alive.
3. **Supervisor**: with the dev agent holding the lock, each relaunch of the supervised agent is refused
   once per supervisor throttle interval — that is the expected output, one legible line per attempt.
4. **Takeover, old vs current**: with a current-code agent reporting, register one whose payload omits
   `instanceId` (a pre-change binary, or a one-off script) — the server warns, the current agent keeps
   reporting, the console shows the duplicate notice, and the ignored socket is promoted when the current
   one leaves.
5. **Windows**: `lifeline status` there runs one more CIM query (plus one when the lock is held and its
   pid is alive) and folds a tsx wrapper plus its child into a single instance.
