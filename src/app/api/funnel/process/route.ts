import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

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

interface FunnelRule {
  id: string;
  stage: string;
  next_stage: string | null;
  delay_minutes: number;
  channel: string;
  subject: string | null;
  content: string;
  content_type: string;
  dynamic_action: string | null;
  active: boolean;
}

// Replace template variables {{name}}, {{email}}, {{phone}}
function replaceVars(template: string, metadata: Record<string, any> | null, email: string): string {
  let result = template;
  const name = metadata?.name || email.split("@")[0];
  const phone = metadata?.phone || "";
  result = result.replace(/\{\{name\}\}/g, name);
  result = result.replace(/\{\{email\}\}/g, email);
  result = result.replace(/\{\{phone\}\}/g, phone);
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

function wrapEmailHTML(content: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#FAFAF7;font-family:Georgia,'Times New Roman',serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAF7;padding:40px 20px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
<tr><td style="background:linear-gradient(135deg,#1a1a2e,#16213e,#0f3460);padding:32px 40px;text-align:center;">
<h1 style="margin:0;color:#FFC400;font-size:24px;font-family:Georgia,serif;font-weight:normal;">Collection</h1>
</td></tr>
<tr><td style="padding:40px;">
<div style="font-size:16px;line-height:1.7;color:#333;">${content}</div>
</td></tr>
<tr><td style="padding:0 40px 32px;text-align:center;">
<a href="https://app.collection.com.br" style="display:inline-block;background:#FFC400;color:#1a1a2e;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:15px;">Acessar Collection</a>
</td></tr>
<tr><td style="padding:24px 40px;border-top:1px solid #eee;text-align:center;">
<p style="margin:0;font-size:12px;color:#999;">© Collection · Maior ecossistema de arquitetura do Brasil</p>
</td></tr>
</table>
</td></tr></table></body></html>`;
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

export async function POST() {
  try {
    // 1. Get all active rules
    const { data: rules, error: rulesError } = await supabaseAdmin
      .from("funnel_rules")
      .select("*")
      .eq("active", true)
      .order("priority", { ascending: false });

    if (rulesError) return NextResponse.json({ error: rulesError.message }, { status: 500 });
    if (!rules || rules.length === 0) {
      return NextResponse.json({ message: "Nenhuma regra ativa", processed: 0 });
    }

    // 2. Get all funnel events
    const { data: events, error: eventsError } = await supabaseAdmin
      .from("funnel_events")
      .select("*")
      .order("created_at", { ascending: true });

    if (eventsError) return NextResponse.json({ error: eventsError.message }, { status: 500 });

    // 3. Get all past actions to avoid duplicates
    const { data: pastActions } = await supabaseAdmin
      .from("funnel_actions")
      .select("rule_id, user_email");

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

    for (const rule of rules as FunnelRule[]) {
      // Find users at rule.stage who haven't reached rule.next_stage
      for (const [email, user] of users) {
        // Must have the trigger stage
        if (!user.stages.has(rule.stage)) continue;

        // Must NOT have the next stage (if specified)
        if (rule.next_stage && user.stages.has(rule.next_stage)) continue;

        // Check delay
        const stageTime = new Date(user.stageTimestamps[rule.stage]).getTime();
        const elapsed = (now - stageTime) / 60000; // minutes
        if (elapsed < rule.delay_minutes) continue;

        // Check if already sent
        const key = `${rule.id}::${email}`;
        if (actionSet.has(key)) continue;

        // Prepare content
        const content = replaceVars(rule.content, user.metadata, email);
        const subject = rule.subject ? replaceVars(rule.subject, user.metadata, email) : undefined;
        const phone = user.metadata?.phone || "";

        // Send based on channel
        const channels = rule.channel === "both" ? ["email", "sms"] : [rule.channel];

        for (const ch of channels) {
          let result: { success: boolean; error?: string };

          if (ch === "email") {
            result = await sendEmail(email, subject || "Collection", wrapEmailHTML(content));
          } else {
            // SMS: strip HTML
            const smsText = content.replace(/<[^>]*>/g, "").substring(0, 160);
            result = await sendSMS(phone, smsText);
          }

          // Log action
          await supabaseAdmin.from("funnel_actions").insert({
            rule_id: rule.id,
            user_email: email,
            user_id: null,
            channel: ch,
            status: result.success ? "sent" : "failed",
            error: result.error || null,
            metadata: { subject, content_preview: content.substring(0, 100) },
          });

          results.push({
            rule_id: rule.id,
            user: email,
            channel: ch,
            status: result.success ? "sent" : "failed",
            error: result.error,
          });

          // Mark as sent to avoid duplicate within same run
          actionSet.add(key);
        }
      }
    }

    return NextResponse.json({
      message: `Processado: ${results.length} ações`,
      processed: results.length,
      sent: results.filter((r) => r.status === "sent").length,
      failed: results.filter((r) => r.status === "failed").length,
      details: results,
    });
  } catch (error: any) {
    console.error("Erro ao processar funil:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
