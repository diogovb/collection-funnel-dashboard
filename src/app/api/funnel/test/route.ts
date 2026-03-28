import { NextRequest, NextResponse } from "next/server";

const RESEND_API_KEY = process.env.RESEND_API_KEY!;
const SMSDEV_API_KEY = process.env.SMSDEV_API_KEY!;
const EMAIL_FROM = "Collection <noreply@pag.collection.com.br>";

// Email template (same as Dunning design)
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

function formatPhone(phone: string): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 11) return "55" + digits;
  if (digits.length === 13 && digits.startsWith("55")) return digits;
  if (digits.length === 10) return "55" + digits;
  return null;
}

export async function POST(request: NextRequest) {
  try {
    const { channel, email, phone, subject, content } = await request.json();

    // Replace test variables
    const testContent = content
      .replace(/\{\{name\}\}/g, "Teste")
      .replace(/\{\{email\}\}/g, email || "teste@email.com")
      .replace(/\{\{phone\}\}/g, phone || "");

    const results: Array<{ channel: string; success: boolean; error?: string }> = [];

    // Send test email
    if ((channel === "email" || channel === "both") && email) {
      const html = wrapEmailHTML(testContent);
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${RESEND_API_KEY}`,
        },
        body: JSON.stringify({
          from: EMAIL_FROM,
          to: email,
          subject: `[TESTE] ${subject || "Collection"}`,
          html,
        }),
      });
      if (res.ok) {
        results.push({ channel: "email", success: true });
      } else {
        const err = await res.text();
        results.push({ channel: "email", success: false, error: err });
      }
    }

    // Send test SMS
    if ((channel === "sms" || channel === "both") && phone) {
      const formatted = formatPhone(phone);
      if (!formatted) {
        results.push({ channel: "sms", success: false, error: "Telefone inválido" });
      } else {
        const smsText = testContent.replace(/<[^>]*>/g, "").substring(0, 160);
        const params = new URLSearchParams({
          key: SMSDEV_API_KEY,
          type: "9",
          number: formatted,
          msg: `[TESTE] ${smsText}`,
        });
        const res = await fetch(`https://api.smsdev.com.br/v1/send?${params}`);
        const data = await res.json();
        if (data.situacao === "OK" || data.id) {
          results.push({ channel: "sms", success: true });
        } else {
          results.push({ channel: "sms", success: false, error: JSON.stringify(data) });
        }
      }
    }

    const allOk = results.every((r) => r.success);
    const errors = results.filter((r) => !r.success).map((r) => `${r.channel}: ${r.error}`);

    return NextResponse.json({
      success: allOk,
      error: errors.length > 0 ? errors.join("; ") : undefined,
      results,
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
