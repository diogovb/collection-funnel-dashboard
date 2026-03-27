import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://cnpfyybiqoptkciXgpik.supabase.co";
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNucGZ5eWJpcW9wdGtjaXhncGlrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIzMDc3MzEsImV4cCI6MjA4Nzg4MzczMX0.GoE7EMy0tTciCFJAuG-wFaA6wvk5Qzde3AOnY3Vzyno";

export const supabase = createClient(supabaseUrl, supabaseKey);
