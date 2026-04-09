import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  if (searchParams.get("secret") !== "collection2024") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Count before deleting (Supabase delete doesn't return count directly)
  const { count, error: countError } = await supabaseAdmin
    .from("funnel_actions")
    .select("*", { count: "exact", head: true });

  if (countError) return NextResponse.json({ error: countError.message }, { status: 500 });

  const { error } = await supabaseAdmin
    .from("funnel_actions")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000"); // matches all rows

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ deleted: count ?? 0 });
}
