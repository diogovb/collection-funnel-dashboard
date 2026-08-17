import { NextRequest, NextResponse } from "next/server";
import { getFunnelAdmin } from "@/lib/supabase-admin";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 50;

function isAuthorized(request: NextRequest): boolean {
  const expected = process.env.WHATSAPP_BRIDGE_TOKEN;
  if (!expected) return false;
  const header = request.headers.get("authorization") || "";
  return header === `Bearer ${expected}`;
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limitParam = request.nextUrl.searchParams.get("limit");
  const parsed = limitParam ? parseInt(limitParam, 10) : DEFAULT_LIMIT;
  const limit = Math.min(Math.max(Number.isFinite(parsed) ? parsed : DEFAULT_LIMIT, 1), MAX_LIMIT);

  // Atomically pick N oldest pending jobs and increment attempts.
  // The CTE pattern guarantees that two concurrent pollers don't get the
  // same rows. (Supabase RPC is unnecessary — this runs as a single SQL stmt.)
  const { data, error } = await getFunnelAdmin().rpc("whatsapp_outbox_claim", { p_limit: limit });

  if (error) {
    console.error("whatsapp/pending RPC error:", error);
    return NextResponse.json({ error: "Internal error", detail: error.message }, { status: 500 });
  }

  return NextResponse.json({ jobs: data || [] });
}
