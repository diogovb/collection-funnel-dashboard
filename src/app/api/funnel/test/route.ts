import { NextRequest, NextResponse } from "next/server";
import { wrapEmailHTML } from "@/lib/email-template";

const RESEND_API_KEY = process.env.RESEND_API_KEY!;
const SMSDEV_API_KEY = process.env.SMSDEV_API_KEY!;
const EMAIL_FROM = "Collection <noreply@pag.collection.com.br>";

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
