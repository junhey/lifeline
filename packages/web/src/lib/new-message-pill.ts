export type PillEvent
  = | { type: 'append'; n: number }
    | { type: 'bottom'; atBottom: boolean }
    | { type: 'seen' };

/** New-message pill counter: accumulates appended segments while the view is away from the bottom. */
export function pillCount(prev: number, ev: PillEvent): number {
  if (ev.type === 'append')
    return ev.n > 0 ? prev + ev.n : prev;
  if (ev.type === 'bottom')
    return ev.atBottom ? 0 : prev;
  return 0;
}
