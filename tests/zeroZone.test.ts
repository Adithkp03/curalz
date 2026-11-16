import { describe, it, expect } from 'vitest';
import { validateZone } from '../src/location/evaluate';
describe('zone validation', () => {
  it('rejects the 0,0 centre a blank form produces', () => {
    expect(validateZone({ lat: 0, lon: 0, radiusM: 300 })).toBeFalsy();
    expect(validateZone({ lat: 10.0009, lon: 76.0004, radiusM: 300 })).toBeTruthy();
  });
});
