import type { ChatElement, RunCommand, ThoughtBlock, TodoListBlock, ToolCallElement } from '../net/protocol';
import type { PendingSendInfo } from '../store/sessions';
import { memo } from 'react';
import { sendCommand } from '../net/socket';
import { useIdesStore } from '../store/ides';
import { AssistantBlock, HumanBubble } from './MessageBubble';
import { PlanCard } from './PlanCard';
import { ToolGroup } from './ToolGroup';

export type Segment
  = | { kind: 'single'; el: ChatElement; key: string }
    | { kind: 'tools'; items: ToolCallElement[]; key: string };

/**
 * Consecutive tools are grouped (spec §4: collapsed to a one-line summary by default). Draw thought / plan when present in the payload.
 *
 * `prev` reuses segments whose content has not changed: after keeping the full body, a single append can be thousands of items,
 * and rebuilding every Segment would invalidate the whole column's memo (markdown is not recomputed, but React still walks the entire column).
 */
export function segmentize(body: ChatElement[], prev?: Segment[]): Segment[] {
  const byKey = new Map<string, Segment>();
  if (prev) {
    for (const s of prev) byKey.set(s.key, s);
  }
  const out: Segment[] = [];
  for (const el of body) {
    if (el.type === 'tool') {
      const last = out[out.length - 1];
      if (last?.kind === 'tools')
        last.items.push(el);
      else out.push({ kind: 'tools', items: [el], key: el.id });
      continue;
    }
    const cached = byKey.get(el.id);
    if (cached?.kind === 'single' && cached.el === el)
      out.push(cached);
    else out.push({ kind: 'single', el, key: el.id });
  }
  return out;
}

/**
 * Container class for each item. spec §4 rhythm (24px before human, 0 inside a work streak, 12px between other segments).
 * Rhythm must live on the item as padding — margin would be eaten by collapsing margins, so measured height would not match real occupancy.
 * 12px breathing room at both ends.
 */
export function itemClassOf(segments: Segment[], i: number): string {
  const seg = segments[i];
  const prev = segments[i - 1];
  const cls = ['content-col', 'px-4', 'tl-item'];
  if (seg.kind === 'single' && seg.el.type === 'human')
    cls.push('tl-item-human');
  else if (prev?.kind === 'tools' && seg.kind === 'tools')
    cls.push('tl-item-tight');
  if (i === segments.length - 1)
    cls.push('tl-item-last');
  return cls.join(' ');
}

export function thoughtLine(el: ThoughtBlock): string {
  const bits = [el.action, el.detail].filter(Boolean);
  if (bits.length === 0)
    return el.duration ? `思考 ${el.duration}` : '思考中';
  return el.duration ? `${bits.join(' · ')} · ${el.duration}` : bits.join(' · ');
}

export function TodoListCard({ msg }: { msg: TodoListBlock }) {
  const dot = { pending: 'var(--text-weak)', in_progress: 'var(--accent)', completed: 'var(--ok)' } as const;
  return (
    <div className="surface-card px-3 py-2 text-[length:var(--text-chrome)]">
      <div className="mb-1 text-[var(--text-primary)]">
        {msg.title}
        {' '}
        (
        {msg.todosCompleted}
        /
        {msg.todosTotal}
        )
      </div>
      {msg.todos.map((t, i) => (
        <div
          key={i}
          className={`flex items-center gap-2 py-0.5 ${t.status === 'completed' ? 'text-[var(--text-weak)]' : 'text-[var(--text-secondary)]'}`}
        >
          <span className="dot-sm" style={{ background: dot[t.status] }} />
          <span className="overflow-hidden text-ellipsis whitespace-nowrap">{t.text}</span>
        </div>
      ))}
    </div>
  );
}

export function RunCommandCard({ msg }: { msg: RunCommand }) {
  const selectedIde = useIdesStore(s => s.selectedIde);
  return (
    <div className="surface-card p-3">
      {msg.description && <div className="mb-2">{msg.description}</div>}
      <pre className="md-pre mono">
        $
        {msg.command}
      </pre>
      {msg.actions?.length > 0 && (
        <div className="mt-2.5 flex gap-2">
          {msg.actions.map(a => (
            <button
              key={a.selectorPath}
              type="button"
              onClick={() => sendCommand('command:click_action', { ide: selectedIde, selectorPath: a.selectorPath, actionLabel: a.label })}
              className={a.type === 'run' ? 'btn btn-primary' : 'btn btn-ghost'}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function pendingMetaOf(el: ChatElement, pendingSends: Record<string, PendingSendInfo>): PendingSendInfo | undefined {
  if (el.type !== 'human' || !el.id.startsWith('pending-send:'))
    return undefined;
  return pendingSends[el.id.slice('pending-send:'.length)];
}

/**
 * One message. memo: the body array is new on every append; without this the whole 120-item column re-renders,
 * and real costs like markdown / code-block listeners would re-run as well.
 */
export const SegmentView = memo(
  ({ seg, pendingSends }: { seg: Segment; pendingSends: Record<string, PendingSendInfo> }) => {
    if (seg.kind === 'tools') {
      return (
        <div className="tl-seg tl-seg-tools">
          <ToolGroup items={seg.items} />
        </div>
      );
    }
    const el = seg.el;
    switch (el.type) {
      case 'human':
        return <div className="tl-seg tl-seg-human"><HumanBubble msg={el} meta={pendingMetaOf(el, pendingSends)} /></div>;
      case 'assistant':
        return <div className="tl-seg"><AssistantBlock msg={el} /></div>;
      case 'todo_list':
        return <div className="tl-seg"><TodoListCard msg={el} /></div>;
      case 'plan':
        return <div className="tl-seg"><PlanCard msg={el} /></div>;
      case 'thought':
        return <div className="tl-seg"><div className="thought-row">{thoughtLine(el)}</div></div>;
      case 'run_command':
        return <div className="tl-seg"><RunCommandCard msg={el} /></div>;
      case 'loading':
        return (
          <div className="tl-seg">
            <span className="tl-loading">
              <span />
              <span />
              <span />
            </span>
          </div>
        );
      default:
        return null;
    }
  },
  (prev, next) => prev.seg === next.seg && prev.pendingSends === next.pendingSends,
);
