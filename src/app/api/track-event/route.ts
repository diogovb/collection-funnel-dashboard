import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 200, headers: CORS_HEADERS });
}

export async function POST(request: NextRequest) {
  const secret = request.nextUrl.searchParams.get("secret");
  if (secret !== "collection2024") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: CORS_HEADERS });
  }

  try {
    const { event_type, email, metadata } = await request.json();

    if (!event_type || !email) {
      return NextResponse.json({ error: "event_type e email são obrigatórios" }, { status: 400, headers: CORS_HEADERS });
    }

    if (!["download", "render_ia"].includes(event_type)) {
      return NextResponse.json({ error: "event_type inválido" }, { status: 400, headers: CORS_HEADERS });
    }

    const { data: existing } = await supabaseAdmin
      .from("funnel_events")
      .select("id")
      .eq("email", email)
      .eq("event", event_type)
      .limit(1)
      .maybeSingle();

    if (existing) {
      return NextResponse.json({ ok: true, skipped: true, message: "Event already exists for this email" }, { headers: CORS_HEADERS });
    }

    const { error } = await supabaseAdmin
      .from("funnel_events")
      .insert({
        event: event_type,
        email,
        metadata: metadata || {},
        created_at: new Date().toISOString(),
      });

    if (error) {
      console.error("Erro ao inserir evento:", error);
      return NextResponse.json({ error: "Erro interno do servidor" }, { status: 500, headers: CORS_HEADERS });
    }

    return NextResponse.json({ success: true }, { headers: CORS_HEADERS });
  } catch (error) {
    console.error("Erro ao processar request:", error);
    return NextResponse.json({ error: "Erro interno do servidor" }, { status: 500, headers: CORS_HEADERS });
  }
}
