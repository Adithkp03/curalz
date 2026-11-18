# Two-minute location-update warning, isolated test

Owner chose a120second no-fresh-update threshold and a separate free minute-cadence Cloudflare checker on November18,2026. This is not a boundary crossing alert or proof the phone is offline.

- Module mounted only under LOCATION_TEST_MODE. Also requires LOCATION_FEATURE_ENABLED=true and LOCATION_HEALTH_ENABLED=true. Defaults fail closed.
- POST /api/location-health/jobs/sweep uses a separate >=32character LOCATION_CRON_SECRET bearer,not a patient token.
- GET /api/location-health/:patientId and /events/:id require current caregiver authentication and exact active original link/grant incarnation.
- Metadata contains patient/caregiver/link/grant IDs and freshness/outage times,not coordinates. Caregiver role alone is insufficient.
- First activation grants each existing authorized pair a fresh grace period. A fresh,valid,in-order GPS timestamp refreshes the window. Uploading an old or repeated cached fix cannot fake recovery.
- Poor accuracy is not the same as stopped updates;normal boundary accuracy rules remain separate and unchanged.
- One provider attempt per outage per caregiver. Atomic durable session claim precedes provider interaction. An ambiguous failure/crash can miss an alert rather than replay it. No exactly-once or delivery guarantee.
- No-device is not a provider attempt. When a capable device later registers,it may receive a newly validated warning for the still-open outage,with a fresh attempt timestamp. Old incapable APKs do not receive this new alert kind.
- Revoked/unlinked recipients are suppressed. Fresh recovery invalidates the old event and rearms a new outage. Event retention cannot cause the same attempted outage to alert again.
- No background loop is assumed on Vercel. Dedicated location-scheduler/worker.ts invokes the endpoint once a minute. It has no public handler,no response-body logs,no patient data in Cloudflare,and a distinct LOCATION_SWEEP_KEY. Medication scheduler is unchanged.
- A120second threshold is normally detected at the next minute tick,roughly120-180seconds after the last fresh fix. Cron/platform/network/device delays can make it later.
- LOCATION_HEALTH_SCHEDULER_ACTIVE is display metadata only and must not be true until authenticated sweep operation is verified. Its absence does not disable the endpoint.
- Sweeps fail explicitly over1000grants/sessions. This is an isolated engineering test,not a production-scale worker. Scaling/pagination and operational failure alerting require review before wider enrollment.

## Activation state at preparation
Source is on a separate review branch,not the deployment-connected branch,so it cannot bypass the pending Vercel identity step. Dedicated Cloudflare resource and secret are saved;isolated Vercel secret/config are saved but require a new authorized deployment. No successful live sweep/device delivery or real patient enrollment is claimed.

## Native and boundary scope
App v11 preparation adds a native Android location/upload foreground service,encrypted auth storage,server consent rechecks,network retry of only still-fresh in-memory fixes,and permitted sticky process recreation. Boot only posts a user-tap resume notification;it does not silently collect location or request Always Allow. Logout and on-phone Stop clear native session material. Device tests are still required.
Boundary repeat decisions remain unwired in proposals/. No stop-scope,stale-repeat or return-inside defaults were silently selected.

## Sources checked November18
https://developer.android.com/develop/sensors-and-location/location/permissions
https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start
https://developer.android.com/develop/background-work/services/fgs/handle-user-stopping
https://developers.cloudflare.com/workers/configuration/cron-triggers/
https://developers.cloudflare.com/workers/platform/pricing/
