import { describe, it, expect, vi, beforeEach } from 'vitest';
const mocks = vi.hoisted(() => ({ update: vi.fn(), vector: vi.fn(), extract: vi.fn() }));
vi.mock('../src/models/Memory', () => ({ default: { findOneAndUpdate: mocks.update } }));
vi.mock('../src/services/qdrant.service', () => ({ storeVector: mocks.vector }));
vi.mock('../src/services/entityExtraction.service', () => ({ extractEntities: mocks.extract }));
import { processThought } from '../src/services/thought.service';
const data = {qdrantId:'11111111-1111-4111-8111-111111111111',userId:'synthetic-user',rawText:'A synthetic memory',embedding:[1,2],timestamp:new Date('2026-01-01')};
beforeEach(() => { vi.clearAllMocks(); mocks.extract.mockResolvedValue({people:[],activities:[]}); mocks.update.mockResolvedValue({_id:{toString:()=> 'memory-id'}}); mocks.vector.mockResolvedValue(undefined); });
describe('retriable thought persistence', () => {
 it('reuses the same memory and vector IDs on replay', async () => {
  await processThought(data); await processThought(data);
  expect(mocks.update).toHaveBeenCalledTimes(2);
  expect(mocks.update.mock.calls[0][0]).toEqual({qdrantId:data.qdrantId,userId:data.userId});
  expect(mocks.update.mock.calls[0][2]).toMatchObject({upsert:true});
  expect(mocks.vector.mock.calls.map(c=>c[0])).toEqual([data.qdrantId,data.qdrantId]);
 });
 it('propagates vector failure for durable step retry and can replay', async () => {
  mocks.vector.mockRejectedValueOnce(new Error('simulated outage'));
  await expect(processThought(data)).rejects.toThrow('simulated outage');
  await expect(processThought(data)).resolves.toBeUndefined();
 });
 it('keeps storing the memory if optional entity extraction fails', async () => {
  mocks.extract.mockRejectedValueOnce(new Error('synthetic AI outage'));
  await expect(processThought(data)).resolves.toBeUndefined();
  expect(mocks.vector).toHaveBeenCalled();
 });
});
