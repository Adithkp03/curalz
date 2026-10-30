import { randomUUID } from 'node:crypto';
import { getSupabase, MEDIA_BUCKET } from '../config/supabase';
export type MediaType = 'image' | 'video';
const MIME_EXT: Record<string,string> = {'image/jpeg':'jpg','image/png':'png','image/webp':'webp','video/mp4':'mp4'};
export const inferMediaType = (mime: string): MediaType => mime.startsWith('video/') ? 'video' : 'image';
export async function getSignedUploadUrl(userId: string, _fileName: string, mimeType: string) {
  const ext = MIME_EXT[mimeType];
  if (!ext) throw new Error('Unsupported media type');
  const path = `${userId}/${randomUUID()}.${ext}`;
  const {data,error} = await getSupabase().storage.from(MEDIA_BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw new Error('Failed to sign upload');
  return {signedUrl:data.signedUrl,path};
}
export async function getSignedReadUrl(userId: string, path: string) {
  // Object identifiers, not arbitrary URLs. A caregiver reads their own uploads;
  // sharing to a patient needs a verified invitation/ownership transfer first.
  if (!path.startsWith(`${userId}/`) || path.includes('..') || !/^[a-f0-9]{24}\/[a-f0-9-]{36}\.(jpg|png|webp|mp4)$/.test(path)) throw new Error('Media access denied');
  const {data,error} = await getSupabase().storage.from(MEDIA_BUCKET).createSignedUrl(path,300);
  if(error || !data) throw new Error('Media not found');
  return {signedUrl:data.signedUrl,expiresIn:300,path};
}
