import { oneLine } from './log-line.js';

/**
 * What a displaced agent does with `agent:superseded`.
 *
 * The incident (工蜂 Issue #2): the loser kept running and kept taking the slot back from the newer
 * process, so the console showed the wrong code for minutes. Which process carries the newer code
 * cannot be read from a version string, so the rule is asymmetric and lives here, where it can be
 * tested without spawning an agent:
 *
 * - the superseder **names itself** (`by.instanceId`, non-empty) → it is the code we would flap
 *   against: release the lock and exit non-zero.
 * - it does not → it took a slot the server already considered gone, so we are the newer code and we
 *   keep the lock; our next registration (the watchdog's reconnect) takes the slot back by the
 *   identity rule.
 *
 * Standing down on an unreadable payload would let a stranger kill the process that is legitimately
 * reporting this machine, so every form of "no identity" keeps the lock.
 *
 * The payload's `reason` is deliberately **not** part of the judgement: `by` is the whole rule, and
 * the only producer sends `duplicate-agent`. A reason branch today would be fitting a protocol that
 * does not exist yet.
 */
export interface SupersededPeer {
  version?: string;
  socketId?: string;
  hostname?: string;
  instanceId?: string;
}

export interface SupersededOutcome {
  /** `true` = a current-code process takes over: release the lock and exit non-zero. */
  standDown: boolean;
  /** Lines to print — stderr when standing down, a warning when keeping the lock. Never empty. */
  lines: string[];
}

/** Read the payload defensively: it crosses the network, and every value lands in a log line. */
function peerOf(payload: unknown): SupersededPeer {
  const by = (payload as { by?: unknown } | null | undefined)?.by;
  if (by == null || typeof by !== 'object')
    return {};
  const record = by as Record<string, unknown>;
  const field = (key: keyof SupersededPeer): string | undefined => {
    const raw = record[key];
    if (typeof raw !== 'string')
      return undefined;
    const trimmed = oneLine(raw).trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };
  const peer: SupersededPeer = {};
  for (const key of ['version', 'socketId', 'hostname', 'instanceId'] as const) {
    const value = field(key);
    if (value != null)
      peer[key] = value;
  }
  return peer;
}

/**
 * `v0.1.84 · socket s2 · host BOX · instance i2`, with `unknown` for the parts the server did not
 * send. The hostname is only printed when the server sent one: it is what makes the "two machines
 * share one agentId" case legible, which is exactly when the reader needs it.
 */
function describePeer(peer: SupersededPeer, withInstance: boolean): string {
  const parts = [
    peer.version ? `v${peer.version}` : 'version unknown',
    peer.socketId ? `socket ${peer.socketId}` : 'socket unknown',
    ...(peer.hostname ? [`host ${peer.hostname}`] : []),
  ];
  if (withInstance)
    parts.push(peer.instanceId ? `instance ${peer.instanceId}` : 'instance unknown');
  return parts.join(' · ');
}

export function readSuperseded(payload: unknown): SupersededOutcome {
  const peer = peerOf(payload);
  if (peer.instanceId != null) {
    return {
      standDown: true,
      lines: [
        `[agent] another process took this machine's slot: ${describePeer(peer, true)}`
        + ' — releasing the machine lock and exiting so it can report',
      ],
    };
  }
  return {
    standDown: false,
    lines: [
      `[agent] a process that does not name itself took this machine's slot: ${describePeer(peer, false)}`
      + ' — keeping the lock; this machine is not reporting until our next registration takes it back',
    ],
  };
}
