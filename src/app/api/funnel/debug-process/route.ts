import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { isAuthorized } from "@/lib/api-secret";

interface AudienceFilters {
  professions?: string[];
  softwares?: string[];
  interests?: string[];
}

interface FunnelRule {
  id: string;
  stage: string;
  next_stage: string | null;
  delay_minutes: number;
  channel: string;
  subject: string | null;
  content: string;
  sms_content: string | null;
  content_type: string;
  dynamic_action: string | null;
  filters: AudienceFilters | null;
  active: boolean;
  created_at: string;
  priority?: number;
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const report: Record<string, any> = {
    timestamp: new Date().toISOString(),
    env: {
      RESEND_API_KEY: !!process.env.RESEND_API_KEY ? `set (${process.env.RESEND_API_KEY.substring(0, 8)}...)` : "MISSING",
      SMSDEV_API_KEY: !!process.env.SMSDEV_API_KEY ? "set" : "MISSING",
      CRON_SECRET: !!process.env.CRON_SECRET ? "set" : "not set",
    },
  };

  // ── 1. Fetch active rules ──────────────────────────────────
  const { data: rules, error: rulesError } = await supabaseAdmin
    .from("funnel_rules")
    .select("*")
    .eq("active", true)
    .order("priority", { ascending: false });

  if (rulesError) {
    report.rules_error = rulesError.message;
    // Try without ordering by priority in case the column is missing
    const { data: rulesNoOrder, error: rulesNoOrderError } = await supabaseAdmin
      .from("funnel_rules")
      .select("*")
      .eq("active", true);
    report.rules_without_priority_order = rulesNoOrder?.length ?? 0;
    report.rules_without_priority_error = rulesNoOrderError?.message ?? null;
  }

  report.active_rules_count = rules?.length ?? 0;
  report.rules = (rules || []).map((r) => ({
    id: r.id,
    stage: r.stage,
    next_stage: r.next_stage,
    delay_minutes: r.delay_minutes,
    channel: r.channel,
    active: r.active,
    created_at: r.created_at,
    has_filters: !!r.filters && Object.values(r.filters || {}).some((v: any) => v?.length > 0),
    filters: r.filters,
    subject: r.subject,
    priority: r.priority ?? "(no column)",
  }));

  if (!rules || rules.length === 0) {
    report.verdict = "STOPPED: No active rules found";
    return NextResponse.json(report);
  }

  // ── 2. Fetch funnel_events (check row count) ───────────────
  // Find earliest rule created_at to use as server-side filter
  const earliestRuleDate = (rules as FunnelRule[]).reduce(
    (min, r) => (r.created_at < min ? r.created_at : min),
    (rules as FunnelRule[])[0].created_at
  );
  report.earliest_rule_created_at = earliestRuleDate;

  // Total count across all event types (for reference)
  const { count: totalEventsCount } = await supabaseAdmin
    .from("funnel_events")
    .select("*", { count: "exact", head: true });

  // Count after date filter (to show how many we'd miss without the filter)
  const { count: filteredEventsCount } = await supabaseAdmin
    .from("funnel_events")
    .select("*", { count: "exact", head: true })
    .gte("created_at", earliestRuleDate)
    .in("event", ["signup_completed", "download", "render_ia"]);

  report.total_events_in_table = totalEventsCount;
  report.relevant_events_after_filter = filteredEventsCount;

  const { data: events, error: eventsError } = await supabaseAdmin
    .from("funnel_events")
    .select("*")
    .gte("created_at", earliestRuleDate)
    .in("event", ["signup_completed", "download", "render_ia"])
    .order("created_at", { ascending: true });

  if (eventsError) {
    report.events_error = eventsError.message;
    return NextResponse.json(report);
  }

  report.events_fetched = events?.length ?? 0;
  report.supabase_row_limit_hit = (events?.length ?? 0) < (filteredEventsCount ?? 0);

  // Count by event type
  const eventTypeCounts: Record<string, number> = {};
  for (const ev of events || []) {
    eventTypeCounts[ev.event] = (eventTypeCounts[ev.event] ?? 0) + 1;
  }
  report.events_by_type = eventTypeCounts;

  // ── 3. Fetch past actions ─────────────────────────────────
  const { data: pastActions, error: actionsError } = await supabaseAdmin
    .from("funnel_actions")
    .select("rule_id, user_email");

  report.past_actions_count = pastActions?.length ?? 0;
  if (actionsError) report.past_actions_error = actionsError.message;

  const actionSet = new Set(
    (pastActions || []).map((a) => `${a.rule_id}::${a.user_email}`)
  );

  // ── 4. Build user map ─────────────────────────────────────
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
  let eventsWithNoEmail = 0;

  for (const ev of events || []) {
    const email = ev.email || (ev.user_id ? uidToEmail.get(ev.user_id) : null);
    if (!email) { eventsWithNoEmail++; continue; }

    if (!users.has(email)) {
      users.set(email, { email, stages: new Set(), metadata: null, stageTimestamps: {} });
    }
    const u = users.get(email)!;
    u.stages.add(ev.event);
    u.stageTimestamps[ev.event] = ev.created_at;
    if (ev.metadata && ev.event === "signup_completed") {
      u.metadata = ev.metadata;
    }
  }

  report.events_with_no_email = eventsWithNoEmail;
  report.total_unique_users = users.size;

  // Sample of raw event data (first 3 events) to check schema
  report.raw_event_sample = (events || []).slice(0, 3).map((ev) => ({
    id: ev.id,
    event: ev.event,
    email: ev.email ?? "(null)",
    user_id: ev.user_id ?? "(null)",
    created_at: ev.created_at,
    has_metadata: !!ev.metadata,
    metadata_keys: ev.metadata ? Object.keys(ev.metadata) : [],
  }));

  // ── 5. Per-rule analysis ──────────────────────────────────
  const now = Date.now();
  const ruleReports = [];

  for (const rule of rules as FunnelRule[]) {
    const skippedReasons: Record<string, number> = {
      no_trigger_stage: 0,
      signup_before_rule_created: 0,
      already_at_next_stage: 0,
      delay_not_reached: 0,
      already_contacted: 0,
      filter_profession: 0,
      filter_software: 0,
      filter_interest: 0,
    };
    const eligibleUsers: Array<{
      email: string;
      signup_date: string | null;
      rule_created_at: string;
      stage_time: string;
      elapsed_minutes: number;
      delay_required: number;
      metadata_profession: string | null;
      metadata_software: string | null;
      metadata_interest: string | null;
    }> = [];

    for (const [email, user] of users) {
      // Check trigger stage
      if (!user.stages.has(rule.stage)) {
        skippedReasons.no_trigger_stage++;
        continue;
      }

      // Check signup cutoff
      const signupTime = user.stageTimestamps["signup_completed"];
      if (signupTime && signupTime < rule.created_at) {
        skippedReasons.signup_before_rule_created++;
        continue;
      }

      // Check next stage
      if (rule.next_stage === "any_action") {
        if (user.stages.has("download") || user.stages.has("render_ia")) {
          skippedReasons.already_at_next_stage++;
          continue;
        }
      } else if (rule.next_stage && user.stages.has(rule.next_stage)) {
        skippedReasons.already_at_next_stage++;
        continue;
      }

      // Check delay
      const stageTime = new Date(user.stageTimestamps[rule.stage]).getTime();
      const elapsed = (now - stageTime) / 60000;
      if (elapsed < rule.delay_minutes) {
        skippedReasons.delay_not_reached++;
        continue;
      }

      // Check already contacted
      const key = `${rule.id}::${email}`;
      if (actionSet.has(key)) {
        skippedReasons.already_contacted++;
        continue;
      }

      // Check filters
      if (rule.filters) {
        const meta = user.metadata || {};
        const { professions, softwares, interests } = rule.filters;
        if (professions?.length) {
          const v = String(meta.profession || "").toLowerCase();
          if (!professions.some((p) => v.includes(p.toLowerCase()))) {
            skippedReasons.filter_profession++;
            continue;
          }
        }
        if (softwares?.length) {
          const v = String(meta.software || "").toLowerCase();
          if (!softwares.some((s) => v.includes(s.toLowerCase()))) {
            skippedReasons.filter_software++;
            continue;
          }
        }
        if (interests?.length) {
          const v = String(meta.what_brought || "").toLowerCase();
          if (!interests.some((i) => v.includes(i.toLowerCase()))) {
            skippedReasons.filter_interest++;
            continue;
          }
        }
      }

      // This user IS eligible
      eligibleUsers.push({
        email,
        signup_date: signupTime ?? null,
        rule_created_at: rule.created_at,
        stage_time: user.stageTimestamps[rule.stage],
        elapsed_minutes: Math.round(elapsed),
        delay_required: rule.delay_minutes,
        metadata_profession: user.metadata?.profession ?? null,
        metadata_software: user.metadata?.software ?? null,
        metadata_interest: user.metadata?.what_brought ?? null,
      });
    }

    ruleReports.push({
      rule_id: rule.id,
      stage: rule.stage,
      next_stage: rule.next_stage,
      delay_minutes: rule.delay_minutes,
      channel: rule.channel,
      rule_created_at: rule.created_at,
      filters: rule.filters,
      skipped_reasons: skippedReasons,
      total_skipped: Object.values(skippedReasons).reduce((a, b) => a + b, 0),
      eligible_count: eligibleUsers.length,
      eligible_users: eligibleUsers.slice(0, 20), // cap at 20 for readability
    });
  }

  report.per_rule = ruleReports;
  report.verdict =
    ruleReports.every((r) => r.eligible_count === 0)
      ? "NO eligible users found across all rules — check skipped_reasons for the cause"
      : `${ruleReports.reduce((a, r) => a + r.eligible_count, 0)} eligible user(s) found — process route should be sending`;

  return NextResponse.json(report, { status: 200 });
}
