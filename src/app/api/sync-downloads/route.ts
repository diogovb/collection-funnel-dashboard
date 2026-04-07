import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

// Metabase Collection PostgreSQL
const METABASE_URL = "https://metabase.collection.com.br";
const METABASE_API_KEY = "mb_HCdbdyTeP9uQMmbIndq4p1Il1ZXsRWeEavGejy2vitU=";

async function queryMetabase(sql: string): Promise<any[]> {
  const res = await fetch(`${METABASE_URL}/api/dataset`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": METABASE_API_KEY,
    },
    body: JSON.stringify({
      database: 10, // Collection PostgreSQL - PROD
      type: "native",
      native: { query: sql },
    }),
  });
  const data = await res.json();
  if (!data.data?.rows) return [];
  const cols = data.data.cols.map((c: any) => c.name);
  return data.data.rows.map((row: any[]) => {
    const obj: any = {};
    cols.forEach((col: string, i: number) => (obj[col] = row[i]));
    return obj;
  });
}

export async function GET() {
  try {
    // 1. Get ALL unique emails in funnel that do NOT have first_download yet
    const PAGE_SIZE = 1000;
    let page = 0;
    let allEvents: { email: string | null; event: string }[] = [];
    while (true) {
      const { data, error } = await supabaseAdmin
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
      `SELECT DISTINCT u.email
       FROM product_download pd
       JOIN user_on_office uoo ON uoo.id = pd."userOnOfficeId"
       JOIN "user" u ON u.id = uoo."userId"
       WHERE u.email IN (${emailList})
       LIMIT 100`
    );

    if (rows.length === 0) {
      return NextResponse.json({ synced: 0, message: "Nenhum download encontrado" });
    }

    // 3. Insert first_download events
    const events = rows.map((row) => ({
      email: row.email,
      event: "first_download",
      metadata: { source: "metabase_sync", synced_at: new Date().toISOString() },
    }));

    const { error } = await supabaseAdmin.from("funnel_events").insert(events);

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
