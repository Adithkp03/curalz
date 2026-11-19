/**
 * PROPOSED defaults for review. None of these are approved. Every value is injectable so a
 * reviewer (patient safety advisers, AFMC) can change it, and the whole feature is off unless
 * LOCATION_FEATURE_ENABLED === 'true'.
 */
export interface LocationConfig {
    maxFixAgeMs: number;          // older fixes are "unknown", never inside/outside
    maxAccuracyM: number;         // less precise fixes cannot trigger an exit alert
    exitConfirmFixes: number;     // consecutive outside fixes needed
    exitConfirmSpanMs: number;    // and they must span at least this long
    reenterMarginRatio: number;   // must be this fraction of radius inside to re-arm
    nearbyRadiusM: number;
    nearbyMaxFixAgeMs: number;
    nearbyCooldownMs: number;
    nearbyResetDistanceM: number; // caregiver must go beyond this to re-arm nearby
    minZoneRadiusM: number;
    maxZoneRadiusM: number;
    batteryLowBelowPct: number;   // alert only when strictly below this and not charging
    batteryMaxAgeMs: number;      // an older reading is unknown, never shown or alerted
}

export const PROPOSED_LOCATION_CONFIG: LocationConfig = {
    maxFixAgeMs: 5 * 60_000,
    maxAccuracyM: 100,
    exitConfirmFixes: 2,
    exitConfirmSpanMs: 60_000,
    reenterMarginRatio: 0.9,
    nearbyRadiusM: 200,
    nearbyMaxFixAgeMs: 2 * 60_000,
    nearbyCooldownMs: 4 * 3_600_000,
    nearbyResetDistanceM: 500,
    minZoneRadiusM: 100,
    maxZoneRadiusM: 5000,
    batteryLowBelowPct: 25,
    batteryMaxAgeMs: 10 * 60_000,
};

export const locationFeatureEnabled = (env: Record<string, string | undefined> = process.env) =>
    env.LOCATION_FEATURE_ENABLED === 'true';
