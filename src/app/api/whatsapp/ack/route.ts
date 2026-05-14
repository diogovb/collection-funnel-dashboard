import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

function isAuthorized(request: NextRequest): boolean {
  const expected = process.env.WHATSAPP_BRIDGE_TOKEN;
  if (!expected) return false;
  const header = request.headers.get("authorization") || "";
  return header === `Bearer ${expected}`;
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { event_id?: string; status?: string; error?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { event_id, status, error: errorMsg } = body;

  if (!event_id || typeof event_id !== "string") {
    return NextResponse.json({ error: "event_id is required" }, { status: 400 });
  }
  if (status !== "sent" && status !== "failed") {
    return NextResponse.json({ error: "status must be 'sent' or 'failed'" }, { status: 400 });
  }

  const update: Record<string, unknown> = {
    status,
    error: status === "failed" ? (errorMsg || null) : null,
  };
  if (status === "sent") {
    update.sent_at = new Date().toISOString();
  }

  const { data, error } = await supabaseAdmin
    .from("whatsapp_outbox")
    .update(update)
    .eq("event_id", event_id)
    .select("id, status, attempts")
    .maybeSingle();

  if (error) {
    console.error("whatsapp/ack error:", error);
    return NextResponse.json({ error: "Internal error", detail: error.message }, { status: 500 });
  }

  if (!data) {
    return NextResponse.json({ error: "event_id not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, id: data.id, status: data.status, attempts: data.attempts });
}
