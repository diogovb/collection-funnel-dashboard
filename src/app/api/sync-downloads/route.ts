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
    // 1. Get ALL emails that signed up but do NOT have first_download yet
    const { data: signedUp } = await supabaseAdmin
      .from("funnel_events")
      .select("email")
      .eq("event", "signup_completed")
      .not("email", "is", null);

    const { data: downloaded } = await supabaseAdmin
      .from("funnel_events")
      .select("email")
      .eq("event", "first_download");

    if (!signedUp || signedUp.length === 0) {
      return NextResponse.json({ synced: 0, message: "Nenhum signup_completed com email" });
    }

    const downloadedEmails = new Set((downloaded || []).map((d) => d.email));
    const toCheck = [...new Set(signedUp.map((i) => i.email))]
      .filter((email): email is string => !!email && !downloadedEmails.has(email));

    if (toCheck.length === 0) {
      return NextResponse.json({ synced: 0, message: "Todos já sincronizados" });
    }

    // 2. Query Collection Postgres via Metabase for downloads
    const emailList = toCheck.map((e) => `'${e.replace(/'/g, "''")}'`).join(",");
    
    const rows = await queryMetabase(
      `SELECT DISTINCT u.email
       FROM product_download pd
       JOIN "user" u ON u.id = pd."userId"
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
