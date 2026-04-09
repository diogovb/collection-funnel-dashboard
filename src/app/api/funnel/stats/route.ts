import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export async function GET() {
  try {
    // 1. Fetch all actions
    const { data: actions, error: actionsError } = await supabaseAdmin
      .from("funnel_actions")
      .select("rule_id, status, created_at, user_email")
      .order("created_at", { ascending: false });

    if (actionsError) return NextResponse.json({ error: actionsError.message }, { status: 500 });

    // 2. Fetch active rules (to compute pendentes)
    const { data: rules, error: rulesError } = await supabaseAdmin
      .from("funnel_rules")
      .select("id, stage, next_stage, delay_minutes, active, filters, created_at");

    if (rulesError) return NextResponse.json({ error: rulesError.message }, { status: 500 });

    // 3. Aggregate per rule
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const byRule: Record<string, {
      sent: number;
      failed: number;
      today: number;
      lastSent: string | null;
      contacted: Set<string>;
    }> = {};

    let totalSent = 0;
    let totalFailed = 0;
    let totalToday = 0;

    for (const a of actions || []) {
      if (!byRule[a.rule_id]) {
        byRule[a.rule_id] = { sent: 0, failed: 0, today: 0, lastSent: null, contacted: new Set() };
      }
      const r = byRule[a.rule_id];
      if (a.status === "sent") {
        r.sent++;
        totalSent++;
        if (!r.lastSent) r.lastSent = a.created_at; // already sorted desc
        if (new Date(a.created_at) >= todayStart) {
          r.today++;
          totalToday++;
        }
      } else {
        r.failed++;
        totalFailed++;
      }
      r.contacted.add(a.user_email);
    }

    // 4. Compute pendentes per rule
    // Filter server-side: only events after the earliest active rule's created_at
    const activeRules = (rules || []).filter((r) => r.active);
    const earliestRuleDate = activeRules.length > 0
      ? activeRules.reduce((min, r) => (r.created_at < min ? r.created_at : min), activeRules[0].created_at)
      : new Date().toISOString();
    const { data: events } = await supabaseAdmin
      .from("funnel_events")
      .select("email, user_id, event, created_at, metadata")
      .gte("created_at", earliestRuleDate)
      .in("event", ["signup_completed", "download", "render_ia"])
      .order("created_at", { ascending: true });

    // Build user stage map
    const uidToEmail = new Map<string, string>();
    for (const ev of events || []) {
      if (ev.user_id && ev.email) uidToEmail.set(ev.user_id, ev.email);
    }

    interface UserInfo {
      stages: Set<string>;
      stageTimestamps: Record<string, string>;
      metadata: Record<string, any> | null;
    }
    const users = new Map<string, UserInfo>();
    for (const ev of events || []) {
      const email = ev.email || (ev.user_id ? uidToEmail.get(ev.user_id) : null);
      if (!email) continue;
      if (!users.has(email)) {
        users.set(email, { stages: new Set(), stageTimestamps: {}, metadata: null });
      }
      const u = users.get(email)!;
      u.stages.add(ev.event);
      if (!u.stageTimestamps[ev.event]) u.stageTimestamps[ev.event] = ev.created_at;
      if (ev.metadata && ev.event === "signup_completed" && !u.metadata) {
        u.metadata = ev.metadata;
      }
    }

    const now = Date.now();
    const pendentesPerRule: Record<string, number> = {};

    for (const rule of rules || []) {
      if (!rule.active) {
        pendentesPerRule[rule.id] = 0;
        continue;
      }
      const contacted = byRule[rule.id]?.contacted ?? new Set<string>();
      let count = 0;

      for (const [email, user] of users) {
        if (!user.stages.has(rule.stage)) continue;
        // Only count users who signed up AFTER this rule was created
        const signupTime = user.stageTimestamps["signup_completed"];
        if (signupTime && signupTime < rule.created_at) continue;
        // For any_action: must have neither download nor render_ia
        if (rule.next_stage === "any_action") {
          if (user.stages.has("download") || user.stages.has("render_ia")) continue;
        } else if (rule.next_stage && user.stages.has(rule.next_stage)) {
          continue;
        }
        // Check delay
        const stageTime = new Date(user.stageTimestamps[rule.stage]).getTime();
        const elapsed = (now - stageTime) / 60000;
        if (elapsed < rule.delay_minutes) continue;
        // Not yet contacted
        if (contacted.has(email)) continue;
        // Apply audience filters
        const ruleFilters = rule.filters as { professions?: string[]; softwares?: string[]; interests?: string[] } | null;
        if (ruleFilters) {
          const meta = user.metadata || {};
          if (ruleFilters.professions?.length) {
            const v = String(meta.profession || "").toLowerCase();
            if (!ruleFilters.professions.some((p: string) => v.includes(p.toLowerCase()))) continue;
          }
          if (ruleFilters.softwares?.length) {
            const v = String(meta.software || "").toLowerCase();
            if (!ruleFilters.softwares.some((s: string) => v.includes(s.toLowerCase()))) continue;
          }
          if (ruleFilters.interests?.length) {
            const v = String(meta.what_brought || "").toLowerCase();
            if (!ruleFilters.interests.some((i: string) => v.includes(i.toLowerCase()))) continue;
          }
        }
        count++;
      }
      pendentesPerRule[rule.id] = count;
    }

    // Serialize (remove Sets for JSON)
    const byRuleSerialized: Record<string, {
      sent: number; failed: number; today: number; lastSent: string | null; pendentes: number;
    }> = {};
    for (const [ruleId, stats] of Object.entries(byRule)) {
      byRuleSerialized[ruleId] = {
        sent: stats.sent,
        failed: stats.failed,
        today: stats.today,
        lastSent: stats.lastSent,
        pendentes: pendentesPerRule[ruleId] ?? 0,
      };
    }
    // Add rules with no actions yet
    for (const rule of rules || []) {
      if (!byRuleSerialized[rule.id]) {
        byRuleSerialized[rule.id] = {
          sent: 0, failed: 0, today: 0, lastSent: null,
          pendentes: pendentesPerRule[rule.id] ?? 0,
        };
      }
    }

    return NextResponse.json({
      byRule: byRuleSerialized,
      totals: {
        sent: totalSent,
        failed: totalFailed,
        today: totalToday,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
