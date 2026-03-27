import { createClient } from "@supabase/supabase-js";

const supabaseUrl = "https://cnpfyybiqoptkciXgpik.supabase.co";
// Server-side service role key - never expose to client
const supabaseServiceKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNucGZ5eWJpcW9wdGtjaXhncGlrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjMwNzczMSwiZXhwIjoyMDg3ODgzNzMxfQ.XMeCTYUreazLtkOZUGqA7rLGq4_AmfdX0rhhV0Jea8M";

export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});