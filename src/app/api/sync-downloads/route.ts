import { NextResponse } from "next/server";
import { getFunnelAdmin } from "@/lib/supabase-admin";
/* Saiu daqui para @/lib/metabase quando a rota de ativação no plugin passou
   a precisar do mesmo acesso. Mesmo comportamento. */
import { queryMetabase } from "@/lib/metabase";

export async function GET() {
  try {
    // 1. Get ALL unique emails in funnel that do NOT have first_download yet
    const PAGE_SIZE = 1000;
    let page = 0;
    let allEvents: { email: string | null; event: string }[] = [];
    while (true) {
      const { data, error } = await getFunnelAdmin()
        .from("funnel_events")
        .select("email, event")
        .not("email", "is", null)
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
      if (error || !data) break;
      allEvents = allEvents.concat(data);
      if (data.length < PAGE_SIZE) break;
      page++;
    }

    if (allEvents.length === 0) {
      return NextResponse.json({ synced: 0, message: "Nenhum evento com email" });
    }

    const downloadedEmails = new Set<string>();
    const signupEmails = new Set<string>();
    for (const ev of allEvents) {
      if (ev.event === "signup_completed" && ev.email) signupEmails.add(ev.email);
      if (ev.event === "first_download" && ev.email) downloadedEmails.add(ev.email);
    }
    // Only sync downloads for users who went through onboarding (have signup_completed)
    const toCheck = [...signupEmails].filter(email => !downloadedEmails.has(email));

    if (toCheck.length === 0) {
      return NextResponse.json({ synced: 0, message: "Todos já sincronizados" });
    }

    // 2. Query Collection Postgres via Metabase for downloads
    const emailList = toCheck.map((e) => `'${e.replace(/'/g, "''")}'`).join(",");
    
    const rows = await queryMetabase(
      `SELECT u.email, MIN(pd."createdAt") AS first_download_at
       FROM product_download pd
       JOIN user_on_office uoo ON uoo.id = pd."userOnOfficeId"
       JOIN "user" u ON u.id = uoo."userId"
       WHERE u.email IN (${emailList})
       GROUP BY u.email
       LIMIT 100`
    );

    if (rows.length === 0) {
      return NextResponse.json({ synced: 0, message: "Nenhum download encontrado" });
    }

    // 3. Insert first_download events using the real download date
    const events = rows.map((row) => ({
      email: row.email,
      event: "first_download",
      created_at: row.first_download_at ?? new Date().toISOString(),
      metadata: { source: "metabase_sync", synced_at: new Date().toISOString() },
    }));

    const { error } = await getFunnelAdmin().from("funnel_events").insert(events);

    if (error) {
      console.error("Erro ao inserir first_download:", error);
      return NextResponse.json({ error: "Erro ao sincronizar" }, { status: 500 });
    }

    return NextResponse.json({ synced: rows.length, emails: rows.map((r) => r.email) });
  } catch (error) {
    console.error("Erro no sync-downloads:", error);
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
