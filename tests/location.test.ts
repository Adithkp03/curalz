import { describe, it, expect } from 'vitest';
import { distanceM, classify, stepBoundary, initialBoundaryState, stepNearby, initialNearbyState, validateZone, isValidFix } from '../src/location/evaluate';
import { locationFeatureEnabled } from '../src/location/config';

// Synthetic coordinates only. ~0.001 deg latitude is about 111 m.
const home = { lat: 10.0, lon: 76.0, radiusM: 300 };
const at = (dLatDeg: number, t: number, acc = 10) => ({ lat: 10.0 + dLatDeg, lon: 76.0, accuracyM: acc, recordedAt: t });
const T0 = 1_000_000_000_000;

describe('geometry and validation', () => {
  it('haversine is about right', () => { expect(Math.round(distanceM({ lat: 10, lon: 76 }, { lat: 10.001, lon: 76 }))).toBeGreaterThan(108); expect(distanceM({ lat: 10, lon: 76 }, { lat: 10.001, lon: 76 })).toBeLessThan(114); });
  it('rejects invalid fixes and zones', () => {
    expect(isValidFix({ lat: 91, lon: 0, accuracyM: 1, recordedAt: 1 })).toBe(false);
    expect(isValidFix({ lat: NaN, lon: 0, accuracyM: 1, recordedAt: 1 })).toBe(false);
    expect(validateZone({ ...home, radiusM: 10 })).toBe(false);
    expect(validateZone({ ...home, radiusM: 99999 })).toBe(false);
    expect(validateZone(home)).toBe(true);
  });
  it('feature is off unless explicitly enabled', () => {
    expect(locationFeatureEnabled({})).toBe(false);
    expect(locationFeatureEnabled({ LOCATION_FEATURE_ENABLED: '1' })).toBe(false);
    expect(locationFeatureEnabled({ LOCATION_FEATURE_ENABLED: 'true' })).toBe(true);
  });
});

describe('classify', () => {
  it('inside, outside, and unknown on stale / future / imprecise fixes', () => {
    expect(classify(home, at(0, T0), T0)).toBe('inside');
    expect(classify(home, at(0.005, T0), T0)).toBe('outside');
    expect(classify(home, at(0.005, T0), T0 + 6 * 60_000)).toBe('unknown');          // stale
    expect(classify(home, at(0.005, T0 + 120_000), T0)).toBe('unknown');            // future clock
    expect(classify(home, at(0.005, T0, 500), T0)).toBe('unknown');                 // too imprecise
  });
  it('uncertainty straddling the edge is unknown, not outside', () => {
    expect(classify(home, at(0.0030, T0, 40), T0)).toBe('unknown'); // ~333 m +/- 40 vs 300 m
  });
});

describe('boundary exit', () => {
  const run = (fixes: ReturnType<typeof at>[], now = (f: any) => f.recordedAt) => {
    let s = initialBoundaryState(); const alerts: number[] = [];
    fixes.forEach((f, i) => { const r = stepBoundary(s, home, f, now(f)); s = r.state; if (r.alert) alerts.push(i); });
    return { s, alerts };
  };
  it('one outside fix (GPS jump) does not alert; two spread over a minute do, once', () => {
    expect(run([at(0.005, T0)]).alerts).toEqual([]);
    expect(run([at(0.005, T0), at(0.005, T0 + 30_000)]).alerts).toEqual([]);
    expect(run([at(0.005, T0), at(0.005, T0 + 61_000), at(0.006, T0 + 120_000), at(0.007, T0 + 180_000)]).alerts).toEqual([1]);
  });
  it('a jump outside then back inside does not alert', () => {
    expect(run([at(0.005, T0), at(0, T0 + 61_000), at(0.005, T0 + 120_000)]).alerts).toEqual([]);
  });
  it('unknown fixes never alert or reset an exit run', () => {
    const r = run([at(0.005, T0), at(0.005, T0 + 30_000, 500), at(0.005, T0 + 61_000)]);
    expect(r.alerts).toEqual([1 + 1]);
  });
  it('re-arms only after clearly inside, then alerts again on the next exit', () => {
    const out1 = [at(0.005, T0), at(0.005, T0 + 61_000)];
    const edge = [at(0.0025, T0 + 100_000)]; // ~278 m, inside 300 but not within 90%
    const out2 = [at(0.005, T0 + 200_000), at(0.005, T0 + 270_000)];
    expect(run([...out1, ...edge, ...out2]).alerts).toEqual([1]);
    const clear = [at(0, T0 + 100_000)];
    expect(run([...out1, ...clear, ...out2]).alerts).toEqual([1, 4]);
  });
  it('stale feed produces no alert at all', () => {
    let s = initialBoundaryState();
    const r1 = stepBoundary(s, home, at(0.005, T0), T0 + 10 * 60_000); s = r1.state;
    const r2 = stepBoundary(s, home, at(0.005, T0 + 61_000), T0 + 10 * 60_000);
    expect(r1.alert || r2.alert).toBe(false);
  });
});

describe('caregiver nearby (notifies the patient)', () => {
  const pf = (t: number, acc = 10) => at(0, t, acc);
  const cf = (dLat: number, t: number, acc = 10) => at(dLat, t, acc);
  it('notifies once when both fresh fixes are within the radius', () => {
    let s = initialNearbyState();
    const a = stepNearby(s, pf(T0), cf(0.0008, T0), T0); s = a.state;
    expect(a.notify).toBe(true);
    expect(stepNearby(s, pf(T0 + 1000), cf(0.0005, T0 + 1000), T0 + 1000).notify).toBe(false);
  });
  it('not when far, stale, or imprecise', () => {
    const s = initialNearbyState();
    expect(stepNearby(s, pf(T0), cf(0.01, T0), T0).notify).toBe(false);
    expect(stepNearby(s, pf(T0 - 3 * 60_000), cf(0.0005, T0), T0).notify).toBe(false);
    expect(stepNearby(s, pf(T0), cf(0.0005, T0, 300), T0).notify).toBe(false);
  });
  it('repeats only after the caregiver moves clearly away and the cooldown passes', () => {
    let s = initialNearbyState();
    s = stepNearby(s, pf(T0), cf(0.0008, T0), T0).state;
    const later = T0 + 5 * 3_600_000;
    expect(stepNearby(s, pf(later), cf(0.0008, later), later).notify).toBe(false); // never left
    s = stepNearby(s, pf(later), cf(0.02, later), later).state;                       // went away
    const r = stepNearby(s, pf(later + 1000), cf(0.0008, later + 1000), later + 1000);
    expect(r.notify).toBe(true);
  });
  it('cooldown blocks a quick return', () => {
    let s = initialNearbyState();
    s = stepNearby(s, pf(T0), cf(0.0008, T0), T0).state;
    s = stepNearby(s, pf(T0 + 60_000), cf(0.02, T0 + 60_000), T0 + 60_000).state;
    expect(stepNearby(s, pf(T0 + 120_000), cf(0.0008, T0 + 120_000), T0 + 120_000).notify).toBe(false);
  });
});
