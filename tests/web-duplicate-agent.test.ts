import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { machineNotice } from '../packages/web/src/lib/duplicate-agent.js';

/**
 * The console notice for a displaced agent. The scenario it exists for: a dev build wins the slot,
 * the row's version chip shows `0.0.0-dev`, and the notice must name the release that lost it —
 * otherwise the page looks like "the release is running, in a weird state".
 */
describe('machineNotice', () => {
  it('says nothing about a healthy release machine', () => {
    assert.deepEqual(machineNotice({ cliVersion: '0.1.83' }), { devBuild: false });
  });

  it('names the displaced release when the slot was taken over', () => {
    const notice = machineNotice({
      cliVersion: '0.1.83',
      duplicateAgent: { at: 1, version: '0.1.82', socketId: 's1' },
    });
    assert.equal(notice.displaced, '已顶替 v0.1.82');
    assert.equal(notice.devBuild, false);
  });

  it('marks a dev build that displaced a release: the row must not look healthy', () => {
    const notice = machineNotice({
      cliVersion: '0.0.0-dev',
      duplicateAgent: { at: 1, version: '0.1.82', socketId: 's1' },
    });
    assert.equal(notice.displaced, '已顶替 v0.1.82');
    assert.equal(notice.devBuild, true);
  });

  it('marks a dev build without a record, and stays quiet for an unreported version', () => {
    assert.deepEqual(machineNotice({ cliVersion: '0.0.0-dev' }), { devBuild: true });
    // An old agent reports no version at all: "unknown" is not a dev build.
    assert.deepEqual(machineNotice({}), { devBuild: false });
  });

  it('names a displaced process that never reported a version', () => {
    const notice = machineNotice({ cliVersion: '0.1.83', duplicateAgent: { at: 1, socketId: 's1' } });
    assert.equal(notice.displaced, '已顶替旧 agent');
  });

  it('is rendered by both row kinds, normal machines and content sources', () => {
    // The shared copy is the point of the requirement, so this asserts the wiring rather than the
    // wording twice: `MachineList` must call the function for both maps and render both markers.
    const list = readFileSync(
      fileURLToPath(new URL('../packages/web/src/components/MachineList.tsx', import.meta.url)),
      'utf-8',
    );
    // Slice per row kind: counting occurrences over the whole file would stay green if one row kind
    // lost the notice and the other grew a second copy of it.
    const contentSourcesAt = list.indexOf('contentSources.map');
    assert.notEqual(contentSourcesAt, -1, 'missing the content-source map');
    const rowsByKind = [['normal', list.slice(0, contentSourcesAt)], ['content-source', list.slice(contentSourcesAt)]] as const;
    for (const [kind, rows] of rowsByKind) {
      assert.match(rows, /machineNotice\(m\)/, `${kind} rows must compute the notice`);
      assert.match(rows, /\{notice\.displaced &&/, `${kind} rows must render the notice`);
      assert.match(rows, /\{notice\.devBuild &&/, `${kind} rows must render the dev marker`);
    }
  });
});
