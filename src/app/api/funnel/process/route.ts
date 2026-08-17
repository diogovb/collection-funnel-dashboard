import { NextResponse } from "next/server";
import { getFunnelAdmin } from "@/lib/supabase-admin";
import { wrapEmailHTML } from "@/lib/email-template";

const RESEND_API_KEY = process.env.RESEND_API_KEY!;
const SMSDEV_API_KEY = process.env.SMSDEV_API_KEY!;
const EMAIL_FROM = "Collection <noreply@pag.collection.com.br>";

interface FunnelEvent {
  id: string;
  user_id: string;
  email: string;
  event: string;
  metadata: Record<string, any> | null;
  created_at: string;
}

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
}

// Replace template variables {{name}}, {{email}}, {{phone}}
function formatFirstName(raw: string): string {
  const first = raw.split(/\s+/)[0].toLowerCase();
  return first.charAt(0).toUpperCase() + first.slice(1);
}

function replaceVars(template: string, metadata: Record<string, any> | null, email: string): string {
  let result = template;
  const rawName = metadata?.name || email.split("@")[0];
  const name = formatFirstName(rawName);
  const phone = metadata?.phone || metadata?.whatsapp || "";
  const profession = metadata?.profession || "";
  const software = metadata?.software || "";
  const interest = metadata?.what_brought || "";
  result = result.replace(/\{\{name\}\}/g, name);
  result = result.replace(/\{\{email\}\}/g, email);
  result = result.replace(/\{\{phone\}\}/g, phone);
  result = result.replace(/\{\{profession\}\}/g, profession);
  result = result.replace(/\{\{software\}\}/g, software);
  result = result.replace(/\{\{interest\}\}/g, interest);
  return result;
}

// Format phone for SMSdev: 55XXXXXXXXXXX
function formatPhone(phone: string): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 11) return "55" + digits;
  if (digits.length === 13 && digits.startsWith("55")) return digits;
  if (digits.length === 10) return "55" + digits; // sem 9
  return null;
}

async function sendEmail(to: string, subject: string, html: string): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({ from: EMAIL_FROM, to, subject, html }),
    });
    if (res.ok) return { success: true };
    const err = await res.text();
    return { success: false, error: err };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

async function sendSMS(phone: string, message: string): Promise<{ success: boolean; error?: string }> {
  const formatted = formatPhone(phone);
  if (!formatted) return { success: false, error: "Telefone inválido: " + phone };

  try {
    const params = new URLSearchParams({
      key: SMSDEV_API_KEY,
      type: "9",
      number: formatted,
      msg: message.substring(0, 160),
    });
    const res = await fetch(`https://api.smsdev.com.br/v1/send?${params}`);
    const data = await res.json();
    if (data.situacao === "OK" || data.id) return { success: true };
    return { success: false, error: JSON.stringify(data) };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

async function enqueueWhatsapp(args: {
  ruleId: string;
  stage: string;
  email: string;
  phone: string;
  metadata: Record<string, any>;
  triggerTimestamp: string | undefined;
}): Promise<{ success: boolean; error?: string }> {
  const formatted = formatPhone(args.phone);
  if (!formatted) return { success: false, error: "Telefone inválido: " + args.phone };

  const context = {
    name: args.metadata.name || args.email.split("@")[0],
    email: args.email,
    profession: args.metadata.profession || null,
    software: args.metadata.software || null,
    what_brought: args.metadata.what_brought || null,
    trigger: args.stage,
    triggered_at: args.triggerTimestamp || null,
  };

  const eventId = `${args.ruleId}::${args.email}`;

  const { error } = await getFunnelAdmin().from("whatsapp_outbox").insert({
    event_id: eventId,
    rule_id: args.ruleId,
    email: args.email,
    phone: formatted,
    context,
  });

  if (error) {
    // 23505 = unique_violation → job já existe, tratamos como idempotente
    if ((error as any).code === "23505") return { success: true };
    return { success: false, error: error.message };
  }
  return { success: true };
}

function isAuthorized(request: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  // If no CRON_SECRET configured, allow all calls
  if (!cronSecret) return true;
  // If CRON_SECRET is set, require matching Bearer token
  return authHeader === `Bearer ${cronSecret}`;
}

const MAX_BATCH_SIZE = 50;
const EVENTS_LOOKBACK_DAYS = 30;

// Fetches all rows from a Supabase query, paginating in 1000-row pages to
// bypass the implicit row limit. `buildQuery` must return a fresh query
// builder each call (Supabase builders are mutable and consumed by .range).
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

async function processQueue(): Promise<NextResponse> {
  try {
    // 1. Get all active rules (including created_at as the cutoff for eligible users)
    const { data: rules, error: rulesError } = await fetchAll<FunnelRule>(() =>
      getFunnelAdmin()
        .from("funnel_rules")
        .select("*")
        .eq("active", true)
        .order("priority", { ascending: false })
    );

    if (rulesError) return NextResponse.json({ error: rulesError.message }, { status: 500 });
    if (!rules || rules.length === 0) {
      return NextResponse.json({ message: "Nenhuma regra ativa", processed: 0 });
    }

    // 2. Get funnel events — paginated to bypass Supabase's 1000-row default cap.
    // Window: last EVENTS_LOOKBACK_DAYS, but never earlier than the oldest active
    // rule (no point loading events that predate every rule).
    const earliestRuleDate = rules.reduce(
      (min, r) => (r.created_at < min ? r.created_at : min),
      rules[0].created_at
    );
    const lookbackDate = new Date(Date.now() - EVENTS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const eventsCutoff = lookbackDate > earliestRuleDate ? lookbackDate : earliestRuleDate;
    const { data: events, error: eventsError } = await fetchAll<FunnelEvent>(() =>
      getFunnelAdmin()
        .from("funnel_events")
        .select("*")
        .gte("created_at", eventsCutoff)
        .in("event", ["signup_completed", "download", "render_ia"])
        .order("created_at", { ascending: true })
    );

    if (eventsError) return NextResponse.json({ error: eventsError.message }, { status: 500 });

    // 3. Get all past actions to avoid duplicates (paginated)
    const { data: pastActions } = await fetchAll<{ rule_id: string; user_email: string }>(() =>
      getFunnelAdmin().from("funnel_actions").select("rule_id, user_email")
    );

    const actionSet = new Set(
      (pastActions || []).map((a) => `${a.rule_id}::${a.user_email}`)
    );

    // 4. Build user map: email → { stages, metadata, stageTimestamps }
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
        users.set(email, {
          email,
          stages: new Set(),
          metadata: null,
          stageTimestamps: {},
        });
      }
      const u = users.get(email)!;
      u.stages.add(ev.event);
      u.stageTimestamps[ev.event] = ev.created_at;
      if (ev.metadata && ev.event === "signup_completed") {
        u.metadata = ev.metadata;
      }
    }

    // 5. Process each rule
    const now = Date.now();
    const results: Array<{ rule_id: string; user: string; channel: string; status: string; error?: string }> = [];
    let batchCount = 0;
    let skipped = 0;

    for (const rule of rules as FunnelRule[]) {
      // Find users at rule.stage who haven't reached rule.next_stage
      for (const [email, user] of users) {
        // Must have the trigger stage
        if (!user.stages.has(rule.stage)) continue;

        // Only process trigger events that happened AFTER this rule was
        // created. Filtering by the trigger stage (not by signup) is what
        // makes "first download" rules ignore the historical backlog.
        const triggerTime = user.stageTimestamps[rule.stage];
        if (triggerTime && triggerTime < rule.created_at) continue;

        // Must NOT have the next stage (if specified)
        // "any_action" is a virtual stage: user must have neither download nor render_ia
        if (rule.next_stage === "any_action") {
          if (user.stages.has("download") || user.stages.has("render_ia")) continue;
        } else if (rule.next_stage && user.stages.has(rule.next_stage)) {
          continue;
        }

        // WhatsApp requires signup_completed metadata (name, profession, software,
        // what_brought) AND a phone number — without those, the SDR agent has no
        // context to compose a meaningful message. Skip silently (don't pollute
        // the dashboard with "failures" that are really just missing data).
        if (rule.channel === "whatsapp") {
          if (!user.stages.has("signup_completed")) continue;
          const meta = user.metadata || {};
          if (!meta.phone && !meta.whatsapp) continue;
        }

        // Check delay
        const stageTime = new Date(user.stageTimestamps[rule.stage]).getTime();
        const elapsed = (now - stageTime) / 60000; // minutes
        if (elapsed < rule.delay_minutes) continue;

        // Check if already sent
        const key = `${rule.id}::${email}`;
        if (actionSet.has(key)) continue;

        // Enforce batch size limit
        if (batchCount >= MAX_BATCH_SIZE) {
          skipped++;
          continue;
        }

        // Apply audience filters
        if (rule.filters) {
          const meta = user.metadata || {};
          const { professions, softwares, interests } = rule.filters;
          if (professions?.length) {
            const v = String(meta.profession || "").toLowerCase();
            if (!professions.some(p => v.includes(p.toLowerCase()))) continue;
          }
          if (softwares?.length) {
            const v = String(meta.software || "").toLowerCase();
            if (!softwares.some(s => v.includes(s.toLowerCase()))) continue;
          }
          if (interests?.length) {
            const v = String(meta.what_brought || "").toLowerCase();
            if (!interests.some(i => v.includes(i.toLowerCase()))) continue;
          }
        }

        // Prepare content
        const emailContent = replaceVars(rule.content, user.metadata, email);
        // Use dedicated sms_content when channel is "both", fallback to content (for "sms" channel)
        const rawSmsContent = (rule.channel === "both" && rule.sms_content) ? rule.sms_content : rule.content;
        const smsContentResolved = replaceVars(rawSmsContent, user.metadata, email);
        const subject = rule.subject ? replaceVars(rule.subject, user.metadata, email) : undefined;
        const phone = user.metadata?.phone || user.metadata?.whatsapp || "";

        // Send based on channel
        const channels = rule.channel === "both" ? ["email", "sms"] : [rule.channel];

        for (const ch of channels) {
          let result: { success: boolean; error?: string };
          let actionMetadata: Record<string, unknown>;

          if (ch === "email") {
            result = await sendEmail(email, subject || "Collection", wrapEmailHTML(emailContent));
            actionMetadata = { subject, content_preview: emailContent.substring(0, 100) };
          } else if (ch === "sms") {
            const smsText = smsContentResolved.replace(/<[^>]*>/g, "").substring(0, 160);
            result = await sendSMS(phone, smsText);
            actionMetadata = { content_preview: smsContentResolved.substring(0, 100) };
          } else if (ch === "whatsapp") {
            if (!phone) {
              result = { success: false, error: "Telefone ausente nos metadados" };
            } else {
              result = await enqueueWhatsapp({
                ruleId: rule.id,
                stage: rule.stage,
                email,
                phone,
                metadata: user.metadata || {},
                triggerTimestamp: user.stageTimestamps[rule.stage],
              });
            }
            actionMetadata = { enqueued: true, trigger: rule.stage };
          } else {
            result = { success: false, error: `Canal desconhecido: ${ch}` };
            actionMetadata = {};
          }

          // For whatsapp the message is not yet delivered — bridge will ack later.
          // We log "queued" so funnel_actions still dedupes future runs.
          const status = !result.success
            ? "failed"
            : ch === "whatsapp"
              ? "queued"
              : "sent";

          await getFunnelAdmin().from("funnel_actions").insert({
            rule_id: rule.id,
            user_email: email,
            user_id: null,
            channel: ch,
            status,
            error: result.error || null,
            metadata: actionMetadata,
          });

          batchCount++;
          results.push({
            rule_id: rule.id,
            user: email,
            channel: ch,
            status,
            error: result.error,
          });

          // Mark as sent to avoid duplicate within same run
          actionSet.add(key);
        }
      }
    }

    const sentCount = results.filter((r) => r.status === "sent").length;
    const failedCount = results.filter((r) => r.status === "failed").length;
    return NextResponse.json({
      message: `Processado: ${sentCount} enviados, ${failedCount} falharam, ${skipped} ignorados (batch limit)`,
      processed: results.length,
      sent: sentCount,
      failed: failedCount,
      skipped,
      batch_limit_reached: skipped > 0,
      batch_limit: MAX_BATCH_SIZE,
      details: results,
    });
  } catch (error: any) {
    console.error("Erro ao processar funil:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return processQueue();
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return processQueue();
}
