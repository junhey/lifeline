/**
 * In-page scenario battery for the timeline harnesses (dev only).
 *
 * Same scenarios as the PoC evidence run (see docs/plans/2026-10-04-timeline-virtuoso-design.md):
 * open 90 (with giant row) / prepend 60 segments at top in iOS mode / append at bottom / append mid-list /
 * in-place wholesale replace / open 1000. Returns a JSON-serializable metrics object; compare across
 * implementations with the same seeds (the bodies are deterministic per seed).
 */
export interface BatteryApi {
  setBody: (count?: number, seed?: number, giantAt?: number) => unknown;
  prependPage: (count?: number, seed?: number) => unknown;
  appendTail: (count?: number, seed?: number) => unknown;
  replaceBody: (count?: number, seed?: number, prefix?: string) => unknown;
  setIosMode: (on: boolean) => unknown;
  /** Scroll container selector ('.tl-scroll' works for both harnesses — the virtuoso scroller carries the same class). */
  scrollerSelector: string;
  /** Only the virtuoso harness has scrollToIndex; the legacy one scrolls by pixels. */
  gotoMid?: () => void;
}

export async function runBattery(api: BatteryApi): Promise<Record<string, unknown>> {
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const raf2 = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const sc = () => document.querySelector<HTMLElement>(api.scrollerSelector)!;
  const items = () => Array.from(sc().querySelectorAll<HTMLElement>('[data-key]'));
  /** Discriminated union: `lost: true` carries no offset, so `a.x.offset` typechecks only after a `lost` check. */
  type Anchor = { key: string; lost: true } | { key: string; lost: false; offset: number };
  const anchorOf = (key?: string): Anchor => {
    const s = sc();
    const sr = s.getBoundingClientRect();
    if (key) {
      const el = s.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
      if (!el)
        return { key, lost: true };
      return { key, lost: false, offset: Math.round(el.getBoundingClientRect().top - sr.top) };
    }
    const top = items().find(el => el.getBoundingClientRect().bottom > sr.top + 1);
    if (!top)
      return { key: '', lost: true };
    return { key: top.dataset.key ?? '', lost: false, offset: Math.round(top.getBoundingClientRect().top - sr.top) };
  };
  const out: Record<string, unknown> = {};

  // S1 fresh open, 90 items incl. one ~21k px giant row
  let t0 = performance.now();
  api.setBody(90, 7, 41);
  await raf2(); await sleep(400);
  out.s1_open90 = {
    ms: Math.round(performance.now() - t0),
    st: Math.round(sc().scrollTop),
    sh: sc().scrollHeight,
    items: items().length,
    domNodes: document.querySelectorAll('*').length,
    atBottom: Math.round(sc().scrollHeight - sc().scrollTop - sc().clientHeight),
  };

  // S3 prepend an earlier page while pinned at the loaded head (iOS mode: native anchoring off)
  api.setIosMode(true);
  sc().scrollTo({ top: 0 }); await sleep(600);
  const a0 = anchorOf();
  api.prependPage(60); await sleep(1000);
  const a1 = anchorOf(a0.key);
  out.s3_prepend60 = {
    driftPx: a0.lost || a1.lost ? 'LOST' : a1.offset - a0.offset,
    anchor: a0.key,
  };

  // S4 append at bottom → must follow
  sc().scrollTo({ top: sc().scrollHeight }); await sleep(800);
  api.appendTail(3, 31); await sleep(800);
  out.s4_followBottom = { distFromBottomPx: Math.round(sc().scrollHeight - sc().scrollTop - sc().clientHeight) };

  // S5 append while reading mid-list → must not yank
  if (api.gotoMid)
    api.gotoMid();
  else
    sc().scrollTo({ top: sc().scrollHeight / 2 });
  await sleep(700);
  const a5 = anchorOf();
  api.appendTail(3, 32); await sleep(800);
  const a5b = anchorOf(a5.key);
  out.s5_appendMid = { driftPx: a5.lost || a5b.lost ? 'LOST' : a5b.offset - a5.offset };

  // S6 in-place wholesale replace (the black-screen class)
  api.replaceBody(300, 5, 'r'); await sleep(800);
  out.s6_replace = { items: items().length, blank: items().length === 0 };

  // S7 fresh open, 1000 items
  t0 = performance.now();
  api.setBody(1000, 11);
  await raf2(); await sleep(450);
  out.s7_open1000 = {
    ms: Math.round(performance.now() - t0),
    items: items().length,
    domNodes: document.querySelectorAll('*').length,
    atBottom: Math.round(sc().scrollHeight - sc().scrollTop - sc().clientHeight),
  };

  api.setIosMode(false);
  return out;
}
