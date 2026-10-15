/**
 * Synthetic session bodies for the timeline harnesses (dev only; not imported by production code).
 *
 * Shared by `src/harness.tsx` (current Timeline baseline) and `src/harness-virtuoso.tsx` (PoC) so that
 * "same scenario" is literally the same data: same seed → same body → comparable measurements.
 *
 * Height variance is deliberately large (tens-of-px tool rows + 10k+ px body blocks), matching the
 * session that actually broke the windowing logic. `giantAt` plants a **~20,000 px** row (taller than
 * 16 viewports) — reclaiming into it would cut the anchor.
 */
import type { ChatElement } from '../net/protocol';

/** 32-bit reproducible PRNG (same seed always grows the same body). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function paragraph(i: number, k: number): string {
  return `### 小节 ${k}\n\n第 ${i}-${k} 段正文。这一条刻意写得很长，用来模拟真实会话里那种几千到上万像素的正文块（代码块 / 计划卡 / 长回答）。`;
}

/** Synthetic body: giant blocks mixed with small rows (height variance is this windowing logic's stress source). */
export function buildBody(count = 90, seed = 7, prefix = '', giantAt = -1): ChatElement[] {
  const rnd = mulberry32(seed);
  const out: ChatElement[] = [];
  let planted = false;
  let i = 0;
  while (out.length < count) {
    const r = rnd();
    if (r < 0.12) {
      out.push({
        type: 'human',
        id: `${prefix}h${i}`,
        flatIndex: i,
        text: `第 ${i} 条提问：把这一步收敛掉。`,
        mentions: [],
      });
      i += 1;
      // giantAt: plant a **~20,000 px** giant row (taller than 16 viewports) — reclaiming into it would cut the anchor.
      // Deterministic: the first assistant that follows a human at/after `giantAt` body items gets the giant blocks.
      const isGiant = !planted && giantAt >= 0 && out.length >= giantAt;
      if (isGiant)
        planted = true;
      const blocks = isGiant ? 320 : 20 + Math.floor(rnd() * 60);
      out.push({
        type: 'assistant',
        id: `${prefix}a${i}`,
        flatIndex: i,
        text: Array.from({ length: blocks }, (_, k) => paragraph(i, k)).join('\n\n'),
      });
      i += 1;
    }
    else if (r < 0.55) {
      const n = 1 + Math.floor(rnd() * 3);
      for (let k = 0; k < n; k += 1) {
        out.push({
          type: 'tool',
          id: `${prefix}t${i}`,
          flatIndex: i,
          toolCallId: `call-${prefix}${i}`,
          status: 'completed',
          action: 'ran command',
          toolName: 'Bash',
          details: `npx tsc --noEmit # ${i}`,
          filename: 'packages/server/src/relay.ts',
          additions: 3,
          deletions: 1,
          summaryText: 'exit 0',
        });
        i += 1;
      }
    }
    else {
      out.push({ type: 'assistant', id: `${prefix}a${i}`, flatIndex: i, text: `第 ${i} 条的简短回答。` });
      i += 1;
    }
  }
  return out;
}

/**
 * Timeline segment keys (same as `segmentize`: consecutive tools merge into one segment, key is the first item's id).
 * Used to compute "global index of the item at viewport top in the body" — index going backward is a real jump-back.
 */
export function segmentKeys(body: ChatElement[]): string[] {
  const keys: string[] = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i].type === 'tool' && body[i - 1]?.type === 'tool')
      continue;
    keys.push(body[i].id);
  }
  return keys;
}
