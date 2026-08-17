import { NextRequest, NextResponse } from "next/server";
import { getFunnelAdmin } from "@/lib/supabase-admin";

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

  const { data, error } = await getFunnelAdmin()
    .from("whatsapp_outbox")
    .update(update)
    .eq("event_id", event_id)
    .select("id, rule_id, email, status, attempts")
    .maybeSingle();

  if (error) {
    console.error("whatsapp/ack error:", error);
    return NextResponse.json({ error: "Internal error", detail: error.message }, { status: 500 });
  }

  if (!data) {
    return NextResponse.json({ error: "event_id not found" }, { status: 404 });
  }

  // Mirror status into funnel_actions so the dashboard counters reflect
  // delivery (sent/failed) instead of staying as "queued" forever.
  // Best effort: failure here doesn't fail the ack.
  if (data.rule_id) {
    const { error: actionErr } = await getFunnelAdmin()
      .from("funnel_actions")
      .update({
        status,
        error: status === "failed" ? (errorMsg || null) : null,
      })
      .eq("rule_id", data.rule_id)
      .eq("user_email", data.email)
      .eq("channel", "whatsapp");
    if (actionErr) console.error("whatsapp/ack funnel_actions mirror error:", actionErr);
  }

  // On successful delivery, advance the user's CRM stage to "contato_iniciado"
  // — but only if they're still in "novo". Anyone already further along
  // (em_conversa, ativado, etc.) was moved manually by the operator and we
  // don't want to roll them back. Best effort.
  if (status === "sent") {
    const { data: signupEvent, error: lookupErr } = await getFunnelAdmin()
      .from("funnel_events")
      .select("id, metadata")
      .eq("email", data.email)
      .eq("event", "signup_completed")
      .limit(1)
      .maybeSingle();
    if (lookupErr) {
      console.error("whatsapp/ack crm lookup error:", lookupErr);
    } else if (signupEvent) {
      const meta = (signupEvent.metadata || {}) as Record<string, unknown>;
      const currentStage = (meta.crm_stage as string | undefined) ?? "novo";
      if (currentStage === "novo") {
        const { error: crmErr } = await getFunnelAdmin()
          .from("funnel_events")
          .update({ metadata: { ...meta, crm_stage: "contato_iniciado" } })
          .eq("id", signupEvent.id);
        if (crmErr) console.error("whatsapp/ack crm update error:", crmErr);
      }
    }
  }

  return NextResponse.json({ ok: true, id: data.id, status: data.status, attempts: data.attempts });
}
