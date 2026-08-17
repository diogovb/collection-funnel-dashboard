import { NextRequest, NextResponse } from "next/server";
import { getFunnelAdmin } from "@/lib/supabase-admin";

const ICP_SOFTWARES_LC = new Set(["sketchup", "archicad", "revit"]);
const ICP_PROFESSIONS_LC = new Set(["arquiteto", "arquiteto(a)", "designer de interiores", "designer_interiores", "projetista"]);

function isIcp(software: string, profession: string): boolean {
  return ICP_SOFTWARES_LC.has(software.toLowerCase()) && ICP_PROFESSIONS_LC.has(profession.toLowerCase());
}

export async function GET(request: NextRequest) {
  const secret = request.nextUrl.searchParams.get("secret");
  if (secret !== "collection2024") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    let allEvents: { id: string; metadata: Record<string, unknown> | null }[] = [];
    let page = 0;
    const PAGE_SIZE = 1000;

    while (true) {
      const { data, error } = await getFunnelAdmin()
        .from("funnel_events")
        .select("id, metadata")
        .eq("event", "signup_completed")
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
      if (error || !data) break;
      allEvents = allEvents.concat(data as typeof allEvents);
      if (data.length < PAGE_SIZE) break;
      page++;
    }

    const total = allEvents.length;
    let updated = 0;
    let skipped = 0;

    for (const ev of allEvents) {
      const m = (ev.metadata || {}) as Record<string, unknown>;
      const currentStage = m.crm_stage as string | undefined;

      // Don't overwrite manual changes — only touch "novo", undefined, or null
      if (currentStage && currentStage !== "novo") {
        skipped++;
        continue;
      }

      const software = (m.software as string) || "";
      const profession = (m.profession as string) || "";
      const newStage = isIcp(software, profession) ? "novo" : "nao_qualificado";

      // Skip no-ops: ICP match and already "novo" / unset
      if (newStage === "novo") {
        skipped++;
        continue;
      }

      // Update: non-ICP software → "nao_qualificado"
      const { error: updateError } = await getFunnelAdmin()
        .from("funnel_events")
        .update({ metadata: { ...m, crm_stage: newStage } })
        .eq("id", ev.id);

      if (updateError) {
        console.error(`Error updating event ${ev.id}:`, updateError);
        skipped++;
      } else {
        updated++;
      }
    }

    return NextResponse.json({ updated, skipped, total });
  } catch (error) {
    console.error("Error in fix-crm-stages:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
