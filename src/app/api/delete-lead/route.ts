import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export async function POST(request: NextRequest) {
  try {
    const { id } = await request.json();

    if (!id) {
      return NextResponse.json({ error: "id é obrigatório" }, { status: 400 });
    }

    const { error } = await supabaseAdmin
      .from("funnel_events")
      .delete()
      .eq("id", id);

    if (error) {
      console.error("Erro ao deletar lead:", error);
      return NextResponse.json({ error: "Erro interno do servidor" }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Erro ao processar request:", error);
    return NextResponse.json({ error: "Erro interno do servidor" }, { status: 500 });
  }
}
