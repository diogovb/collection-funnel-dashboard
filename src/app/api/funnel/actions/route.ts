import { NextRequest, NextResponse } from "next/server";
import { getFunnelAdmin } from "@/lib/supabase-admin";

// Paginated fetch — walks pages of 1000 to bypass PostgREST's default cap.
async function fetchAll<T>(
  buildQuery: () => any,
  pageSize = 1000
): Promise<{ data: T[]; error: any }> {
  const all: T[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1);
    if (error) return { data: all, error };
    if (!data || data.length === 0) break;
    all.push(...(data as T[]));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return { data: all, error: null };
}

// GET - List actions for a user OR detail list for a rule
export async function GET(request: NextRequest) {
  const email = request.nextUrl.searchParams.get("email");
  const ruleId = request.nextUrl.searchParams.get("rule_id");
  const type = request.nextUrl.searchParams.get("type"); // enviadas | falhas | pendentes

  // Existing behavior: per-user
  if (email) {
    const { data, error } = await getFunnelAdmin()
      .from("funnel_actions")
      .select("*, funnel_rules(stage, next_stage, channel, subject)")
      .eq("user_email", email)
      .order("created_at", { ascending: false });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data);
  }

  if (!ruleId) {
    return NextResponse.json({ error: "email ou rule_id é obrigatório" }, { status: 400 });
  }

  // ── Pendentes: compute eligible users not yet contacted ──────────────────
  if (type === "pendentes") {
    const { data: rule, error: ruleError } = await getFunnelAdmin()
      .from("funnel_rules")
      .select("*")
      .eq("id", ruleId)
      .single();

    if (ruleError || !rule) return NextResponse.json({ error: "Regra não encontrada" }, { status: 404 });

    const [{ data: events }, { data: pastActions }] = await Promise.all([
      fetchAll<{ email: string | null; user_id: string | null; event: string; created_at: string; metadata: Record<string, any> | null }>(() =>
        getFunnelAdmin()
          .from("funnel_events")
          .select("email, user_id, event, created_at, metadata")
          .gte("created_at", rule.created_at)
          .in("event", ["signup_completed", "download", "render_ia"])
          .order("created_at", { ascending: true })
      ),
      fetchAll<{ user_email: string; status: string }>(() =>
        getFunnelAdmin()
          .from("funnel_actions")
          .select("user_email, status")
          .eq("rule_id", ruleId)
      ),
    ]);

    // Exclude only actions that already resolved (sent/failed). Queued actions
    // remain "pendentes" — they're enqueued but not yet delivered, so they
    // should still appear in the list to give users visibility into the queue.
    const contacted = new Set(
      (pastActions || [])
        .filter((a) => a.status !== "queued")
        .map((a) => a.user_email)
    );

    const uidToEmail = new Map<string, string>();
    for (const ev of events || []) {
      if (ev.user_id && ev.email) uidToEmail.set(ev.user_id, ev.email);
    }

    interface UserInfo {
      email: string;
      stages: Set<string>;
      stageTimestamps: Record<string, string>;
      metadata: Record<string, any> | null;
    }
    const users = new Map<string, UserInfo>();
    for (const ev of events || []) {
      const userEmail = ev.email || (ev.user_id ? uidToEmail.get(ev.user_id) : null);
      if (!userEmail) continue;
      if (!users.has(userEmail)) {
        users.set(userEmail, { email: userEmail, stages: new Set(), stageTimestamps: {}, metadata: null });
      }
      const u = users.get(userEmail)!;
      u.stages.add(ev.event);
      if (!u.stageTimestamps[ev.event]) u.stageTimestamps[ev.event] = ev.created_at;
      if (ev.metadata && ev.event === "signup_completed" && !u.metadata) {
        u.metadata = ev.metadata;
      }
    }

    const now = Date.now();
    const eligible: Array<{ email: string; name: string; phone: string }> = [];

    for (const [userEmail, user] of users) {
      if (!user.stages.has(rule.stage)) continue;
      // Filter by the trigger event timestamp (not signup) so "first download"
      // rules ignore the historical backlog.
      const triggerTime = user.stageTimestamps[rule.stage];
      if (triggerTime && triggerTime < rule.created_at) continue;
      if (rule.next_stage === "any_action") {
        if (user.stages.has("download") || user.stages.has("render_ia")) continue;
      } else if (rule.next_stage && user.stages.has(rule.next_stage)) {
        continue;
      }
      // Mirror funnel/process: whatsapp requires signup_completed metadata + a phone.
      if (rule.channel === "whatsapp") {
        if (!user.stages.has("signup_completed")) continue;
        const m = user.metadata || {};
        if (!m.phone && !m.whatsapp) continue;
      }
      const stageTime = new Date(user.stageTimestamps[rule.stage]).getTime();
      if ((now - stageTime) / 60000 < rule.delay_minutes) continue;
      if (contacted.has(userEmail)) continue;
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
      const meta = user.metadata || {};
      eligible.push({
        email: userEmail,
        name: meta.name || userEmail.split("@")[0],
        phone: meta.phone || meta.whatsapp || "",
      });
    }

    return NextResponse.json(eligible);
  }

  // ── Enviadas / Falhas ────────────────────────────────────────────────────
  const status = type === "falhas" ? "failed" : "sent";
  const { data: actions, error } = await getFunnelAdmin()
    .from("funnel_actions")
    .select("user_email, channel, status, error, created_at")
    .eq("rule_id", ruleId)
    .eq("status", status)
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const emails = [...new Set((actions || []).map((a) => a.user_email))];
  const metaMap: Record<string, { name: string; phone: string }> = {};

  if (emails.length > 0) {
    const { data: events } = await getFunnelAdmin()
      .from("funnel_events")
      .select("email, metadata")
      .eq("event", "signup_completed")
      .in("email", emails);

    for (const ev of events || []) {
      if (!metaMap[ev.email] && ev.metadata) {
        metaMap[ev.email] = {
          name: ev.metadata.name || ev.email.split("@")[0],
          phone: ev.metadata.phone || ev.metadata.whatsapp || "",
        };
      }
    }
  }

  // Deduplicate by email: merge channels, use latest date
  const byEmail: Record<string, { email: string; name: string; phone: string; channels: Set<string>; date: string; error: string | null }> = {};
  for (const a of actions || []) {
    if (!byEmail[a.user_email]) {
      byEmail[a.user_email] = {
        email: a.user_email,
        name: metaMap[a.user_email]?.name || a.user_email.split("@")[0],
        phone: metaMap[a.user_email]?.phone || "",
        channels: new Set(),
        date: a.created_at,
        error: a.error,
      };
    }
    byEmail[a.user_email].channels.add(a.channel ?? "email");
    if (a.created_at > byEmail[a.user_email].date) byEmail[a.user_email].date = a.created_at;
  }

  const result = Object.values(byEmail).map((u) => ({
    email: u.email,
    name: u.name,
    phone: u.phone,
    channels: [...u.channels],
    date: u.date,
    error: u.error,
  }));

  return NextResponse.json(result);
}
