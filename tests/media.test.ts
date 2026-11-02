import {describe,it,expect,vi,beforeEach} from 'vitest';
const mocks=vi.hoisted(()=>({upload:vi.fn(),read:vi.fn()}));
vi.mock('../src/config/supabase',()=>({MEDIA_BUCKET:'alzhefi-media',getSupabase:()=>({storage:{from:()=>({createSignedUploadUrl:mocks.upload,createSignedUrl:mocks.read})}})}));
import {getSignedUploadUrl,getSignedReadUrl} from '../src/services/upload.service';
const owner='111111111111111111111111';
describe('private media',()=>{
 beforeEach(()=>{vi.clearAllMocks();mocks.upload.mockResolvedValue({data:{signedUrl:'synthetic-upload'},error:null});mocks.read.mockResolvedValue({data:{signedUrl:'synthetic-read'},error:null});});
 it('returns a stable owner-scoped object key, never publicUrl',async()=>{
  const result=await getSignedUploadUrl(owner,'../../patient-name.png','image/png');
  expect(result.path).toMatch(new RegExp('^'+owner+'/[a-f0-9-]{36}\\.png$'));
  expect(result).not.toHaveProperty('publicUrl');expect(result.path).not.toContain('patient-name');
 });
 it('rejects unsupported media before storage',async()=>{await expect(getSignedUploadUrl(owner,'script.html','text/html')).rejects.toThrow();expect(mocks.upload).not.toHaveBeenCalled();});
 it('denies cross-user and traversal access before signing',async()=>{
  await expect(getSignedReadUrl(owner,'222222222222222222222222/11111111-1111-4111-8111-111111111111.png')).rejects.toThrow('denied');
  await expect(getSignedReadUrl(owner,owner+'/../secret.png')).rejects.toThrow('denied');expect(mocks.read).not.toHaveBeenCalled();
 });
 it('signs only valid owner objects for five minutes',async()=>{
  const path=owner+'/11111111-1111-4111-8111-111111111111.png';const result=await getSignedReadUrl(owner,path);expect(result.expiresIn).toBe(300);expect(mocks.read).toHaveBeenCalledWith(path,300);
 });
});
