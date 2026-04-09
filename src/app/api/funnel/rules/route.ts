import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

// GET - List all rules
export async function GET() {
  const { data, error } = await supabaseAdmin
    .from("funnel_rules")
    .select("*")
    .order("priority", { ascending: false })
    .order("created_at", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

// POST - Create a rule
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { stage, next_stage, delay_minutes, channel, subject, content, sms_content, content_type, dynamic_action, filters, active, priority } = body;

  if (!stage || !content) {
    return NextResponse.json({ error: "stage e content são obrigatórios" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from("funnel_rules")
    .insert({
      stage,
      next_stage: next_stage || null,
      delay_minutes: delay_minutes || 30,
      channel: channel || "email",
      subject: subject || null,
      content,
      sms_content: sms_content || null,
      content_type: content_type || "custom",
      dynamic_action: dynamic_action || null,
      filters: filters || null,
      active: active ?? false,
      priority: priority || 0,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

// PUT - Update a rule
export async function PUT(request: NextRequest) {
  const body = await request.json();
  const { id, ...updates } = body;

  if (!id) return NextResponse.json({ error: "id é obrigatório" }, { status: 400 });

  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from("funnel_rules")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

// DELETE - Delete a rule
export async function DELETE(request: NextRequest) {
  const { id } = await request.json();
  if (!id) return NextResponse.json({ error: "id é obrigatório" }, { status: 400 });

  // Delete related actions first
  await supabaseAdmin.from("funnel_actions").delete().eq("rule_id", id);

  const { error } = await supabaseAdmin.from("funnel_rules").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
