import type { ThoughtJobData } from '../queues/thought.queue';
import { extractEntities } from './entityExtraction.service';
import { storeVector } from './qdrant.service';
import Memory from '../models/Memory';
export const processThought = async ({ qdrantId, userId, rawText, embedding, timestamp }: ThoughtJobData) => {

  console.log(`\n⚙  [worker] starting job ${qdrantId} for qdrantId=${qdrantId}`);
  const origin = performance.now();

  const elapsed = () => `${(performance.now() - origin).toFixed(2)}ms`;

  // Step 1 — Entity extraction (optional, non-blocking for user)
  let entities = { people: [] as string[], activities: [] as string[] };
  try {
    const t = performance.now();
    entities = await extractEntities(rawText);
    console.log(`  ✔ [worker] gemini:extractEntities → ${(performance.now() - t).toFixed(2)}ms`);
  } catch (err) {
    console.error("  ✘ [worker] gemini:extractEntities failed, continuing with empty entities:", err);
  }

  // Step 2 — MongoDB write
  let memoryId = "";
  {
    const t = performance.now();
    const memory = await Memory.findOneAndUpdate({ qdrantId, userId }, { $setOnInsert: {
      userId,
      qdrantId,
      type: "chat",
      createdBy: "patient",
      timestamp: new Date(timestamp),
      data: {
        rawText,
        entities,
      }
    } }, { upsert: true, returnDocument: "after" });
    memoryId = memory._id.toString();
    console.log(`  ✔ [worker] mongodb:storeThought → ${(performance.now() - t).toFixed(2)}ms`);
  }

  // Step 3 — Qdrant vector storage
  {
    const t = performance.now();
    await storeVector(qdrantId, embedding, {
      userId,
      memoryId,
      type: "chat",
      searchableText: rawText,
      rawText,
      timestamp: new Date(timestamp),
      entities,
    });
    console.log(`  ✔ [worker] qdrant:storeVector → ${(performance.now() - t).toFixed(2)}ms`);
  }

  console.log(`⚙  [worker] job ${qdrantId} done → total ${elapsed()}\n`);
};

