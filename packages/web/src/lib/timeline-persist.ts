import type { ChatElement } from '../net/protocol';

/**
 * Restorable timeline position: the topmost visible segment (key + viewport offset) plus the body-head id
 * the capture was taken against. Restored via `initialTopMostItemIndex` on the anchor + one exact offset
 * correction — the same primitives as the prepend correction (react-virtuoso's own `restoreStateFrom`
 * snapshot was measured unusable under our `firstItemIndex` protocol: restored size-ranges balloon the
 * estimated list ~2× and the viewport lands at 0 / the bottom of the wrong height).
 *
 * A snapshot only restores onto a body whose head still matches — after a cold reload only the tail
 * page may be loaded, and the anchor may be missing (fall back to bottom).
 */
export interface TlSnapshot {
  headId: string;
  /** Segment key of the topmost visible item at capture (restore target). */
  anchorKey: string;
  /** That item's top relative to the viewport top at capture (negative once scrolled past). */
  anchorOffset: number;
}

export function canRestore(snap: TlSnapshot | null | undefined, body: ChatElement[] | undefined | null): boolean {
  return !!snap && !!body && body.length > 0 && body[0].id === snap.headId;
}

/* ------------------------------------------------------------
   Storage: in-memory survives session switches (SPA lifetime); sessionStorage survives reloads.
   All sessionStorage access is try/catch'd (private mode / quota) and window-guarded (SSR/tests).
   ------------------------------------------------------------ */
const SNAPSHOT_PREFIX = 'vtl:';
const snapshots = new Map<string, TlSnapshot>();

export function loadSnapshot(key: string): TlSnapshot | null {
  const memo = snapshots.get(key);
  if (memo)
    return memo;
  try {
    const raw = typeof window === 'undefined' ? null : window.sessionStorage.getItem(SNAPSHOT_PREFIX + key);
    if (raw)
      return JSON.parse(raw) as TlSnapshot;
  }
  catch { /* private mode: in-memory only */ }
  return null;
}

export function saveSnapshot(key: string, snap: TlSnapshot): void {
  snapshots.set(key, snap);
  try {
    if (typeof window !== 'undefined')
      window.sessionStorage.setItem(SNAPSHOT_PREFIX + key, JSON.stringify(snap));
  }
  catch { /* private mode */ }
}

/** Drop a session's remembered position (harness: "open a fresh session" semantics). */
export function clearTimelineSnapshot(key: string): void {
  snapshots.delete(key);
  try {
    if (typeof window !== 'undefined')
      window.sessionStorage.removeItem(SNAPSHOT_PREFIX + key);
  }
  catch { /* private mode */ }
}
