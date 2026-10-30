import { createClient } from "@supabase/supabase-js";

export const MEDIA_BUCKET = process.env.SUPABASE_MEDIA_BUCKET || "alzhefi-media";

export const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY!,
);
