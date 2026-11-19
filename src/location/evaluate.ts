import { LocationConfig, PROPOSED_LOCATION_CONFIG } from './config';

export interface Fix { lat: number; lon: number; accuracyM: number; recordedAt: number } // epoch ms, device clock
export interface Zone { lat: number; lon: number; radiusM: number }

export const isValidFix = (f: any): f is Fix =>
    f && Number.isFinite(f.lat) && Number.isFinite(f.lon) && Math.abs(f.lat) <= 90 && Math.abs(f.lon) <= 180 &&
    Number.isFinite(f.accuracyM) && f.accuracyM >= 0 && Number.isFinite(f.recordedAt);

export function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
    const R = 6371008.8, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function validateZone(z: any, cfg: LocationConfig = PROPOSED_LOCATION_CONFIG): z is Zone {
    return z && isValidFix({ ...z, accuracyM: 0, recordedAt: 0 }) && !(z.lat === 0 && z.lon === 0) /* blank form / no fix, never a real centre */ &&
        Number.isFinite(z.radiusM) && z.radiusM >= cfg.minZoneRadiusM && z.radiusM <= cfg.maxZoneRadiusM;
}

export type Position = 'inside' | 'outside' | 'unknown';

/** Classify one fix. Stale, invalid, future-dated or imprecise fixes are 'unknown', never a guess. */
export function classify(zone: Zone, fix: Fix, now: number, cfg: LocationConfig = PROPOSED_LOCATION_CONFIG): Position {
    if (!isValidFix(fix) || fix.recordedAt > now + 30_000 || now - fix.recordedAt > cfg.maxFixAgeMs) return 'unknown';
    const d = distanceM(zone, fix);
    if (d + fix.accuracyM <= zone.radiusM) return 'inside';
    if (fix.accuracyM <= cfg.maxAccuracyM && d - fix.accuracyM > zone.radiusM) return 'outside';
    return 'unknown';
}

export interface BoundaryState {
    armed: boolean;              // true: next confirmed exit will alert
    outsideSince?: number;       // first fix of the current outside run
    outsideCount: number;
}
export const initialBoundaryState = (): BoundaryState => ({ armed: true, outsideCount: 0 });

/**
 * Feed fixes in arrival order. Returns the new state and whether to alert caregivers now.
 * Alerts once per exit; re-arms only after a clearly-inside fix (hysteresis). Unknown fixes change nothing.
 */
export function stepBoundary(state: BoundaryState, zone: Zone, fix: Fix, now: number,
    cfg: LocationConfig = PROPOSED_LOCATION_CONFIG): { state: BoundaryState; alert: boolean } {
    const pos = classify(zone, fix, now, cfg);
    if (pos === 'unknown') return { state, alert: false };
    if (pos === 'inside') {
        const clearly = distanceM(zone, fix) + fix.accuracyM <= zone.radiusM * cfg.reenterMarginRatio;
        return { state: { armed: state.armed || clearly, outsideCount: 0 }, alert: false };
    }
    const outsideSince = state.outsideCount === 0 ? fix.recordedAt : state.outsideSince!;
    const outsideCount = state.outsideCount + 1;
    const confirmed = outsideCount >= cfg.exitConfirmFixes && fix.recordedAt - outsideSince >= cfg.exitConfirmSpanMs;
    if (confirmed && state.armed) return { state: { armed: false, outsideSince, outsideCount }, alert: true };
    return { state: { armed: state.armed, outsideSince, outsideCount }, alert: false };
}

export interface NearbyState { notifiedAt?: number; rearmed: boolean }
export const initialNearbyState = (): NearbyState => ({ rearmed: true });

/**
 * Patient is told the caregiver is nearby. Both fixes must be fresh and precise; one gentle notice per
 * visit (cooldown, or the caregiver moving clearly away first). Only call when the caregiver has an
 * active, patient-approved link and an active location-sharing session.
 */
export function stepNearby(state: NearbyState, patientFix: Fix, caregiverFix: Fix, now: number,
    cfg: LocationConfig = PROPOSED_LOCATION_CONFIG): { state: NearbyState; notify: boolean } {
    const fresh = (f: Fix) => isValidFix(f) && f.recordedAt <= now + 30_000 && now - f.recordedAt <= cfg.nearbyMaxFixAgeMs &&
        f.accuracyM <= cfg.maxAccuracyM;
    if (!fresh(patientFix) || !fresh(caregiverFix)) return { state, notify: false };
    const d = distanceM(patientFix, caregiverFix);
    if (d - patientFix.accuracyM - caregiverFix.accuracyM > cfg.nearbyResetDistanceM) {
        return { state: { ...state, rearmed: true }, notify: false };
    }
    const coolingDown = state.notifiedAt !== undefined && now - state.notifiedAt < cfg.nearbyCooldownMs;
    const near = d + patientFix.accuracyM + caregiverFix.accuracyM <= cfg.nearbyRadiusM;
    if (near && state.rearmed && !coolingDown) return { state: { notifiedAt: now, rearmed: false }, notify: true };
    return { state, notify: false };
}
