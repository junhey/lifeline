import type { TranscriptEntry, TurnBubble } from '../packages/agent/src/sources/cursor-transcript.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { CursorAdapter } from '../packages/agent/src/sources/cursor-adapter.js';
import { fillFromTranscript, parseTranscript } from '../packages/agent/src/sources/cursor-transcript.js';

const human = (id: string, text = 'q'): TurnBubble => ({ id, role: 'human', body: { text, thinking: '', tool: false } });
const reply = (id: string, text: string): TurnBubble => ({ id, role: 'assistant', body: { text, thinking: '', tool: false } });
const stub = (id: string, preview?: string): TurnBubble => ({ id, role: 'assistant', preview, body: { text: '', thinking: '', tool: false } });
const tool = (id: string): TurnBubble => ({ id, role: 'assistant', body: { text: '', thinking: '', tool: true } });
const user = (text: string): TranscriptEntry => ({ role: 'user', text });
const asst = (text: string): TranscriptEntry => ({ role: 'assistant', text });

describe('parseTranscript', () => {
  it('keeps text blocks, unwraps the user query, skips tool blocks / turn markers / a torn last line', () => {
    const raw = [
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<timestamp>Wed</timestamp>\n<user_query>\n你好\n</user_query>' }] } }),
      JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: '好的' }, { type: 'tool_use', name: 'x' }] } }),
      JSON.stringify({ type: 'turn_ended', status: 'success' }),
      '{"role":"assistant","message":{"content":[{"type":"te',
    ].join('\n');
    assert.deepEqual(parseTranscript(raw), [user('你好'), asst('好的')]);
  });
});

describe('fillFromTranscript', () => {
  it('fills the last bubble of a turn from the last entry when the disk has no trace of it (no preview)', () => {
    const bubbles = [human('h1'), reply('a1', '第一轮回复'), human('h2'), stub('s1'), tool('t1'), stub('s2')];
    const entries = [user('q'), asst('第一轮回复'), user('q'), asst('思考中的英文'), asst('第二轮的完整回复')];
    const fill = fillFromTranscript(bubbles, entries);
    assert.deepEqual([...fill], [['s2', '第二轮的完整回复']]);
  });

  it('anchors on the header preview and leaves unanchored stubs empty (thinking is not a reply)', () => {
    const bubbles = [human('h1'), stub('s1'), tool('t1'), stub('s2', '桌面端真机跑通了')];
    const entries = [user('q'), asst('I still have unfinished items'), asst('## 桌面端真机跑通了,但文生图还有问题')];
    const fill = fillFromTranscript(bubbles, entries);
    assert.deepEqual([...fill], [['s2', '## 桌面端真机跑通了,但文生图还有问题']]);
  });

  it('never touches a bubble that already has content, and never reuses a reply the disk already shows', () => {
    const bubbles = [human('h1'), reply('a1', '已经落盘的回复'), stub('s1')];
    const entries = [user('q'), asst('已经落盘的回复')];
    assert.equal(fillFromTranscript(bubbles, entries).size, 0);
  });

  it('does not fill when the last entry is already on disk as thinking', () => {
    const bubbles: TurnBubble[] = [
      human('h1'),
      { id: 'th', role: 'assistant', body: { text: '', thinking: '我在想这个问题该怎么办', tool: false } },
      stub('s1'),
    ];
    const entries = [user('q'), asst('我在想这个问题该怎么办')];
    assert.equal(fillFromTranscript(bubbles, entries).size, 0);
  });

  it('fills an empty human bubble from the user message of the same turn', () => {
    const bubbles = [human('h1', ''), reply('a1', '回复')];
    const entries = [user('用户真正说的话'), asst('回复')];
    assert.deepEqual([...fillFromTranscript(bubbles, entries)], [['h1', '用户真正说的话']]);
  });

  it('gives up entirely when the number of user messages does not match the human bubbles', () => {
    const bubbles = [human('h1'), stub('s1'), human('h2'), stub('s2')];
    const entries = [user('q'), asst('x'), user('q'), asst('y'), user('q'), asst('z')];
    assert.equal(fillFromTranscript(bubbles, entries).size, 0);
  });

  it('ignores bubbles whose body was not read (outside the tail window)', () => {
    const bubbles: TurnBubble[] = [{ id: 'h1', role: 'human' }, { id: 's1', role: 'assistant' }];
    assert.equal(fillFromTranscript(bubbles, [user('q'), asst('x')]).size, 0);
  });
});

describe('CursorAdapter + transcript', () => {
  let dir: string;
  let dbPath: string;
  let root: string;
  let file: string;

  const transcript = (...rows: Array<{ role: 'user' | 'assistant'; text: string }>): void => {
    writeFileSync(
      file,
      `${rows.map(r => JSON.stringify({ role: r.role, message: { content: [{ type: 'text', text: r.text }] } })).join('\n')}\n`,
    );
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cursor-tr-'));
    dbPath = join(dir, 'state.vscdb');
    root = join(dir, 'projects');
    mkdirSync(join(root, 'proj-a', 'agent-transcripts', 'cid1'), { recursive: true });
    file = join(root, 'proj-a', 'agent-transcripts', 'cid1', 'cid1.jsonl');

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, value TEXT);
      CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);
    `);
    db.prepare('INSERT INTO composerHeaders VALUES (?,?,?,?,?,?,?)').run('cid1', 'ws', 1, 2, 0, 0, '{}');
    const headers = [
      { bubbleId: 'h1', type: 1, createdAt: '2026-01-01T00:00:00.000Z', grouping: { isRenderable: true } },
      { bubbleId: 'a1', type: 2, createdAt: '2026-01-01T00:00:01.000Z', grouping: { isRenderable: true } },
      { bubbleId: 'h2', type: 1, createdAt: '2026-01-01T00:00:02.000Z', grouping: { isRenderable: true } },
      { bubbleId: 'a2', type: 2, createdAt: '2026-01-01T00:00:03.000Z', grouping: { isRenderable: true, textPreview: '第二轮' } },
    ];
    db.prepare('INSERT INTO cursorDiskKV VALUES (?,?)').run('composerData:cid1', JSON.stringify({ _v: 18, status: 'aborted', fullConversationHeadersOnly: headers }));
    const put = (id: string, b: object): unknown => db.prepare('INSERT INTO cursorDiskKV VALUES (?,?)').run(`bubbleId:cid1:${id}`, JSON.stringify({ bubbleId: id, ...b }));
    put('h1', { type: 1, text: '问一', createdAt: 1 });
    put('a1', { type: 2, text: '答一', createdAt: 2 });
    put('h2', { type: 1, text: '问二', createdAt: 3 });
    put('a2', { type: 2, text: '', createdAt: 4 }); // the stub: body never flushed
    db.close();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('projects the reply the database has not flushed yet, and stays exactly as before when there is no transcript', () => {
    const plain = new CursorAdapter(dbPath, { transcriptsRoot: join(dir, 'nowhere') });
    assert.equal(plain.projectSession('cid1').filter(m => m.type === 'assistant').length, 1);
    assert.equal(plain.changeSignal(), plain.dataVersion());
    plain.close();

    transcript(
      { role: 'user', text: '问一' },
      { role: 'assistant', text: '答一' },
      { role: 'user', text: '问二' },
      { role: 'assistant', text: '第二轮的完整回复' },
    );
    const a = new CursorAdapter(dbPath, { transcriptsRoot: root });
    const texts = a.projectSession('cid1').flatMap(m => (m.type === 'assistant' || m.type === 'human' ? [m.text] : []));
    assert.deepEqual(texts, ['问一', '答一', '问二', '第二轮的完整回复']);
    a.close();
  });

  it('still aligns when Cursor hides a human bubble (isRenderable:false) that the transcript counts', () => {
    const db = new Database(dbPath);
    const row = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get('composerData:cid1') as { value: string };
    const cd = JSON.parse(row.value) as { fullConversationHeadersOnly: object[] };
    cd.fullConversationHeadersOnly.unshift({ bubbleId: 'hx', type: 1, grouping: { isRenderable: false } });
    db.prepare('UPDATE cursorDiskKV SET value = ? WHERE key = ?').run(JSON.stringify(cd), 'composerData:cid1');
    db.prepare('INSERT INTO cursorDiskKV VALUES (?,?)').run('bubbleId:cid1:hx', JSON.stringify({ bubbleId: 'hx', type: 1, text: '', createdAt: 0 }));
    db.close();
    transcript(
      { role: 'user', text: '被隐藏的那一轮' },
      { role: 'user', text: '问一' },
      { role: 'assistant', text: '答一' },
      { role: 'user', text: '问二' },
      { role: 'assistant', text: '第二轮的完整回复' },
    );
    const a = new CursorAdapter(dbPath, { transcriptsRoot: root });
    const last = a.projectSession('cid1').at(-1) as { text: string };
    assert.equal(last.text, '第二轮的完整回复');
    a.close();
  });

  it('a transcript-only change moves changeSignal and the stub bubble size, so the web refreshes without a database write', () => {
    transcript(
      { role: 'user', text: '问一' },
      { role: 'assistant', text: '答一' },
      { role: 'user', text: '问二' },
      { role: 'assistant', text: '第二轮' },
    );
    const a = new CursorAdapter(dbPath, { transcriptsRoot: root });
    a.readIndex('cid1'); // any read that locates the transcript
    a.projectSession('cid1');
    const signal = a.changeSignal();
    const size = a.bubbleSizes('cid1').get('a2');

    transcript(
      { role: 'user', text: '问一' },
      { role: 'assistant', text: '答一' },
      { role: 'user', text: '问二' },
      { role: 'assistant', text: '第二轮，现在写完了，比刚才长得多' },
    );
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);

    assert.notEqual(a.changeSignal(), signal);
    assert.notEqual(a.bubbleSizes('cid1').get('a2'), size);
    const last = a.projectSession('cid1').at(-1) as { text: string };
    assert.equal(last.text, '第二轮，现在写完了，比刚才长得多');
    a.close();
  });
});
