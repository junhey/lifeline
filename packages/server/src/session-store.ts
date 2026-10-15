/**
 * Server-side mirror of projected transcripts. One SQLite file for the whole site.
 * Not Cursor's state.vscdb — never open the user's live Cursor DB.
 */

import type Database from 'better-sqlite3';
import type { IdeKind, SessionMeta } from '../../protocol/src/index.js';
import type { LifelineDb } from './db/open.js';
import type { SessionPage } from './pages/session-page.js';
import type { ChatElement } from './types.js';
import { and, desc, eq, lte, sql } from 'drizzle-orm';
import {

  isIdeKind,
  parseIde,
  SESSION_PAGE_ITEMS,

} from '../../protocol/src/index.js';
import { openDrizzle } from './db/open.js';
import { messages, sessions, sessionSeq } from './db/schema.js';

const STRIP_KEYS = new Set(['actions', 'selectorPath']);

function stripSensitive(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(stripSensitive);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (STRIP_KEYS.has(key))
        continue;
      out[key] = stripSensitive(child);
    }
    return out;
  }
  return value;
}

function payloadJson(message: ChatElement): string {
  return JSON.stringify(stripSensitive(message));
}

/**
 * The mirror orders a session by `flat_index`, and that number is chosen by the agent. An agent that lost its
 * send baseline (restart, restored watermark, …) numbers new messages from 0 and lands them on top of rows the
 * server already holds; the read then interleaves them by `flat_index` and the newest turns end up buried mid-session
 * (2026-09-30: 48 old rows + 27 new ones all in 0..47, tail stuck on old messages). The server must not let a
 * wrong number from the wire corrupt the order, so before writing an incoming batch it settles collisions:
 *  - a slot held by a row this batch does not touch is settled — the incoming message may not take it;
 *  - a message already stored goes back to the slot it already had (a streamed update re-sent with a stale number);
 *  - a new message goes after the current tail, in batch order.
 * Anything that does not collide is written as given, so a `patch-all` (a full, correctly numbered projection that
 * legitimately shifts rows) passes through untouched.
 */
export function resolveFlatIndices(
  existing: ReadonlyMap<string, number>,
  incoming: ChatElement[],
): { messages: ChatElement[]; moved: number } {
  const incomingIds = new Set(incoming.map(m => m.id));
  const taken = new Map<number, string>();
  let tail = -1;
  for (const [id, flat] of existing) {
    if (flat > tail)
      tail = flat;
    if (!incomingIds.has(id))
      taken.set(flat, id);
  }

  const accepted: Array<number | undefined> = [];
  for (const m of incoming) {
    const holder = taken.get(m.flatIndex);
    if (holder === undefined || holder === m.id) {
      taken.set(m.flatIndex, m.id);
      accepted.push(m.flatIndex);
      if (m.flatIndex > tail)
        tail = m.flatIndex;
      continue;
    }
    const prev = existing.get(m.id);
    if (prev !== undefined && !taken.has(prev)) {
      taken.set(prev, m.id);
      accepted.push(prev);
    }
    else {
      accepted.push(undefined);
    }
  }

  let moved = 0;
  const messages = incoming.map((m, i) => {
    let flatIndex = accepted[i];
    if (flatIndex === undefined) {
      tail += 1;
      flatIndex = tail;
    }
    if (flatIndex === m.flatIndex)
      return m;
    moved += 1;
    return { ...m, flatIndex } as ChatElement;
  });
  return { messages, moved };
}

function sessionIde(session: SessionMeta): IdeKind {
  return parseIde(session.ref?.ide);
}

function reportedIdeSet(sessionList: SessionMeta[], reportedIdes?: Iterable<string>): Set<IdeKind> {
  if (reportedIdes) {
    const out = new Set<IdeKind>();
    for (const ide of reportedIdes) {
      if (isIdeKind(ide))
        out.add(ide);
    }
    if (out.size > 0)
      return out;
  }
  return new Set(sessionList.map(s => sessionIde(s)));
}

/** Cursor composerHeaders.lastUpdatedAt is often NULL. The server column is NOT NULL. */
export function sessionIndexTimestamp(session: {
  lastUpdatedAt?: number | null;
  createdAt?: number | null;
}): number {
  for (const raw of [session.lastUpdatedAt, session.createdAt]) {
    const n = Number(raw);
    if (Number.isFinite(n))
      return n;
  }
  return 0;
}

export class SessionStore {
  private readonly sqlite: Database.Database;
  private readonly orm: LifelineDb;

  constructor(dbPath: string) {
    const opened = openDrizzle(dbPath);
    this.sqlite = opened.sqlite;
    this.orm = opened.orm;
  }

  close(): void {
    this.sqlite.close();
  }

  writeIndex(agentId: string, sessionList: SessionMeta[], reportedIdes?: Iterable<string>): void {
    const reported = reportedIdeSet(sessionList, reportedIdes);
    const keep = new Set(sessionList.map(s => `${sessionIde(s)}\0${s.ref.sessionId}`));
    const existing = this.orm
      .select({ ide: sessions.ide, sessionId: sessions.sessionId })
      .from(sessions)
      .where(eq(sessions.agentId, agentId))
      .all();

    const apply = this.sqlite.transaction(() => {
      for (const row of existing) {
        if (!reported.has(row.ide as IdeKind))
          continue;
        const key = `${row.ide}\0${row.sessionId}`;
        if (keep.has(key))
          continue;
        this.orm
          .delete(messages)
          .where(
            and(
              eq(messages.agentId, agentId),
              eq(messages.ide, row.ide),
              eq(messages.sessionId, row.sessionId),
            ),
          )
          .run();
        this.orm
          .delete(sessions)
          .where(
            and(
              eq(sessions.agentId, agentId),
              eq(sessions.ide, row.ide),
              eq(sessions.sessionId, row.sessionId),
            ),
          )
          .run();
      }
      for (const session of sessionList) {
        const ide = sessionIde(session);
        this.orm
          .insert(sessions)
          .values({
            agentId,
            ide,
            sessionId: session.ref.sessionId,
            metaJson: JSON.stringify(session),
            lastUpdatedAt: sessionIndexTimestamp(session),
          })
          .onConflictDoUpdate({
            target: [sessions.agentId, sessions.ide, sessions.sessionId],
            set: {
              metaJson: sql`excluded.meta_json`,
              lastUpdatedAt: sql`excluded.last_updated_at`,
            },
          })
          .run();
      }
    });
    apply();
  }

  mergeIndex(
    agentId: string,
    sessionList: SessionMeta[],
    removed: Array<{ ide: IdeKind; sessionId: string }> = [],
  ): void {
    const apply = this.sqlite.transaction(() => {
      for (const row of removed) {
        this.orm
          .delete(messages)
          .where(
            and(
              eq(messages.agentId, agentId),
              eq(messages.ide, row.ide),
              eq(messages.sessionId, row.sessionId),
            ),
          )
          .run();
        this.orm
          .delete(sessions)
          .where(
            and(
              eq(sessions.agentId, agentId),
              eq(sessions.ide, row.ide),
              eq(sessions.sessionId, row.sessionId),
            ),
          )
          .run();
      }
      for (const session of sessionList) {
        this.orm
          .insert(sessions)
          .values({
            agentId,
            ide: sessionIde(session),
            sessionId: session.ref.sessionId,
            metaJson: JSON.stringify(session),
            lastUpdatedAt: sessionIndexTimestamp(session),
          })
          .onConflictDoUpdate({
            target: [sessions.agentId, sessions.ide, sessions.sessionId],
            set: {
              metaJson: sql`excluded.meta_json`,
              lastUpdatedAt: sql`excluded.last_updated_at`,
            },
          })
          .run();
      }
    });
    apply();
  }

  readIndex(agentId: string): SessionMeta[] {
    return this.orm
      .select({ metaJson: sessions.metaJson })
      .from(sessions)
      .where(eq(sessions.agentId, agentId))
      .orderBy(sql`${sessions.lastUpdatedAt} DESC`)
      .all()
      .map(row => JSON.parse(row.metaJson) as SessionMeta);
  }

  findSessionOwners(sessionId: string, ide: IdeKind): string[] {
    return this.orm
      .select({ agentId: sessions.agentId })
      .from(sessions)
      .where(and(eq(sessions.ide, ide), eq(sessions.sessionId, sessionId)))
      .orderBy(sql`${sessions.lastUpdatedAt} DESC`)
      .all()
      .map(row => row.agentId);
  }

  moveAgent(oldAgentId: string, newAgentId: string): void {
    const apply = this.sqlite.transaction(() => {
      this.orm.update(sessions).set({ agentId: newAgentId }).where(eq(sessions.agentId, oldAgentId)).run();
      this.orm.update(messages).set({ agentId: newAgentId }).where(eq(messages.agentId, oldAgentId)).run();
      this.orm.update(sessionSeq).set({ agentId: newAgentId }).where(eq(sessionSeq.agentId, oldAgentId)).run();
    });
    apply();
  }

  dropAgent(agentId: string): void {
    const apply = this.sqlite.transaction(() => {
      this.orm.delete(sessions).where(eq(sessions.agentId, agentId)).run();
      this.orm.delete(messages).where(eq(messages.agentId, agentId)).run();
      this.orm.delete(sessionSeq).where(eq(sessionSeq.agentId, agentId)).run();
    });
    apply();
  }

  writeSession(
    agentId: string,
    sessionId: string,
    body: ChatElement[],
    ide: IdeKind,
    seq?: number,
  ): void {
    const apply = this.sqlite.transaction(() => {
      this.orm
        .delete(messages)
        .where(
          and(eq(messages.agentId, agentId), eq(messages.ide, ide), eq(messages.sessionId, sessionId)),
        )
        .run();
      for (const message of body) {
        this.orm
          .insert(messages)
          .values({
            agentId,
            ide,
            sessionId,
            messageId: message.id,
            flatIndex: message.flatIndex,
            payload: payloadJson(message),
          })
          .run();
      }
      if (seq !== undefined)
        this.upsertSeq(agentId, ide, sessionId, seq);
    });
    apply();
  }

  readSessionSeq(agentId: string, sessionId: string, ide: IdeKind): number | null {
    const row = this.orm
      .select({ lastSeq: sessionSeq.lastSeq })
      .from(sessionSeq)
      .where(
        and(
          eq(sessionSeq.agentId, agentId),
          eq(sessionSeq.ide, ide),
          eq(sessionSeq.sessionId, sessionId),
        ),
      )
      .get();
    return row ? row.lastSeq : null;
  }

  private upsertSeq(agentId: string, ide: IdeKind, sessionId: string, seq: number): void {
    this.orm
      .insert(sessionSeq)
      .values({ agentId, ide, sessionId, lastSeq: seq })
      .onConflictDoUpdate({
        target: [sessionSeq.agentId, sessionSeq.ide, sessionSeq.sessionId],
        set: { lastSeq: sql`excluded.last_seq` },
      })
      .run();
  }

  readSession(agentId: string, sessionId: string, ide: IdeKind): ChatElement[] | null {
    const rows = this.orm
      .select({ payload: messages.payload })
      .from(messages)
      .where(
        and(eq(messages.agentId, agentId), eq(messages.ide, ide), eq(messages.sessionId, sessionId)),
      )
      .orderBy(messages.flatIndex)
      .all();
    if (rows.length === 0)
      return null;
    return rows.map(row => JSON.parse(row.payload) as ChatElement);
  }

  /**
   * Tail-first page: with no before, take the last limit items; with before, take the last limit items
   * whose flat_index <= before (closed interval: the page tail is an overlap token so the page can
   * join onto its local first item by id. A left-open < would leave every page unjoinable).
   * Read one extra row to decide hasMore (avoids a second query); nextBefore is only set when hasMore.
   * Uses the messages_order (agent_id, ide, session_id, flat_index) index; cost is independent of session length.
   */
  readSessionPage(
    agentId: string,
    sessionId: string,
    ide: IdeKind,
    opts?: { before?: number; limit?: number },
  ): SessionPage | null {
    const raw = opts?.limit;
    // Treat 0 / NaN / negatives as "use the cap"? No — the floor is 1 (`limit: 0` must clamp to 1, not silently become a full page)
    const limit
      = typeof raw === 'number' && Number.isFinite(raw)
        ? Math.max(1, Math.min(Math.floor(raw), SESSION_PAGE_ITEMS))
        : SESSION_PAGE_ITEMS;
    const before = opts?.before;
    const scope = and(
      eq(messages.agentId, agentId),
      eq(messages.ide, ide),
      eq(messages.sessionId, sessionId),
    );
    const rows = this.orm
      .select({ payload: messages.payload, flatIndex: messages.flatIndex })
      .from(messages)
      .where(before === undefined ? scope : and(scope, lte(messages.flatIndex, before)))
      .orderBy(desc(messages.flatIndex))
      .limit(limit + 1)
      .all();
    if (rows.length === 0)
      return null;
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).reverse();
    return {
      messages: page.map(row => JSON.parse(row.payload) as ChatElement),
      hasMore,
      nextBefore: hasMore ? page[0].flatIndex : undefined,
    };
  }

  appendSession(
    agentId: string,
    sessionId: string,
    incoming: ChatElement[],
    ide: IdeKind,
    seq?: number,
  ): ChatElement[] {
    this.appendMessages(agentId, sessionId, incoming, ide, seq);
    return this.readSession(agentId, sessionId, ide) ?? [];
  }

  /**
   * Merge a batch into the mirror by id and return what was actually stored: identical to `incoming` unless the
   * agent's `flatIndex` collided with rows already held (see `resolveFlatIndices`). Forward the returned copy to
   * watchers so the web sees the same order the DB serves.
   */
  appendMessages(
    agentId: string,
    sessionId: string,
    incoming: ChatElement[],
    ide: IdeKind,
    seq?: number,
  ): ChatElement[] {
    let stored = incoming;
    const apply = this.sqlite.transaction(() => {
      const held = this.orm
        .select({ messageId: messages.messageId, flatIndex: messages.flatIndex })
        .from(messages)
        .where(
          and(eq(messages.agentId, agentId), eq(messages.ide, ide), eq(messages.sessionId, sessionId)),
        )
        .all();
      const resolved = resolveFlatIndices(new Map(held.map(r => [r.messageId, r.flatIndex])), incoming);
      stored = resolved.messages;
      if (resolved.moved > 0)
        console.warn(`[session-store] ${sessionId.slice(0, 8)}: renumbered ${resolved.moved}/${incoming.length} colliding flatIndex`);
      for (const message of stored) {
        this.orm
          .insert(messages)
          .values({
            agentId,
            ide,
            sessionId,
            messageId: message.id,
            flatIndex: message.flatIndex,
            payload: payloadJson(message),
          })
          .onConflictDoUpdate({
            target: [messages.agentId, messages.ide, messages.sessionId, messages.messageId],
            set: {
              flatIndex: sql`excluded.flat_index`,
              payload: sql`excluded.payload`,
            },
          })
          .run();
      }
      if (seq !== undefined)
        this.upsertSeq(agentId, ide, sessionId, seq);
    });
    apply();
    return stored;
  }
}
