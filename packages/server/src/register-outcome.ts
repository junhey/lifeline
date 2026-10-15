/**
 * How the server classifies one `agent:register`.
 *
 * The slot used to be last-wins: any registration carrying the same agentId replaced the recorded
 * socket, which is how a stale dev process (or an old binary left over from an update) could take
 * the slot from a running current agent and have every one of its reports dropped **silently** —
 * the console then shows the loser's code and nothing says so (工蜂 Issue #2).
 *
 * The fix is to decide by **process identity** (`instanceId`, minted once per agent process and
 * stable across watchdog rebuilds) instead of by "which socket arrived last". A process that
 * cannot identify itself (any binary older than this change) only gets the slot when nobody
 * current is holding it.
 */
export type RegisterDecision
  = | 'register'
    | 'reconnect'
    | 'takeover'
    | 'ignore-duplicate'
    | 'takeover-after-drop';

export interface RegisterDecisionInput {
  /** False when this agentId has no recorded connection at all. */
  hasRecordedConnection: boolean;
  /** The recorded connection's socket is the incoming socket (a re-registration). */
  sameSocket: boolean;
  /** Only meaningful when the recorded socket exists and differs from the incoming one. */
  recordedSocketConnected: boolean;
  /** Incoming `instanceId`; `undefined` = an agent that predates this field. */
  incomingInstanceId?: string;
  /** Recorded `instanceId`; `undefined` = the process on the slot predates this field. */
  recordedInstanceId?: string;
}

export function decideRegister(input: RegisterDecisionInput): RegisterDecision {
  if (!input.hasRecordedConnection || input.sameSocket)
    return 'register';
  // Both sides can name themselves: equal ids are one process reconnecting, different ids are a
  // genuine upgrade (or a restart), and either way the newcomer may take the slot.
  if (input.incomingInstanceId != null) {
    return input.recordedInstanceId != null && input.recordedInstanceId === input.incomingInstanceId
      ? 'reconnect'
      : 'takeover';
  }
  // The newcomer cannot name itself. If a current process holds the slot and is still connected, it
  // keeps it — this is the row that closes the incident. Once that socket is gone, the old process
  // may take the slot back, so a machine whose current agent exited is never left with nobody.
  if (input.recordedInstanceId != null)
    return input.recordedSocketConnected ? 'ignore-duplicate' : 'takeover-after-drop';
  // Two pre-change binaries: nothing to compare, keep today's late-wins behaviour.
  return 'takeover';
}
