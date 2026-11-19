# Isolated medication test API

Mounted only in LOCATION_TEST_MODE,inside the existing fixed test database and no-store/auth protections. Legacy events/caregiver reminder endpoints remain unmounted.

MEDICATION_SHARING_ENABLED and MEDICATION_FOLLOWUP_ENABLED default false. These settings must not be turned on without the user's clear decision. Per-patient followupOn also defaults false. Medication sharing is independent of location and is bound to the exact active CareLink ID.

The optional POST /api/medication/jobs/sweep requires an independent MEDICATION_CRON_SECRET of at least32characters,an exact bearer match and isolated test mode. No user JWT qualifies. Do not store the secret in source or a URL. No external scheduler is deployed by this change. The adapter only returns aggregate attempted counts,never patient data.

Follow-up is primary-only,one provider attempt per occurrence,requires current medication sharing,current active link,patient opt-in,active plan,unconfirmed dose and grace window15..240minutes. Only doses due after opt-in and no more than6hours old qualify. Definitely-no-device queues may retry while eligible; ambiguous provider errors and processing-state crashes never automatically replay. Provider acceptance is not delivery. A crash between claim and provider/result persistence can lose an alert; this is deliberately not an exactly-once delivery guarantee.

For a later approved dedicated external cron,the worker should only POST to the fixed isolated endpoint with its dedicated secret,have no public fetch surface,store no medical data,not log response bodies/credentials,and run on a verified free/no-card plan. It must not modify unrelated Workers. Both provider scheduling and FCM/device delivery remain best-effort.
