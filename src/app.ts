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

// Do not expose the queue dashboard with patient data.
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
app.use("/api/elevenlabs", elevenlabsRoutes);

app.get("/", (req, res) => {
  res.send("Medical Memory Assistant API is running");
});

export default app;
