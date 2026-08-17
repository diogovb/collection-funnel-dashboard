import { NextRequest, NextResponse } from "next/server";
import { getFunnelAdmin } from "@/lib/supabase-admin";

export async function POST(request: NextRequest) {
  try {
    const { eventId, stage } = await request.json();

    if (!eventId || !stage) {
      return NextResponse.json({ error: "eventId e stage são obrigatórios" }, { status: 400 });
    }

    const { data: event, error: fetchError } = await getFunnelAdmin()
      .from("funnel_events")
      .select("metadata")
      .eq("id", eventId)
      .single();

    if (fetchError || !event) {
      return NextResponse.json({ error: "Evento não encontrado" }, { status: 404 });
    }

    const currentMetadata = (event.metadata || {}) as Record<string, unknown>;
    const updatedMetadata = { ...currentMetadata, crm_stage: stage };

    const { error: updateError } = await getFunnelAdmin()
      .from("funnel_events")
      .update({ metadata: updatedMetadata })
      .eq("id", eventId);

    if (updateError) {
      console.error("Erro ao atualizar stage:", updateError);
      return NextResponse.json({ error: "Erro interno do servidor" }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Erro ao processar request:", error);
    return NextResponse.json({ error: "Erro interno do servidor" }, { status: 500 });
  }
}
