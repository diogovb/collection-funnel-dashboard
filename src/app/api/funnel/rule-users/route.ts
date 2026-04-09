import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

// GET /api/funnel/rule-users?rule_id=X&type=sent|failed|pendentes
export async function GET(request: NextRequest) {
  const ruleId = request.nextUrl.searchParams.get("rule_id");
  const type = request.nextUrl.searchParams.get("type");

  if (!ruleId || !["sent", "failed", "pendentes"].includes(type ?? "")) {
    return NextResponse.json({ error: "rule_id e type (sent|failed|pendentes) são obrigatórios" }, { status: 400 });
  }

  if (type === "sent" || type === "failed") {
    const { data: actions, error } = await supabaseAdmin
      .from("funnel_actions")
      .select("user_email, channel, created_at, status")
      .eq("rule_id", ruleId)
      .eq("status", type === "sent" ? "sent" : "failed")
      .order("created_at", { ascending: false });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Fetch signup metadata for these emails
    const emails = [...new Set((actions || []).map((a) => a.user_email))];
    const metaMap: Record<string, { name?: string; phone?: string }> = {};

    if (emails.length > 0) {
      const { data: events } = await supabaseAdmin
        .from("funnel_events")
        .select("email, metadata")
        .eq("event", "signup_completed")
        .in("email", emails);

      for (const ev of events || []) {
        if (ev.email && ev.metadata) {
          metaMap[ev.email] = {
            name: ev.metadata.name,
            phone: ev.metadata.phone || ev.metadata.whatsapp,
          };
        }
      }
    }

    return NextResponse.json(
      (actions || []).map((a) => ({
        email: a.user_email,
        channel: a.channel,
        date: a.created_at,
        status: a.status,
        name: metaMap[a.user_email]?.name ?? null,
        phone: metaMap[a.user_email]?.phone ?? null,
      }))
    );
  }

  // type === "pendentes"
  const { data: rule, error: ruleError } = await supabaseAdmin
    .from("funnel_rules")
    .select("*")
    .eq("id", ruleId)
    .single();

  if (ruleError || !rule) return NextResponse.json({ error: "Regra não encontrada" }, { status: 404 });

  const { data: pastActions } = await supabaseAdmin
    .from("funnel_actions")
    .select("user_email")
    .eq("rule_id", ruleId);

  const contacted = new Set((pastActions || []).map((a) => a.user_email));

  const { data: events } = await supabaseAdmin
    .from("funnel_events")
    .select("email, user_id, event, created_at, metadata")
    .gte("created_at", rule.created_at)
    .order("created_at", { ascending: true });

  const uidToEmail = new Map<string, string>();
  for (const ev of events || []) {
    if (ev.user_id && ev.email) uidToEmail.set(ev.user_id, ev.email);
  }

  interface UserInfo {
    email: string;
    stages: Set<string>;
    metadata: Record<string, any> | null;
    stageTimestamps: Record<string, string>;
  }
  const users = new Map<string, UserInfo>();
  for (const ev of events || []) {
    const email = ev.email || (ev.user_id ? uidToEmail.get(ev.user_id) : null);
    if (!email) continue;
    if (!users.has(email)) {
      users.set(email, { email, stages: new Set(), metadata: null, stageTimestamps: {} });
    }
    const u = users.get(email)!;
    u.stages.add(ev.event);
    if (!u.stageTimestamps[ev.event]) u.stageTimestamps[ev.event] = ev.created_at;
    if (ev.metadata && ev.event === "signup_completed" && !u.metadata) {
      u.metadata = ev.metadata;
    }
  }

  const now = Date.now();
  const pending: Array<{ email: string; name: string | null; phone: string | null; date: string }> = [];

  for (const [email, user] of users) {
    if (!user.stages.has(rule.stage)) continue;
    if (contacted.has(email)) continue;

    if (rule.next_stage === "any_action") {
      if (user.stages.has("download") || user.stages.has("render_ia")) continue;
    } else if (rule.next_stage && user.stages.has(rule.next_stage)) {
      continue;
    }

    const stageTime = new Date(user.stageTimestamps[rule.stage]).getTime();
    if ((now - stageTime) / 60000 < rule.delay_minutes) continue;

    const signupTime = user.stageTimestamps["signup_completed"];
    if (signupTime && signupTime < rule.created_at) continue;

    if (rule.filters) {
      const meta = user.metadata || {};
      const { professions, softwares, interests } = rule.filters;
      if (professions?.length) {
        const v = String(meta.profession || "").toLowerCase();
        if (!professions.some((p: string) => v.includes(p.toLowerCase()))) continue;
      }
      if (softwares?.length) {
        const v = String(meta.software || "").toLowerCase();
        if (!softwares.some((s: string) => v.includes(s.toLowerCase()))) continue;
      }
      if (interests?.length) {
        const v = String(meta.what_brought || "").toLowerCase();
        if (!interests.some((i: string) => v.includes(i.toLowerCase()))) continue;
      }
    }

    pending.push({
      email,
      name: user.metadata?.name ?? null,
      phone: user.metadata?.phone || user.metadata?.whatsapp || null,
      date: user.stageTimestamps[rule.stage],
    });
  }

  return NextResponse.json(pending);
}
