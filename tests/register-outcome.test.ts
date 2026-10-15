import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decideRegister } from '../packages/server/src/register-outcome.js';

/**
 * The registration decision table (`design.md`): the slot is decided by **process identity**, not
 * by "which socket arrived last". The whole point is row 4 — an old-code process reconnecting with
 * the same agentId must not displace a connected current-code agent, because that is the incident
 * (工蜂 Issue #2): the loser's reports are dropped silently and the console shows the wrong code.
 */
describe('decideRegister', () => {
  it('registers a first connection and a re-registration from the same socket', () => {
    assert.equal(
      decideRegister({
        hasRecordedConnection: false,
        sameSocket: false,
        recordedSocketConnected: false,
      }),
      'register',
    );
    assert.equal(
      decideRegister({
        hasRecordedConnection: true,
        sameSocket: true,
        recordedSocketConnected: true,
        incomingInstanceId: 'a',
        recordedInstanceId: 'a',
      }),
      'register',
    );
  });

  it('treats an equal instanceId on a new socket as a reconnect, not a takeover', () => {
    assert.equal(
      decideRegister({
        hasRecordedConnection: true,
        sameSocket: false,
        recordedSocketConnected: true,
        incomingInstanceId: 'a',
        recordedInstanceId: 'a',
      }),
      'reconnect',
    );
    // The server may not have noticed a drop yet (ping timeout is minutes): still a reconnect.
    assert.equal(
      decideRegister({
        hasRecordedConnection: true,
        sameSocket: false,
        recordedSocketConnected: false,
        incomingInstanceId: 'a',
        recordedInstanceId: 'a',
      }),
      'reconnect',
    );
  });

  it('lets a process that identifies itself displace a recorded process that does not', () => {
    assert.equal(
      decideRegister({
        hasRecordedConnection: true,
        sameSocket: false,
        recordedSocketConnected: true,
        incomingInstanceId: 'a',
      }),
      'takeover',
    );
  });

  it('lets a process with a different instanceId take over (a real upgrade)', () => {
    assert.equal(
      decideRegister({
        hasRecordedConnection: true,
        sameSocket: false,
        recordedSocketConnected: true,
        incomingInstanceId: 'b',
        recordedInstanceId: 'a',
      }),
      'takeover',
    );
  });

  it('ignores an old-code newcomer while the recorded process is still connected', () => {
    assert.equal(
      decideRegister({
        hasRecordedConnection: true,
        sameSocket: false,
        recordedSocketConnected: true,
        recordedInstanceId: 'a',
      }),
      'ignore-duplicate',
    );
  });

  it('lets the old-code newcomer in once the recorded socket is gone', () => {
    assert.equal(
      decideRegister({
        hasRecordedConnection: true,
        sameSocket: false,
        recordedSocketConnected: false,
        recordedInstanceId: 'a',
      }),
      'takeover-after-drop',
    );
  });

  it('keeps last-wins for two pre-change binaries that cannot identify themselves', () => {
    assert.equal(
      decideRegister({
        hasRecordedConnection: true,
        sameSocket: false,
        recordedSocketConnected: true,
      }),
      'takeover',
    );
  });
});
