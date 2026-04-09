"use client";

import { useState, useEffect, useCallback } from "react";

interface AudienceFilters {
  professions: string[];
  softwares: string[];
  interests: string[];
}

interface FunnelRule {
  id: string;
  stage: string;
  next_stage: string | null;
  delay_minutes: number;
  channel: string;
  subject: string | null;
  content: string;
  sms_content: string | null;
  content_type: string;
  dynamic_action: string | null;
  filters: AudienceFilters | null;
  active: boolean;
  created_at: string;
  updated_at: string;
  priority: number;
}

interface RuleStats {
  sent: number;
  failed: number;
  today: number;
  lastSent: string | null;
  pendentes: number;
}

interface StatsResponse {
  byRule: Record<string, RuleStats>;
  totals: { sent: number; failed: number; today: number };
}

interface FunnelAction {
  id: string;
  rule_id: string;
  user_email: string;
  channel: string;
  status: string;
  error: string | null;
  metadata: Record<string, any> | null;
  created_at: string;
  funnel_rules?: {
    stage: string;
    next_stage: string;
    channel: string;
    subject: string;
  };
}

// ── Trigger definitions ────────────────────────────────────
const TRIGGERS = [
  {
    id: "no_download",
    label: "Cadastrou e não fez Download",
    description: "Tem signup_completed mas não baixou nenhum produto",
    icon: "📥",
    stage: "signup_completed",
    next_stage: "download",
  },
  {
    id: "no_render",
    label: "Cadastrou e não fez Render IA",
    description: "Tem signup_completed mas não usou o Render IA",
    icon: "🎨",
    stage: "signup_completed",
    next_stage: "render_ia",
  },
  {
    id: "no_action",
    label: "Cadastrou e não fez nenhuma ação",
    description: "Tem signup_completed mas não baixou nem renderizou",
    icon: "🚫",
    stage: "signup_completed",
    next_stage: "any_action",
  },
] as const;

type TriggerId = typeof TRIGGERS[number]["id"];

function getTriggerFromRule(rule: FunnelRule): TriggerId {
  if (rule.stage === "signup_completed") {
    if (rule.next_stage === "download") return "no_download";
    if (rule.next_stage === "render_ia") return "no_render";
    if (rule.next_stage === "any_action") return "no_action";
  }
  return "no_download";
}

function getTrigger(id: TriggerId) {
  return TRIGGERS.find(t => t.id === id) ?? TRIGGERS[0];
}

const CHANNEL_ICONS: Record<string, string> = {
  email: "📧",
  sms: "📱",
  both: "📧📱",
};

const AUDIENCE_OPTIONS = {
  professions: ["Arquiteto(a)", "Designer de Interiores", "Projetista", "Engenheiro(a)", "Estudante", "Outro"],
  softwares: ["SketchUp", "Revit", "ArchiCAD", "Promob", "AutoCAD", "Outro"],
  interests: ["Blocos 3D", "Texturas e Materiais", "Render IA", "Outro"],
} as const;

const VARIABLES = [
  { name: "{{name}}", desc: "primeiro nome" },
  { name: "{{email}}", desc: "email" },
  { name: "{{phone}}", desc: "WhatsApp" },
  { name: "{{profession}}", desc: "profissão" },
  { name: "{{software}}", desc: "software" },
  { name: "{{interest}}", desc: "o que trouxe ao Collection" },
];

function formatDate(d: string) {
  return new Date(d).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

// ── Email Template ─────────────────────────────────────────
function wrapEmailHTML(content: string, subject: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#FAFAF7;font-family:Georgia,'Times New Roman',serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAF7;padding:40px 20px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
<tr><td style="background:linear-gradient(135deg,#1a1a2e,#16213e,#0f3460);padding:32px 40px;text-align:center;">
<h1 style="margin:0;color:#FFC400;font-size:24px;font-family:Georgia,serif;font-weight:normal;">Collection</h1>
</td></tr>
<tr><td style="padding:40px;">
<div style="font-size:16px;line-height:1.7;color:#333;">${content}</div>
</td></tr>
<tr><td style="padding:0 40px 32px;text-align:center;">
<a href="https://app.collection.com.br" style="display:inline-block;background:#FFC400;color:#1a1a2e;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:15px;">Acessar Collection</a>
</td></tr>
<tr><td style="padding:24px 40px;border-top:1px solid #eee;text-align:center;">
<p style="margin:0;font-size:12px;color:#999;">© Collection · Maior ecossistema de arquitetura do Brasil</p>
</td></tr>
</table>
</td></tr></table></body></html>`;
}

// ── Multi-pill select ──────────────────────────────────────
function MultiPillSelect({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: readonly string[];
  selected: string[];
  onChange: (vals: string[]) => void;
}) {
  const toggle = (val: string) => {
    onChange(selected.includes(val) ? selected.filter(v => v !== val) : [...selected, val]);
  };
  return (
    <div>
      <p className="text-xs text-gray-500 mb-2">
        {label}
        {selected.length === 0 && <span className="ml-1.5 text-gray-600">(todos)</span>}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {options.map(opt => (
          <button
            key={opt}
            type="button"
            onClick={() => toggle(opt)}
            className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all border ${
              selected.includes(opt)
                ? "bg-indigo-600/25 border-indigo-500/60 text-indigo-300"
                : "bg-transparent border-gray-600/50 text-gray-500 hover:border-gray-500 hover:text-gray-400"
            }`}
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Variable Pills ─────────────────────────────────────────
function VariablePills({ onInsert }: { onInsert: (v: string) => void }) {
  return (
    <div className="mt-3 bg-gray-800/30 rounded-xl p-3 border border-gray-700/40">
      <p className="text-xs text-gray-500 mb-2 font-medium">Variáveis disponíveis:</p>
      <div className="flex flex-wrap gap-1.5">
        {VARIABLES.map((v) => (
          <button
            key={v.name}
            onClick={() => onInsert(v.name)}
            title={v.desc}
            className="inline-flex items-center gap-1 px-2 py-1 bg-gray-700/60 hover:bg-indigo-600/40 border border-gray-600/50 hover:border-indigo-500/50 rounded-md text-xs font-mono text-gray-300 hover:text-indigo-300 transition-all"
          >
            {v.name}
            <span className="text-gray-500 font-sans text-[10px]">— {v.desc}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Rule Detail Modal ──────────────────────────────────────
type DetailType = "enviadas" | "pendentes" | "falhas";

interface DetailItem {
  email: string;
  name: string;
  phone: string;
  date?: string;
  error?: string | null;
  channels?: string[];
}

function RuleDetailModal({
  ruleId,
  type,
  onClose,
}: {
  ruleId: string;
  type: DetailType;
  onClose: () => void;
}) {
  const [items, setItems] = useState<DetailItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/funnel/actions?rule_id=${encodeURIComponent(ruleId)}&type=${type}`)
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setItems(data);
        else setFetchError(data.error || "Erro ao carregar");
        setLoading(false);
      })
      .catch(() => { setFetchError("Erro ao carregar"); setLoading(false); });
  }, [ruleId, type]);

  const titles: Record<DetailType, string> = {
    enviadas: "✅ Enviadas",
    pendentes: "⏳ Pendentes",
    falhas: "❌ Falhas",
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 z-[70]">
      <div className="bg-[#111827] rounded-2xl w-full max-w-lg border border-gray-700/60 shadow-2xl flex flex-col max-h-[80vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700/60 flex-shrink-0">
          <h3 className="text-base font-semibold text-white">{titles[type]}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white w-7 h-7 flex items-center justify-center rounded-lg hover:bg-gray-700 transition-colors">✕</button>
        </div>
        <div className="overflow-y-auto flex-1">
          {loading && (
            <div className="flex items-center justify-center py-10 text-gray-500 text-sm animate-pulse">
              Carregando...
            </div>
          )}
          {fetchError && (
            <div className="px-5 py-4 text-sm text-red-400">{fetchError}</div>
          )}
          {!loading && !fetchError && items.length === 0 && (
            <div className="px-5 py-10 text-center text-sm text-gray-500">Nenhum registro encontrado.</div>
          )}
          {!loading && !fetchError && items.length > 0 && (
            <ul className="divide-y divide-gray-700/40">
              {items.map((item, i) => (
                <li key={i} className="px-5 py-3 flex flex-col gap-0.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-white truncate">{item.name}</span>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {item.channels && item.channels.map((ch) => (
                        <span key={ch} className="text-xs">{ch === "email" ? "📧" : "📱"}</span>
                      ))}
                      {item.date && (
                        <span className="text-[11px] text-gray-500">{formatDate(item.date)}</span>
                      )}
                    </div>
                  </div>
                  <span className="text-xs text-gray-400">{item.email}</span>
                  {item.phone && (
                    <span className="text-xs text-gray-500">{item.phone}</span>
                  )}
                  {item.error && (
                    <span className="text-xs text-red-400 mt-0.5 break-all">{item.error}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex justify-between items-center px-5 py-3 border-t border-gray-700/60 flex-shrink-0">
          <span className="text-xs text-gray-500">{items.length} {items.length === 1 ? "registro" : "registros"}</span>
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">Fechar</button>
        </div>
      </div>
    </div>
  );
}

// ── Test Modal ─────────────────────────────────────────────
function TestModal({
  channel,
  subject,
  content,
  smsContent,
  onClose,
}: {
  channel: string;
  subject: string;
  content: string;
  smsContent: string;
  onClose: () => void;
}) {
  const [testEmail, setTestEmail] = useState("");
  const [testPhone, setTestPhone] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const handleTest = async () => {
    setSending(true);
    setResult(null);
    try {
      const res = await fetch("/api/funnel/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, email: testEmail, phone: testPhone, subject, content, sms_content: smsContent }),
      });
      const data = await res.json();
      setResult(data.success ? "✅ Enviado com sucesso!" : `❌ ${data.error || "Erro"}`);
    } catch {
      setResult("❌ Erro ao enviar");
    }
    setSending(false);
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 z-[70]">
      <div className="bg-[#111827] rounded-2xl w-full max-w-md border border-gray-700/60 shadow-2xl">
        <div className="flex items-center justify-between p-5 border-b border-gray-700/60">
          <h3 className="text-base font-semibold">🧪 Testar envio</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white w-7 h-7 flex items-center justify-center rounded-lg hover:bg-gray-700 transition-colors">✕</button>
        </div>
        <div className="p-5 space-y-4">
          {(channel === "email" || channel === "both") && (
            <div>
              <label className="block text-xs text-gray-400 mb-1.5">Email de teste</label>
              <input type="email" value={testEmail} onChange={(e) => setTestEmail(e.target.value)}
                placeholder="seu@email.com"
                className="w-full bg-gray-800/60 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500" />
            </div>
          )}
          {(channel === "sms" || channel === "both") && (
            <div>
              <label className="block text-xs text-gray-400 mb-1.5">Telefone de teste</label>
              <input type="tel" value={testPhone} onChange={(e) => setTestPhone(e.target.value)}
                placeholder="(11) 99999-9999"
                className="w-full bg-gray-800/60 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500" />
            </div>
          )}
          {result && <p className="text-sm bg-gray-800/50 rounded-lg px-3 py-2">{result}</p>}
        </div>
        <div className="flex justify-end gap-3 p-5 border-t border-gray-700/60">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">Fechar</button>
          <button onClick={handleTest} disabled={sending || (!testEmail && !testPhone)}
            className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 rounded-lg text-sm font-medium transition-colors">
            {sending ? "Enviando..." : "Enviar teste"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Rule Form Modal ────────────────────────────────────────
function RuleFormModal({
  rule,
  onSave,
  onClose,
}: {
  rule?: FunnelRule | null;
  onSave: (data: Partial<FunnelRule>) => Promise<string | null>;
  onClose: () => void;
}) {
  const initialTriggerId = rule ? getTriggerFromRule(rule) : "no_download";
  const [triggerId, setTriggerId] = useState<TriggerId>(initialTriggerId);

  // Delay split into value + unit
  const initialMinutes = rule?.delay_minutes || 30;
  const [delayUnit, setDelayUnit] = useState<"minutos" | "horas">(initialMinutes >= 60 && initialMinutes % 60 === 0 ? "horas" : "minutos");
  const [delayValue, setDelayValue] = useState(delayUnit === "horas" ? initialMinutes / 60 : initialMinutes);

  const [channel, setChannel] = useState(rule?.channel || "email");
  const [subject, setSubject] = useState(rule?.subject || "");
  // For "sms"-only rules, content is stored in rule.content (sms_content is null).
  // For "both" rules, email body is in rule.content and SMS body is in rule.sms_content.
  const [content, setContent] = useState(rule?.channel === "sms" ? "" : (rule?.content || ""));
  const [smsContent, setSmsContent] = useState(
    rule?.channel === "both" ? (rule?.sms_content || "") :
    rule?.channel === "sms"  ? (rule?.content || "") : ""
  );
  const f = rule?.filters;
  const [filterProfessions, setFilterProfessions] = useState<string[]>(Array.isArray(f?.professions) ? f!.professions : []);
  const [filterSoftwares, setFilterSoftwares] = useState<string[]>(Array.isArray(f?.softwares) ? f!.softwares : []);
  const [filterInterests, setFilterInterests] = useState<string[]>(Array.isArray(f?.interests) ? f!.interests : []);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showTest, setShowTest] = useState(false);

  const delayMinutes = delayUnit === "horas" ? delayValue * 60 : delayValue;
  const trigger = getTrigger(triggerId);

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    const error = await onSave({
      ...(rule?.id ? { id: rule.id } : {}),
      stage: trigger.stage,
      next_stage: trigger.next_stage,
      delay_minutes: delayMinutes,
      channel,
      subject: channel !== "sms" ? subject : null,
      content: channel === "sms" ? smsContent : content,
      sms_content: channel === "both" ? smsContent : null,
      content_type: "custom",
      filters: {
        professions: filterProfessions,
        softwares: filterSoftwares,
        interests: filterInterests,
      },
      active: rule?.active ?? false,
    });
    if (error) setSaveError(error);
    setSaving(false);
  };

  const insertEmailVariable = (varName: string) => {
    setContent(prev => prev + varName);
  };

  const insertSmsVariable = (varName: string) => {
    setSmsContent(prev => prev + varName);
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-0 sm:p-4 z-50">
        <div className="bg-[#0d1117] sm:rounded-2xl w-full h-full sm:h-auto sm:max-w-2xl sm:max-h-[92vh] overflow-y-auto border-0 sm:border border-gray-700/60 shadow-2xl">

          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700/60">
            <h3 className="text-base font-semibold text-white">{rule?.id ? "Editar regra" : "Nova regra de automação"}</h3>
            <button onClick={onClose} className="text-gray-500 hover:text-white w-7 h-7 flex items-center justify-center rounded-lg hover:bg-gray-700/60 transition-colors">✕</button>
          </div>

          <div className="p-5 space-y-6">

            {/* Trigger */}
            <div>
              <p className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-3">Gatilho</p>
              <div className="space-y-2">
                {TRIGGERS.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setTriggerId(t.id)}
                    className={`w-full flex items-start gap-3 px-4 py-3 rounded-xl border text-left transition-all ${
                      triggerId === t.id
                        ? "border-indigo-500/70 bg-indigo-500/10"
                        : "border-gray-700/60 bg-gray-800/30 hover:border-gray-600 hover:bg-gray-800/50"
                    }`}
                  >
                    <span className="text-xl mt-0.5 flex-shrink-0">{t.icon}</span>
                    <div className="min-w-0">
                      <p className={`text-sm font-medium ${triggerId === t.id ? "text-indigo-300" : "text-gray-200"}`}>{t.label}</p>
                      <p className="text-xs text-gray-500 mt-0.5">{t.description}</p>
                    </div>
                    {triggerId === t.id && (
                      <span className="ml-auto flex-shrink-0 w-4 h-4 rounded-full bg-indigo-500 flex items-center justify-center text-[10px] mt-0.5">✓</span>
                    )}
                  </button>
                ))}
              </div>
            </div>

            {/* Delay */}
            <div>
              <p className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-3">Aguardar antes de enviar</p>
              <div className="flex items-center gap-3">
                <input
                  type="number"
                  value={delayValue}
                  min={1}
                  onChange={(e) => setDelayValue(Math.max(1, Number(e.target.value)))}
                  className="w-24 bg-gray-800/60 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-center font-medium focus:outline-none focus:border-indigo-500"
                />
                <div className="flex gap-1.5">
                  {(["minutos", "horas"] as const).map((u) => (
                    <button
                      key={u}
                      onClick={() => {
                        if (u === "horas" && delayUnit === "minutos") {
                          setDelayValue(Math.max(1, Math.round(delayValue / 60)));
                        } else if (u === "minutos" && delayUnit === "horas") {
                          setDelayValue(delayValue * 60);
                        }
                        setDelayUnit(u);
                      }}
                      className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                        delayUnit === u ? "bg-indigo-600 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700"
                      }`}
                    >
                      {u}
                    </button>
                  ))}
                </div>
                <span className="text-xs text-gray-500">= {delayMinutes} min</span>
              </div>
            </div>

            {/* Audience filters */}
            <div>
              <p className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-3">
                Filtros de audiência
                {(filterProfessions.length + filterSoftwares.length + filterInterests.length) === 0 && (
                  <span className="ml-2 normal-case font-normal text-gray-600">— sem filtro, envia para todos</span>
                )}
              </p>
              <div className="bg-gray-800/20 border border-gray-700/40 rounded-xl p-4 space-y-4">
                <MultiPillSelect
                  label="Profissão"
                  options={AUDIENCE_OPTIONS.professions}
                  selected={filterProfessions}
                  onChange={setFilterProfessions}
                />
                <MultiPillSelect
                  label="Software"
                  options={AUDIENCE_OPTIONS.softwares}
                  selected={filterSoftwares}
                  onChange={setFilterSoftwares}
                />
                <MultiPillSelect
                  label="Interesse"
                  options={AUDIENCE_OPTIONS.interests}
                  selected={filterInterests}
                  onChange={setFilterInterests}
                />
              </div>
            </div>

            {/* Channel */}
            <div>
              <p className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-3">Canal</p>
              <div className="flex gap-2">
                {(["email", "sms", "both"] as const).map((ch) => (
                  <button key={ch} onClick={() => setChannel(ch)}
                    className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-all border ${
                      channel === ch
                        ? "bg-indigo-600 border-indigo-500 text-white"
                        : "bg-gray-800/40 border-gray-700/60 text-gray-400 hover:border-gray-600 hover:text-gray-300"
                    }`}>
                    {CHANNEL_ICONS[ch]} {ch === "both" ? "Ambos" : ch.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>

            {/* Email fields */}
            {(channel === "email" || channel === "both") && (
              <div className="space-y-4">
                {channel === "both" && (
                  <p className="text-xs font-semibold text-indigo-400 uppercase tracking-wider flex items-center gap-1.5">📧 Email</p>
                )}
                <div>
                  <label className="block text-xs font-medium text-gray-400 uppercase tracking-wider mb-3">Assunto do email</label>
                  <input type="text" value={subject} onChange={(e) => setSubject(e.target.value)}
                    placeholder="Ex: {{name}}, seu acervo te espera 👋"
                    className="w-full bg-gray-800/60 border border-gray-700 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500 transition-colors" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-400 uppercase tracking-wider mb-3">Conteúdo do email</label>
                  <textarea
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    rows={6}
                    placeholder="<h2>Oi {{name}}!</h2>&#10;<p>Você se cadastrou no Collection mas ainda não explorou o acervo...</p>"
                    className="w-full bg-gray-800/60 border border-gray-700 rounded-xl px-4 py-3 text-sm font-mono focus:outline-none focus:border-indigo-500 transition-colors resize-none leading-relaxed"
                  />
                  <VariablePills onInsert={insertEmailVariable} />
                </div>
              </div>
            )}

            {/* SMS field */}
            {(channel === "sms" || channel === "both") && (
              <div>
                {channel === "both" && (
                  <p className="text-xs font-semibold text-indigo-400 uppercase tracking-wider flex items-center gap-1.5 mb-4">📱 SMS</p>
                )}
                <div className="flex items-center justify-between mb-3">
                  <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">
                    {channel === "sms" ? "Mensagem SMS" : "Conteúdo do SMS"}
                  </label>
                  <span className={`text-xs font-mono ${smsContent.length > 140 ? "text-amber-400" : "text-gray-500"}`}>
                    {smsContent.length}/160
                  </span>
                </div>
                <textarea
                  value={smsContent}
                  onChange={(e) => setSmsContent(e.target.value)}
                  rows={4}
                  maxLength={160}
                  placeholder="Oi {{name}}! Sua conta Collection está pronta. Baixe seu primeiro produto agora: https://app.collection.com.br"
                  className="w-full bg-gray-800/60 border border-gray-700 rounded-xl px-4 py-3 text-sm font-mono focus:outline-none focus:border-indigo-500 transition-colors resize-none leading-relaxed"
                />
                <VariablePills onInsert={insertSmsVariable} />
              </div>
            )}
          </div>

          {/* Footer */}
          {saveError && (
            <div className="mx-5 mb-1 px-4 py-2.5 bg-red-900/30 border border-red-700/50 rounded-xl text-sm text-red-400">
              ❌ {saveError}
            </div>
          )}
          <div className="flex flex-col sm:flex-row justify-between gap-3 px-5 py-4 border-t border-gray-700/60">
            <button onClick={() => setShowTest(true)} disabled={channel === "sms" ? !smsContent : !content}
              className="px-4 py-2.5 bg-gray-700/60 hover:bg-gray-700 disabled:opacity-40 rounded-xl text-sm font-medium transition-colors order-2 sm:order-1 border border-gray-600/50">
              🧪 Testar envio
            </button>
            <div className="flex gap-3 order-1 sm:order-2">
              <button onClick={onClose} className="flex-1 sm:flex-none px-4 py-2.5 text-sm text-gray-400 hover:text-white transition-colors">Cancelar</button>
              <button onClick={handleSave} disabled={saving}
                className="flex-1 sm:flex-none px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 rounded-xl text-sm font-medium transition-colors">
                {saving ? "Salvando..." : "Salvar regra"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {showTest && (
        <TestModal
          channel={channel}
          subject={subject}
          content={channel === "sms" ? smsContent : content}
          smsContent={smsContent}
          onClose={() => setShowTest(false)}
        />
      )}
    </>
  );
}

// ── Main Panel ─────────────────────────────────────────────
export default function AutomationPanel() {
  const [rules, setRules] = useState<FunnelRule[]>([]);
  const [editingRule, setEditingRule] = useState<FunnelRule | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [detailModal, setDetailModal] = useState<{ ruleId: string; type: DetailType } | null>(null);

  const fetchRules = useCallback(async () => {
    try {
      const res = await fetch("/api/funnel/rules");
      if (res.ok) setRules(await res.json());
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  const fetchStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      const res = await fetch("/api/funnel/stats");
      if (res.ok) setStats(await res.json());
    } catch { /* ignore */ }
    setStatsLoading(false);
  }, []);

  useEffect(() => { fetchRules(); fetchStats(); }, [fetchRules, fetchStats]);

  const handleSave = async (data: Partial<FunnelRule>): Promise<string | null> => {
    const method = data.id ? "PUT" : "POST";
    const res = await fetch("/api/funnel/rules", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Erro desconhecido" }));
      return err.error || "Erro ao salvar";
    }
    setEditingRule(undefined);
    fetchRules();
    fetchStats();
    return null;
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Deletar esta regra?")) return;
    await fetch("/api/funnel/rules", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    fetchRules();
    fetchStats();
  };

  const handleToggle = async (rule: FunnelRule) => {
    await fetch("/api/funnel/rules", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: rule.id, active: !rule.active }),
    });
    fetchRules();
    fetchStats();
  };

  const activeCount = rules.filter((r) => r.active).length;

  if (loading) return (
    <div className="flex items-center justify-center py-12 text-gray-500 text-sm">
      <span className="animate-pulse">Carregando automações...</span>
    </div>
  );

  const totals = stats?.totals;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-bold text-white">⚡ Automações</h2>
          {rules.length > 0 && (
            <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${
              activeCount > 0 ? "bg-green-900/40 text-green-400 border border-green-800/50" : "bg-gray-800 text-gray-500 border border-gray-700/50"
            }`}>
              {activeCount > 0 ? `${activeCount} ativa${activeCount > 1 ? "s" : ""}` : "Nenhuma ativa"}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 w-full sm:w-auto">
          <button
            onClick={() => setEditingRule(null)}
            className="flex-1 sm:flex-none px-3 py-2 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-xs font-medium transition-colors"
          >
            + Nova regra
          </button>
        </div>
      </div>

      {/* Summary cards */}
      {(totals || statsLoading) && (
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-gray-800/30 border border-gray-700/40 rounded-xl px-4 py-3">
            <p className="text-xs text-gray-500 mb-1">Total enviados</p>
            <p className="text-2xl font-bold text-white">
              {statsLoading ? <span className="text-gray-600 text-base animate-pulse">—</span> : (totals?.sent ?? 0)}
            </p>
          </div>
          <div className="bg-gray-800/30 border border-gray-700/40 rounded-xl px-4 py-3">
            <p className="text-xs text-gray-500 mb-1">Enviados hoje</p>
            <p className="text-2xl font-bold text-indigo-400">
              {statsLoading ? <span className="text-gray-600 text-base animate-pulse">—</span> : (totals?.today ?? 0)}
            </p>
          </div>
          <div className="bg-gray-800/30 border border-gray-700/40 rounded-xl px-4 py-3">
            <p className="text-xs text-gray-500 mb-1">Falhas</p>
            <p className="text-2xl font-bold text-red-400/80">
              {statsLoading ? <span className="text-gray-600 text-base animate-pulse">—</span> : (totals?.failed ?? 0)}
            </p>
          </div>
        </div>
      )}

      {/* Rules list */}
      {rules.length === 0 ? (
        <div className="bg-gray-800/20 border border-gray-700/40 rounded-2xl p-10 text-center">
          <p className="text-2xl mb-3">⚡</p>
          <p className="text-gray-300 font-medium mb-1">Nenhuma regra configurada</p>
          <p className="text-sm text-gray-500">Crie regras para enviar SMS e emails automáticos quando usuários pararem no funil</p>
          <button
            onClick={() => setEditingRule(null)}
            className="mt-4 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 rounded-xl text-sm font-medium transition-colors"
          >
            Criar primeira regra
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {rules.map((rule) => {
            const triggerId = getTriggerFromRule(rule);
            const trigger = getTrigger(triggerId);
            const delayHours = rule.delay_minutes >= 60 && rule.delay_minutes % 60 === 0;
            const delayLabel = delayHours
              ? `${rule.delay_minutes / 60}h`
              : `${rule.delay_minutes}min`;
            const ruleStats = stats?.byRule[rule.id];

            return (
              <div
                key={rule.id}
                className={`rounded-2xl border transition-all ${
                  rule.active
                    ? "bg-gray-800/30 border-green-800/40"
                    : "bg-gray-800/15 border-gray-700/40"
                }`}
              >
                {/* Top row: toggle + info + actions */}
                <div className="flex items-center gap-3 px-4 pt-3.5 pb-3">
                  {/* Toggle */}
                  <button
                    onClick={() => handleToggle(rule)}
                    className={`relative w-11 h-6 rounded-full transition-colors flex-shrink-0 ${
                      rule.active ? "bg-green-600" : "bg-gray-600"
                    }`}
                  >
                    <div className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                      rule.active ? "translate-x-6" : "translate-x-1"
                    }`} />
                  </button>

                  {/* Trigger icon */}
                  <span className="text-xl flex-shrink-0">{trigger.icon}</span>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5 text-sm">
                      <span className={`font-medium ${rule.active ? "text-white" : "text-gray-400"}`}>{trigger.label}</span>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-xs text-gray-500">após {delayLabel}</span>
                      <span className="text-gray-700">·</span>
                      <span className="text-xs text-gray-500">{CHANNEL_ICONS[rule.channel]} {rule.channel === "both" ? "Email + SMS" : rule.channel.toUpperCase()}</span>
                      {rule.subject && (
                        <>
                          <span className="text-gray-700">·</span>
                          <span className="text-xs text-gray-500 truncate max-w-[180px]">{rule.subject}</span>
                        </>
                      )}
                    </div>
                    {rule.filters && (() => {
                      const tags = [
                        ...(rule.filters.professions || []),
                        ...(rule.filters.softwares || []),
                        ...(rule.filters.interests || []),
                      ];
                      return tags.length > 0 ? (
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {tags.map(tag => (
                            <span key={tag} className="px-1.5 py-0.5 bg-indigo-900/30 border border-indigo-700/40 rounded text-[10px] text-indigo-400">
                              {tag}
                            </span>
                          ))}
                        </div>
                      ) : null;
                    })()}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      onClick={() => setEditingRule(rule)}
                      className="text-gray-500 hover:text-gray-200 p-1.5 rounded-lg hover:bg-gray-700/60 transition-colors text-sm"
                    >
                      ✏️
                    </button>
                    <button
                      onClick={() => handleDelete(rule.id)}
                      className="text-gray-500 hover:text-red-400 p-1.5 rounded-lg hover:bg-red-900/20 transition-colors text-sm"
                    >
                      🗑️
                    </button>
                  </div>
                </div>

                {/* Stats row */}
                <div className="flex items-center gap-0 border-t border-gray-700/30 divide-x divide-gray-700/30">
                  <button
                    onClick={() => !statsLoading && setDetailModal({ ruleId: rule.id, type: "enviadas" })}
                    className="flex-1 px-4 py-2.5 text-center hover:bg-gray-700/20 transition-colors rounded-bl-2xl"
                  >
                    <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Enviadas</p>
                    <p className={`text-sm font-semibold ${ruleStats?.sent ? "text-green-400" : "text-gray-500"}`}>
                      {statsLoading ? "—" : (ruleStats?.sent ?? 0)}
                    </p>
                  </button>
                  <button
                    onClick={() => !statsLoading && setDetailModal({ ruleId: rule.id, type: "pendentes" })}
                    className="flex-1 px-4 py-2.5 text-center hover:bg-gray-700/20 transition-colors"
                  >
                    <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Pendentes</p>
                    <p className={`text-sm font-semibold ${ruleStats?.pendentes ? "text-amber-400" : "text-gray-500"}`}>
                      {statsLoading ? "—" : (ruleStats?.pendentes ?? 0)}
                    </p>
                  </button>
                  <button
                    onClick={() => !statsLoading && setDetailModal({ ruleId: rule.id, type: "falhas" })}
                    className="flex-1 px-4 py-2.5 text-center hover:bg-gray-700/20 transition-colors"
                  >
                    <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Falhas</p>
                    <p className={`text-sm font-semibold ${ruleStats?.failed ? "text-red-400" : "text-gray-500"}`}>
                      {statsLoading ? "—" : (ruleStats?.failed ?? 0)}
                    </p>
                  </button>
                  <div className="flex-1 px-4 py-2.5 text-center">
                    <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Última exec.</p>
                    <p className="text-[11px] font-medium text-gray-400">
                      {statsLoading ? "—" : ruleStats?.lastSent ? formatDate(ruleStats.lastSent) : <span className="text-gray-600">nunca</span>}
                    </p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Rule form modal */}
      {editingRule !== undefined && (
        <RuleFormModal
          rule={editingRule}
          onSave={handleSave}
          onClose={() => setEditingRule(undefined)}
        />
      )}

      {/* Rule detail modal */}
      {detailModal && (
        <RuleDetailModal
          ruleId={detailModal.ruleId}
          type={detailModal.type}
          onClose={() => setDetailModal(null)}
        />
      )}
    </div>
  );
}

// ── User Actions List (for user detail modal) ──────────────
export function UserActionsList({ email }: { email: string }) {
  const [actions, setActions] = useState<FunnelAction[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!email) return;
    fetch(`/api/funnel/actions?email=${encodeURIComponent(email)}`)
      .then((r) => r.json())
      .then((data) => {
        setActions(Array.isArray(data) ? data : []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [email]);

  if (loading) return <p className="text-xs text-gray-500">Carregando ações...</p>;
  if (actions.length === 0) return null;

  return (
    <div className="mt-2 pt-2 border-t border-gray-700/50">
      <p className="text-xs text-gray-500 mb-1">📋 Ações enviadas:</p>
      {actions.map((a) => (
        <div key={a.id} className="flex items-center gap-2 text-xs text-gray-400">
          <span>{a.channel === "email" ? "📧" : "📱"}</span>
          <span className={a.status === "sent" ? "text-green-400" : "text-red-400"}>
            {a.status === "sent" ? "✓" : "✗"}
          </span>
          <span>{formatDate(a.created_at)}</span>
          {a.metadata?.subject && <span className="truncate text-gray-500">— {String(a.metadata.subject)}</span>}
        </div>
      ))}
    </div>
  );
}

export { wrapEmailHTML };
