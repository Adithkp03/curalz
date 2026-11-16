# Caregiver location features: test-only plan (NOT clinically validated, NOT enabled)

Status: draft for review. `LOCATION_FEATURE_ENABLED` must equal `true` for any location code to run (default off).
Nothing here stores, receives or sends location. Guardian authorisation for patients who cannot consent is NOT implemented.

## Permission model
1. Caregiver link: patient-approved, revocable (`/api/care-links`). Covers only: patient name and email, recent assistant chats,
   reminders (read/add/change/delete), adding memories. It never includes location.
2. Location grant: separate, explicit, per caregiver (`LocationGrant`). Needs an active link. Ending a link ends the grant.
   Seeded/legacy links get no grant.

## Test-only configuration (src/location/config.ts, all injectable)
| Setting | Test value | Why |
|---|---|---|
| Zone radius | 100 m to 5 km, no default zone | caregiver must choose; small radii give GPS-noise alarms |
| Stale fix | older than 5 min is "unknown" | never show unknown as safe or as outside |
| Fix accuracy for exit | 100 m or better | imprecise fixes cannot raise an alert |
| Exit confirmation | 2 outside fixes 60 s apart, whole error margin outside | avoids single GPS jumps |
| Re-arm | a fix inside 90% of radius | avoids repeat alerts at the edge |
| Nearby distance | 200 m (a test value; says nothing about walking time or GPS safety) | tune after two-phone tests |
| Nearby freshness | both fixes 2 min or newer, 100 m or better | |
| Nearby repeat | 4 h cooldown and caregiver went beyond 500 m | one gentle notice per visit |
These are starting points for the two-phone test, to be changed from its results.

## Not built yet
FCM push (needs a Firebase project and google-services config), Android background location + foreground service type + permission
disclosures (see developer.android.com location background and foreground-service-types guides), boundary/session endpoints,
caregiver "visiting" sessions, retention jobs, in-app location consent UI. Background delivery is best effort: battery optimisation,
permission changes and no signal can stop updates, so this must not be presented as a safety or emergency service.

## Real-device validation (owner)
Two phones, caregiver and patient synthetic accounts, test zone around a safe place. Record: location permission flow,
screen-off and app-closed behaviour, delay from crossing to notification, stale handling, revoke behaviour.
