# Vercel demo preparation (not production-ready)

This branch is for synthetic data only. No deployment is approved for real patient data.

## Durable workflow mode (recommended, pending live verification)
Set THOUGHT_PROCESSING_MODE=workflow on Vercel. Nitro compiles the workflow and step handlers. The HTTP request awaits workflow start before acknowledging success. Vercel records and retries the step after request termination. The step connects to MongoDB independently, upserts the memory by qdrantId and userId, and upserts the same Qdrant point. Re-execution does not create a second record. A unique qdrantId index must be created on a fresh database before accepting traffic.

Clients may send a UUID v4 Idempotency-Key to reuse a thought ID across request retries. The existing mobile client does not yet send this header. Cross-request retries without it can duplicate a thought. MongoDB and Qdrant are still not atomic, but failed vector storage is retried by the workflow. Failures beyond the workflow retry cap require operational replay. Test crash/retry behavior on the actual deployment before delivery.

## Optional inline processing mode
Set THOUGHT_PROCESSING_MODE=inline on Vercel. The HTTP handler awaits entity extraction, MongoDB upsert and Qdrant upsert before sending success, or before SSE done. Work is not launched as a background loop. Errors are returned rather than silently dropped. MongoDB upsert uses the generated qdrantId to avoid duplicate writes during the same processing attempt.

This changes durability: the original BullMQ mode retries failures three times through Redis. Inline mode has no automatic retry after termination, a crash or a timeout. MongoDB and Qdrant writes are not atomic. A vector failure can leave a MongoDB record not yet searchable. Client retries currently create a new qdrantId and can duplicate a thought. Do not describe inline mode as equivalent durable processing. A durable outbox with idempotency keys and scheduled retries is needed for reliable service.

Queue mode remains available for a separately hosted worker. Vercel Hobby daemon quotas do not support an always-on minimum-size worker for a full month.

## Configuration
See .env.vercel.example. Use dedicated databases and keys, not other projects' data. GOOGLE_API_KEY is canonical; GEMINI_API_KEY is accepted for compatibility. Confirm the configured Gemini chat model and embedding model are available on the free quota. Embeddings must have 3072 dimensions.

Supabase needs a server-only service-role key for signing uploads. It must never be included in the APK or browser frontend. The existing getPublicUrl media design is not suitable for private patient photos; private bucket reads and authorized, expiring download URLs still need implementation. Keep media disabled or synthetic until that is fixed. Use an alzhefi-media bucket rather than an unrelated project's bucket.

Live ElevenLabs voice is optional and disabled without ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID. Its route now requires JWT authentication. The mobile voice screen remains unfinished.

## Required validation before delivery
- Compile and regression tests, including auth, caregiver isolation and media access.
- Dedicated MongoDB/Qdrant connection and Qdrant 3072-dimensional collection.
- Synthetic patient and caregiver signup/login and linking.
- Memory create, retrieval, photo upload and access isolation.
- Chat, embeddings and error recovery.
- Reminders on a real phone with the app open and closed.
- Build APK with verified replacement HTTPS API URL, install and launch on Android.

## Unfinished inherited features
Voice conversation screen; hardcoded flashcards and caregiver profile; chat image upload; contact delete endpoint; default 911 contact; settings switches; closed-app voice reminders; password reset and Google sign-in. This branch does not make those features complete.

## Connected synthetic checks (October 30, 2026)
A clean clone built successfully after tracking the previously ignored src/index.ts entrypoint. Dedicated MongoDB, Qdrant and Gemini passed register201, login200, chat200 and history200. Replaying the same UUID Idempotency-Key left one memory. A second patient saw an empty history; no-token requests returned401, a patient on a caregiver route403, and an unlinked caregiver reading a patient403. Synthetic users/memories were deleted and zero matching vectors confirmed. These connected checks used inline mode only as a local harness; they do not prove hosted Workflow recovery.

The inherited email-only caregiver linking route is not consent-based: it previously allowed caregivers to self-link using a patient email. This route now fails closed with403 until patient-approved invitations exist. Do not use this prototype with real people or patient data until patient approval or invitation-based authorization is implemented and tested. Media remains disabled pending private object storage and authorized expiring reads. Baseline APK builds do not prove installation or runtime behavior and retain the old API until rebuilt with the new verified URL.
