import type { ThoughtJobData } from '../queues/thought.queue';
export async function rememberThought(data: ThoughtJobData) {
  'use workflow';
  await persistMemory(data);
}
async function persistMemory(data: ThoughtJobData) {
  'use step';
  const { default: connectDB } = await import('../config/db');
  const { processThought } = await import('../services/thought.service');
  await connectDB();
  await processThought(data);
}
