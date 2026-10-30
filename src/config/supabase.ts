import { createClient } from '@supabase/supabase-js';
export const MEDIA_BUCKET = process.env.SUPABASE_MEDIA_BUCKET || 'alzhefi-media';
export function getSupabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Media storage is not configured. Do not upload patient photos.');
  }
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
