import type { AgentPatchPayload, PatchSeqBaseline } from '../../protocol/src/index.js';
import type { IdeKind } from './sources/types.js';
import type { CursorState } from './types.js';
import { randomUUID } from 'node:crypto';

/**
 * Stamps outgoing `state:patch` payloads with a per-IDE monotonic seq (2026-09-30).
 *
 * The server compares `seq` with the last one it saw; any hole means a patch was lost somewhere along
 * agent → uplink → server, and the server asks for a full state (see `AgentDirectory.applyPatch`).
 * `epoch` is random per agent process so a restart (seq back to 1) is not mistaken for a gap of its own.
 */
export class PatchSequencer {
  readonly epoch: string;
  private readonly seqs: Partial<Record<IdeKind, number>> = {};

  constructor(epoch: string = randomUUID()) {
    this.epoch = epoch;
  }

  /** Wrap a patch for the wire, consuming the next seq of `ide`. */
  stamp(ide: IdeKind, patch: Partial<CursorState>): AgentPatchPayload {
    const seq = (this.seqs[ide] ?? 0) + 1;
    this.seqs[ide] = seq;
    return { ide, patch, seq, epoch: this.epoch };
  }

  /**
   * Baseline to ship with `state:full`: everything up to these seqs is already inside that full state
   * (the caller reads the state synchronously in the same tick, so no patch can slip in between).
   */
  baseline(): PatchSeqBaseline {
    return { epoch: this.epoch, seqs: { ...this.seqs } };
  }
}
