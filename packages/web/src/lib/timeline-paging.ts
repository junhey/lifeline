/**
 * Paging decisions for the timeline (pure, unit-testable).
 *
 * Both triggers funnel into the same `onMaybePage` path (store `beginEarlier` + `session:get { before }`);
 * the store's in-flight cooldown (`EARLIER_RETRY_MS`) dedupes repeats — no extra state here.
 * The user-gesture gate is mandatory: without it, a programmatic settle at the loaded head
 * auto-drags the whole session page by page (measured: 3 pages / 900KB on first open).
 */
export interface PagingState {
  /** Scrolled to the very start of the loaded body (atTopStateChange). */
  atLoadedHead: boolean;
  /** The content source says earlier pages exist (pageMeta.hasMore). */
  hasMore: boolean;
  /** A real touchstart/wheel has been seen on this mount. */
  userScrolled: boolean;
  /** First rendered segment index (rangeChanged). */
  rangeStart: number;
}

/** Rendered-head proximity that arms prefetch (in segments — most rows are one segment). */
export const PREFETCH_FROM = 8;

/** "Scrolled to the loaded head": fetch the earlier page now. */
export function shouldPageAtTop(s: PagingState): boolean {
  return s.atLoadedHead && s.hasMore && s.userScrolled;
}

/** "Approaching the loaded head": prefetch so the top indicator rarely becomes visible. */
export function shouldPrefetch(s: PagingState): boolean {
  return !s.atLoadedHead && s.hasMore && s.userScrolled && s.rangeStart < PREFETCH_FROM;
}
