import { createClient } from "@supabase/supabase-js";

// Server-side only. A service_role bypassa RLS — NUNCA hardcodar nem expor ao client.
const supabaseUrl =
  process.env.FUNNEL_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.FUNNEL_SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error(
    "FUNNEL_SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL e FUNNEL_SUPABASE_SERVICE_ROLE_KEY precisam estar configuradas"
  );
}

export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});
