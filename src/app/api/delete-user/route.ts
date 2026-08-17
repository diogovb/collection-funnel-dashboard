import { NextRequest, NextResponse } from "next/server";
import { getFunnelAdmin } from "@/lib/supabase-admin";

export async function POST(request: NextRequest) {
  try {
    const { email, user_id } = await request.json();

    if (!email && !user_id) {
      return NextResponse.json(
        { error: "Email ou user_id é obrigatório" },
        { status: 400 }
      );
    }

    let query = getFunnelAdmin().from("funnel_events").delete();

    if (email) {
      query = query.eq("email", email);
    } else {
      query = query.eq("user_id", user_id);
    }

    const { error } = await query;

    if (error) {
      console.error("Erro ao deletar usuário:", error);
      return NextResponse.json(
        { error: "Erro interno do servidor" },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Erro ao processar request:", error);
    return NextResponse.json(
      { error: "Erro interno do servidor" },
      { status: 500 }
    );
  }
}
