import { Worker, Job } from "bullmq";
import { redisConnection } from "./redis.connection";
import { THOUGHT_QUEUE_NAME, ThoughtJobData } from "./thought.queue";
import { extractEntities } from "../services/entityExtraction.service";
import { storeVector } from "../services/qdrant.service";
import Memory from "../models/Memory";

import { processThought } from '../services/thought.service';
export const thoughtWorker = new Worker<ThoughtJobData>(
  THOUGHT_QUEUE_NAME,
  job => processThought(job.data),
  {
    connection: redisConnection,
    concurrency: 5,
  },
);

thoughtWorker.on("failed", (job, err) => {
  console.error(`  ✘ [worker] job ${job?.id} failed:`, err.message);
});
