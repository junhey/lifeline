import type { MachineInfo } from '../net/protocol';

/**
 * What the console says about a machine whose slot was taken over.
 *
 * The incident (工蜂 Issue #2) was a **silent** displacement: the loser's reports are dropped and the
 * row shows the winner's code, so nothing on the page told the reader that the state in front of
 * them was not from the agent they started. This is the copy that says so, at the "可更新" chip's
 * level and neutral in tone — it is not an error of the machine.
 *
 * One pure function serves **both** normal machine rows and content-source-only rows (the web has
 * no component-test harness; precedent: `lib/version.ts`).
 */
export interface MachineNotice {
  /** Row copy naming the displaced process; undefined = nothing displaced (or nothing to say). */
  displaced?: string;
  /** The reporter is not a release build (`0.0.0-dev`): without a marker a dev agent looks healthy. */
  devBuild: boolean;
}

/** `1.2.3` = a release; anything else (`0.0.0-dev`, `unknown`, absent) is not. */
function isReleaseVersion(version: string | undefined): boolean {
  return /^\d+\.\d+\.\d+$/.test((version ?? '').trim());
}

export function machineNotice(
  machine: Pick<MachineInfo, 'cliVersion' | 'duplicateAgent'>,
): MachineNotice {
  const displacedVersion = machine.duplicateAgent?.version;
  return {
    // The record describes the process whose reports are being dropped: naming its version is what
    // tells the reader which code this row is *not* showing.
    ...(machine.duplicateAgent
      ? { displaced: displacedVersion ? `已顶替 v${displacedVersion}` : '已顶替旧 agent' }
      : {}),
    devBuild: machine.cliVersion != null && !isReleaseVersion(machine.cliVersion),
  };
}
