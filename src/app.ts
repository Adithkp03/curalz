import express from "express";
import cors from "cors";
import helmet from "helmet";
import connectDB from "./config/db";
import { initializeQdrant } from "./services/qdrant.service";

import authRoutes from "./routes/auth.routes";
import eventRoutes from "./routes/event.routes";
import conversationRoutes from "./routes/conversation.routes";
import chatRoutes from "./routes/chat.routes";
import caregiverRoutes from "./routes/caregiver.routes";
import careLinkRoutes, { caregiverPatientsRouter } from "./routes/careLink.routes";
import { makeLocationRouter } from "./routes/location.routes";
import { makeFcmSender } from "./location/fcmSender";
import mediaRoutes from "./routes/media.routes";
import patientRoutes from "./routes/patient.routes";
import elevenlabsRoutes from "./routes/elevenlabs.route";

const app = express();

// Middleware
app.use(cors());
app.use(
  helmet({
    contentSecurityPolicy: false, // Bull Board UI needs inline scripts
  }),
);
app.use(express.json());

/**
 * LOCATION_TEST_MODE=true builds a minimal API for an isolated test host: only auth, care-links and location routes.
 * Chat, events, media, caregiver data, Qdrant, Supabase, Gemini and ElevenLabs are NOT mounted (404), never dummy-working.
 * Fails closed (503 on every /api call) unless JWT_SECRET, MONGO_URI and LOCATION_FEATURE_ENABLED=true are all set.
 * Data lives in a fixed database name, never the database named in the URI, so a mistaken URI cannot read another database.
 */
export const LOCATION_TEST_DB = 'alzhefi_location_test';
const testMode = process.env.LOCATION_TEST_MODE === 'true';
if (testMode) {
  // Authenticated location-test responses must never be reused by an HTTP
  // cache, including Android conditional requests after an earlier 200.
  app.disable('etag');
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('CDN-Cache-Control', 'no-store');
    res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Vary', 'Authorization');
    next();
  });
  app.get('/health', (_req, res) => res.json({ status: 'ok', mode: 'location-test' }));
  app.use('/api', async (_req, res, next) => {
    if (!process.env.JWT_SECRET || !process.env.MONGO_URI || process.env.LOCATION_FEATURE_ENABLED !== 'true')
      return res.status(503).json({ error: 'Test host not configured' });
    try { await connectDB({ dbName: LOCATION_TEST_DB }); next(); } catch { res.status(503).json({ error: 'Database unavailable' }); }
  });
  app.use('/api/auth', authRoutes);
  app.use('/api/care-links', careLinkRoutes);
  app.use('/api/caregiver', caregiverPatientsRouter); // test host: only the approved-patient list; other caregiver data stays unmounted (404)
  app.use('/api/location', makeLocationRouter(makeFcmSender() ?? undefined));
  app.get('/', (_req, res) => res.send('AlzheFi location test host'));
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
}

// Do not expose the queue dashboard with patient data.
if (!testMode) {
let vectorReady: Promise<void> | undefined;
app.get('/health', (_req, res) => res.json({ status: 'ok', mode: process.env.THOUGHT_PROCESSING_MODE || 'queue' }));
app.use('/api', async (_req, _res, next) => {
  try {
    if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required');
    await connectDB();
    if (!vectorReady) vectorReady = initializeQdrant().catch(error => { vectorReady = undefined; throw error; });
    await vectorReady;
    next();
  } catch (error) { next(error); }
});
// Routes
app.use("/api/auth", authRoutes);
app.use("/api/events", eventRoutes);
app.use("/api/conversation", conversationRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/caregiver", caregiverRoutes);
app.use("/api/media", mediaRoutes);
app.use("/api/patient", patientRoutes);
app.use("/api/care-links", careLinkRoutes);
app.use("/api/location", makeLocationRouter(makeFcmSender() ?? undefined)); // 404 unless LOCATION_FEATURE_ENABLED=true; FCM only if FIREBASE_SERVICE_ACCOUNT_JSON set
app.use("/api/elevenlabs", elevenlabsRoutes);

app.get("/", (req, res) => {
  res.send("Medical Memory Assistant API is running");
});
}

export default app;
