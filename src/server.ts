import http from "http";
import app from "./app";
import connectDB from "./config/db";
import { setupQdrant } from "./config/qdrant";
import dotenv from "dotenv";
if (!["inline", "workflow"].includes(process.env.THOUGHT_PROCESSING_MODE || "")) import("./queues/thought.worker");

dotenv.config();

// ─── Startup Env Validation ───────────────────────────────────────────────────
// Fail fast with a clear error instead of cryptic DNS ENOTFOUND at runtime.
const REQUIRED_ENV_VARS = [
  "MONGO_URI",
  "JWT_SECRET",
  "REDIS_HOST",
  "REDIS_PORT",
  "REDIS_PASSWORD",
  "QDRANT_URL",
  "QDRANT_API_KEY",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "GOOGLE_API_KEY",
 
];

const missing = REQUIRED_ENV_VARS.filter((key) => !(["inline", "workflow"].includes(process.env.THOUGHT_PROCESSING_MODE || "") && key.startsWith("REDIS_")) && !process.env[key]);
if (missing.length > 0) {
  console.error("\n❌ FATAL: Missing required environment variables:");
  missing.forEach((key) => console.error(`   - ${key}`));
  console.error("\nSet these in your deployment platform and restart.\n");
  process.exit(1);
}
// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 5000;

connectDB();
setupQdrant();

const server = http.createServer(app);

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Bull Board dashboard → http://localhost:${PORT}/queues`);
});
