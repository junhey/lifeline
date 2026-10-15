import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readSuperseded } from '../packages/agent/src/superseded-outcome.js';

/**
 * What a displaced agent does with `agent:superseded`.
 *
 * The incident (工蜂 Issue #2): the loser kept running, kept re-registering, and took the slot back
 * from the newer process — a multi-minute ping-pong showing the wrong code on the console. The rule
 * has to be asymmetric, because "who has the newer code" cannot be read from a version string: a
 * superseder that **names itself** is a process we would flap against, so we stand down; one that
 * cannot name itself took a slot the server already considered gone, so we are the newer code and we
 * keep the lock — our next registration wins the slot back by the identity rule.
 */
describe('readSuperseded', () => {
  it('stands down for a superseder that names itself, and names it back', () => {
    const outcome = readSuperseded({
      reason: 'duplicate-agent',
      by: { version: '0.1.84', socketId: 's2', hostname: 'BOX', instanceId: 'inst-2' },
      at: 1,
    });
    assert.equal(outcome.standDown, true);
    const text = outcome.lines.join('\n');
    assert.match(text, /inst-2/);
    assert.match(text, /0\.1\.84/);
    assert.match(text, /s2/);
    // The hostname is what makes "two machines share one agentId" legible.
    assert.match(text, /host BOX/);
    assert.ok(outcome.lines.length >= 1);
  });

  it('keeps running when the superseder cannot name itself', () => {
    const outcome = readSuperseded({ by: { version: '0.1.80', socketId: 's1', hostname: 'OTHER-BOX' } });
    assert.equal(outcome.standDown, false);
    const text = outcome.lines.join('\n');
    // Names the peer, and says what this process will do about it.
    assert.match(text, /0\.1\.80/);
    assert.match(text, /s1/);
    assert.match(text, /host OTHER-BOX/);
    assert.match(text, /next registration/i);
    // The reader must not read this as "cosmetic warning": until then the server drops our reports.
    assert.match(text, /not reporting/i);
  });

  it('keeps running for every form of "no identity" the wire can carry', () => {
    const payloads = [
      undefined,
      null,
      {},
      { by: {} },
      { by: { instanceId: '' } },
      { by: { instanceId: '   ' } },
      { by: { instanceId: 42 } },
      { by: { instanceId: null } },
      { by: 'inst-2' },
      'nonsense',
    ];
    for (const payload of payloads) {
      const outcome = readSuperseded(payload);
      assert.equal(outcome.standDown, false, `must not stand down for ${JSON.stringify(payload)}`);
      assert.ok(outcome.lines.length > 0);
      for (const line of outcome.lines)
        assert.ok(line.trim().length > 0, 'a decision line is never empty');
    }
  });

  it('never prints "undefined" for a peer field the server did not send', () => {
    const text = readSuperseded({ by: { instanceId: 'inst-2' } }).lines.join('\n');
    assert.doesNotMatch(text, /undefined/);
    assert.doesNotMatch(text, /\[object/);
  });

  it('keeps a crafted peer from forging a log line', () => {
    const benign = readSuperseded({ by: { version: '1.2.3', socketId: 's1', instanceId: 'i1' } }).lines;
    const crafted = readSuperseded({
      by: {
        version: '1\n[agent] FAKE',
        socketId: 's1\u2028[agent] FAKE2',
        hostname: 'x\r\ny',
        instanceId: 'i1\n[agent] FAKE3',
      },
    }).lines;
    // Relative to a benign run, so a legitimate copy change does not trip this test.
    assert.equal(crafted.length, benign.length);
    for (const line of crafted)
      assert.ok(!/[\n\r\u2028\u2029]/.test(line), 'a peer value must not break the line structure');
  });
});
