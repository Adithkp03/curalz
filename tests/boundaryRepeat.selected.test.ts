import { describe, it, expect } from 'vitest';
import { due, claim, stop, closeFromEvidence, Episode, Evidence, Policy } from '../proposals/boundary-repeat-policy';

/**
 * The owner settled the open policy choices on 2026-11-19 IST:
 *  - Stop silences only the caregiver who pressed it, for that crossing only (12:21).
 *  - A fresh confirmed return inside the safe zone stops repeats automatically (12:19).
 *  - While GPS is stale the reminders continue, explicitly last-seen-outside with the
 *    last-seen location, never a claim that the patient is currently outside (12:21).
 * These tests pin THAT policy. The full combination suite stays in boundaryRepeat.proposal.test.ts.
 */
export const SELECTED: Policy = { stopScope: 'caregiver', stale: 'unresolved_reminder', stopOnReturn: true };
const T = 1_800_000_000_000;
const ep = (): Episode => ({ id: 'synthetic-episode', openedAt: T, stoppedBy: [], lastAttemptAt: {} });
const ev: Evidence = { currentAccess: true, sameOriginalLinkAndGrant: true, sameZone: true, fresh: true, clearlyInside: false, outside: true };

describe('selected boundary-repeat policy (owner-settled 2026-11-19)', () => {
  it('first repeat is due exactly ten minutes after the first alert, no burst after a late sweep', () => {
    let e = ep();
    expect(due(e, 'a', ev, SELECTED, T + 599_999)).toBe('wait');
    expect(due(e, 'a', ev, SELECTED, T + 600_000)).toBe('outside_reminder');
    e = claim(e, 'a', T + 3_600_000); // sweep an hour late: claim now, next slot from now
    expect(due(e, 'a', ev, SELECTED, T + 3_600_001)).toBe('wait');
    expect(due(e, 'a', ev, SELECTED, T + 4_200_000)).toBe('outside_reminder');
  });
  it('Stop silences only that caregiver for this crossing; the next crossing is unaffected', () => {
    const stopped = stop(ep(), 'a', SELECTED);
    expect(due(stopped, 'a', ev, SELECTED, T + 600_000)).toBe('suppressed');
    expect(due(stopped, 'b', ev, SELECTED, T + 600_000)).toBe('outside_reminder');
    expect(due(ep(), 'a', ev, SELECTED, T + 600_000)).toBe('outside_reminder'); // new episode: nobody stopped
  });
  it('stale or uncertain location still reminds, as an unresolved last-seen reminder', () => {
    expect(due(ep(), 'a', { ...ev, fresh: false }, SELECTED, T + 600_000)).toBe('unresolved_reminder');
    expect(due(ep(), 'a', { ...ev, outside: false }, SELECTED, T + 600_000)).toBe('unresolved_reminder');
    expect(due(ep(), 'a', { ...ev, fresh: false, outside: false }, SELECTED, T + 600_000)).toBe('unresolved_reminder');
  });
  it('a fresh clearly-inside fix closes the crossing automatically; stale or edge fixes do not', () => {
    expect(closeFromEvidence(ep(), { ...ev, clearlyInside: true, outside: false }, SELECTED).closed).toBe('returned');
    expect(closeFromEvidence(ep(), { ...ev, fresh: false, clearlyInside: true }, SELECTED).closed).toBeUndefined();
    expect(closeFromEvidence(ep(), { ...ev, clearlyInside: false, outside: false }, SELECTED).closed).toBeUndefined();
    const closed = closeFromEvidence(ep(), { ...ev, clearlyInside: true, outside: false }, SELECTED);
    expect(due(closed, 'a', ev, SELECTED, T + 600_000)).toBe('suppressed');
  });
  it('revoked consent, replaced link/grant or a changed zone always suppress', () => {
    for (const key of ['currentAccess', 'sameOriginalLinkAndGrant', 'sameZone'] as const)
      expect(due(ep(), 'a', { ...ev, [key]: false }, SELECTED, T + 600_000)).toBe('suppressed');
    const zc = closeFromEvidence(ep(), { ...ev, sameZone: false }, SELECTED);
    expect(zc.closed).toBe('zone_changed');
  });
});
