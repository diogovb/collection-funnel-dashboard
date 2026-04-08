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
    const { event_type, email: rawEmail, user_id, metadata } = await request.json();

    if (!event_type) {
      return NextResponse.json({ error: "event_type é obrigatório" }, { status: 400, headers: CORS_HEADERS });
    }

    if (!rawEmail && !user_id) {
      return NextResponse.json({ error: "email ou user_id são obrigatórios" }, { status: 400, headers: CORS_HEADERS });
    }

    let email = rawEmail;
    if (!email && user_id) {
      const { data: userData, error: authError } = await supabaseAdmin.auth.admin.getUserById(user_id);
      if (authError) {
        console.error("getUserById error:", authError);
        return NextResponse.json(
          { error: "Falha ao buscar usuário", detail: authError.message, user_id },
          { status: 404, headers: CORS_HEADERS }
        );
      }
      if (!userData?.user) {
        return NextResponse.json(
          { error: "Usuário não encontrado", user_id },
          { status: 404, headers: CORS_HEADERS }
        );
      }
      if (!userData.user.email) {
        return NextResponse.json(
          { error: "Usuário não tem email", user_id, user: userData.user.id },
          { status: 422, headers: CORS_HEADERS }
        );
      }
      email = userData.user.email;
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
      return NextResponse.json({ error: "Erro ao inserir evento", detail: error.message }, { status: 500, headers: CORS_HEADERS });
    }

    return NextResponse.json({ success: true }, { headers: CORS_HEADERS });
  } catch (error) {
    console.error("Erro ao processar request:", error);
    return NextResponse.json({ error: "Erro interno do servidor", detail: String(error) }, { status: 500, headers: CORS_HEADERS });
  }
}
