/** Boundary-repeat decision policy. The owner settled the choices on 2026-11-19 IST:
 * stopScope 'caregiver' (Stop silences only that caregiver, that crossing only),
 * stale 'unresolved_reminder' (keep reminding, explicitly last-seen-outside with the
 * last-seen location, never a claim of current position), stopOnReturn true (a fresh
 * confirmed return inside stops repeats automatically). The selected policy constant
 * lives in src/boundary-repeat/service.ts as REPEAT_POLICY.
 */
export const REPEAT_INTERVAL_MS = 10 * 60_000;
export type Policy = { stopScope: 'caregiver' | 'episode'; stale: 'pause' | 'unresolved_reminder'; stopOnReturn: boolean };
export type Episode = { id: string; openedAt: number; closed?: 'returned' | 'zone_changed' | 'sharing_ended'; stoppedBy: string[]; lastAttemptAt: Record<string, number> };
export type Evidence = { currentAccess: boolean; sameOriginalLinkAndGrant: boolean; sameZone: boolean; fresh: boolean; clearlyInside: boolean; outside: boolean };
export function closeFromEvidence(ep: Episode, e: Evidence, p: Policy): Episode {
 if (ep.closed) return ep;
 if (!e.sameZone) return { ...ep, closed: 'zone_changed' };
 if (p.stopOnReturn && e.fresh && e.clearlyInside) return { ...ep, closed: 'returned' };
 return ep;
}
export function stop(ep: Episode, caregiver: string, p: Policy): Episode {
 const key = p.stopScope === 'episode' ? '*' : caregiver;
 return ep.stoppedBy.includes(key) ? ep : { ...ep, stoppedBy: [...ep.stoppedBy, key] };
}
export type Decision = 'suppressed' | 'wait' | 'outside_reminder' | 'unresolved_reminder';
export function due(ep: Episode, caregiver: string, e: Evidence, p: Policy, now: number): Decision {
 if (ep.closed || !e.currentAccess || !e.sameOriginalLinkAndGrant || !e.sameZone || ep.stoppedBy.includes('*') || ep.stoppedBy.includes(caregiver)) return 'suppressed';
 const last = ep.lastAttemptAt[caregiver] ?? ep.openedAt;
 if (!Number.isFinite(now) || now < last + REPEAT_INTERVAL_MS) return 'wait';
 if (!e.fresh || !e.outside) return p.stale === 'unresolved_reminder' ? 'unresolved_reminder' : 'suppressed';
 return 'outside_reminder';
}
/** Caller must persist this in an atomic claim BEFORE attempting the provider.
 * A crash/ambiguous failure skips that attempt rather than retrying it immediately.
 * Late sweeps schedule from now, never burst through missed slots.
 */
export function claim(ep: Episode, caregiver: string, now: number): Episode {
 return { ...ep, lastAttemptAt: { ...ep.lastAttemptAt, [caregiver]: now } };
}
