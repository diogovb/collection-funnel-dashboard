"use client";

import { useState, useEffect, useCallback } from "react";

interface FunnelRule {
  id: string;
  stage: string;
  next_stage: string | null;
  delay_minutes: number;
  channel: string;
  subject: string | null;
  content: string;
  content_type: string;
  dynamic_action: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
  priority: number;
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

const STAGES = [
  { key: "signup_completed", label: "Cadastro" },
  { key: "first_download", label: "Primeiro Download" },
  { key: "checkout_completed", label: "Pagamento" },
];

const CHANNEL_ICONS: Record<string, string> = {
  email: "📧",
  sms: "📱",
  both: "📧📱",
};

const STAGE_LABEL = (key: string) => STAGES.find((s) => s.key === key)?.label || key;

function formatDate(d: string) {
  return new Date(d).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

// ── Email Template (same as Dunning) ──────────────────────
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

// ── Test Modal ─────────────────────────────────────────────
function TestModal({
  channel,
  subject,
  content,
  onClose,
}: {
  channel: string;
  subject: string;
  content: string;
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
        body: JSON.stringify({
          channel,
          email: testEmail,
          phone: testPhone,
          subject,
          content,
        }),
      });
      const data = await res.json();
      setResult(data.success ? "✅ Enviado com sucesso!" : `❌ ${data.error || "Erro"}`);
    } catch {
      setResult("❌ Erro ao enviar");
    }
    setSending(false);
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-[60]">
      <div className="bg-gray-900 rounded-2xl w-full max-w-md border border-gray-700">
        <div className="flex items-center justify-between p-5 border-b border-gray-700">
          <h3 className="text-lg font-semibold">🧪 Testar envio</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white">✕</button>
        </div>
        <div className="p-5 space-y-4">
          {(channel === "email" || channel === "both") && (
            <div>
              <label className="block text-sm text-gray-400 mb-1">Email de teste</label>
              <input type="email" value={testEmail} onChange={(e) => setTestEmail(e.target.value)}
                placeholder="seu@email.com"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm" />
            </div>
          )}
          {(channel === "sms" || channel === "both") && (
            <div>
              <label className="block text-sm text-gray-400 mb-1">Telefone de teste</label>
              <input type="tel" value={testPhone} onChange={(e) => setTestPhone(e.target.value)}
                placeholder="(11) 99999-9999"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm" />
            </div>
          )}
          {result && <p className="text-sm">{result}</p>}
        </div>
        <div className="flex justify-end gap-3 p-5 border-t border-gray-700">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white">Fechar</button>
          <button onClick={handleTest} disabled={sending || (!testEmail && !testPhone)}
            className="px-6 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded-lg text-sm font-medium">
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
  onSave: (data: Partial<FunnelRule>) => Promise<void>;
  onClose: () => void;
}) {
  const [stage, setStage] = useState(rule?.stage || "signup_completed");
  const [nextStage, setNextStage] = useState(rule?.next_stage || "onboarding_completed");
  const [delay, setDelay] = useState(rule?.delay_minutes || 30);
  const [channel, setChannel] = useState(rule?.channel || "email");
  const [subject, setSubject] = useState(rule?.subject || "");
  const [content, setContent] = useState(rule?.content || "");
  const [saving, setSaving] = useState(false);
  const [showTest, setShowTest] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    await onSave({
      ...(rule?.id ? { id: rule.id } : {}),
      stage,
      next_stage: nextStage,
      delay_minutes: delay,
      channel,
      subject: channel !== "sms" ? subject : null,
      content,
      content_type: "custom",
      active: rule?.active ?? false,
    });
    setSaving(false);
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-0 sm:p-4 z-50">
        <div className="bg-gray-900 sm:rounded-2xl w-full h-full sm:h-auto sm:max-w-2xl sm:max-h-[90vh] overflow-y-auto border-0 sm:border border-gray-700">
          <div className="flex items-center justify-between p-4 sm:p-5 border-b border-gray-700">
            <h3 className="text-base sm:text-lg font-semibold">{rule?.id ? "Editar Regra" : "Nova Regra"}</h3>
            <button onClick={onClose} className="text-gray-400 hover:text-white text-lg">✕</button>
          </div>

          <div className="p-4 sm:p-5 space-y-4">
            {/* Stage */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Quando chegar em</label>
                <select value={stage} onChange={(e) => setStage(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm">
                  {STAGES.map((s) => (
                    <option key={s.key} value={s.key}>{s.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">E não avançar para</label>
                <select value={nextStage} onChange={(e) => setNextStage(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm">
                  {STAGES.map((s) => (
                    <option key={s.key} value={s.key}>{s.label}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Delay + Channel */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Após (minutos)</label>
                <input type="number" value={delay} onChange={(e) => setDelay(Number(e.target.value))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm" min={1} />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Canal</label>
                <div className="flex gap-2">
                  {(["email", "sms", "both"] as const).map((ch) => (
                    <button key={ch} onClick={() => setChannel(ch)}
                      className={`flex-1 py-2.5 rounded-lg text-xs sm:text-sm font-medium transition-colors ${
                        channel === ch ? "bg-indigo-600 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700"
                      }`}>
                      {CHANNEL_ICONS[ch]} {ch === "both" ? "Ambos" : ch.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Subject (email only) */}
            {channel !== "sms" && (
              <div>
                <label className="block text-sm text-gray-400 mb-1">Assunto do email</label>
                <input type="text" value={subject} onChange={(e) => setSubject(e.target.value)}
                  placeholder="Ex: Falta pouco! Complete seu cadastro"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm" />
              </div>
            )}

            {/* Content */}
            <div>
              <label className="block text-sm text-gray-400 mb-1">
                {channel === "sms" ? "Mensagem SMS (máx 160 chars)" : "Conteúdo do email (HTML)"}
              </label>
              <textarea value={content} onChange={(e) => setContent(e.target.value)}
                rows={channel === "sms" ? 3 : 6}
                maxLength={channel === "sms" ? 160 : undefined}
                placeholder={channel === "sms"
                  ? "Oi {{name}}! Sua conta Collection está quase pronta..."
                  : "<h2>Oi {{name}}!</h2><p>Falta pouco para você começar a usar a Collection...</p>"}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm font-mono" />
              <p className="text-xs text-gray-500 mt-1">
                Variáveis: {"{{name}}"}, {"{{email}}"}, {"{{phone}}"}
                {channel === "sms" && ` — ${content.length}/160`}
              </p>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row justify-between gap-3 p-4 sm:p-5 border-t border-gray-700">
            <button onClick={() => setShowTest(true)} disabled={!content}
              className="px-4 py-2.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors order-2 sm:order-1">
              🧪 Testar envio
            </button>
            <div className="flex gap-3 order-1 sm:order-2">
              <button onClick={onClose} className="flex-1 sm:flex-none px-4 py-2.5 text-sm text-gray-400 hover:text-white">Cancelar</button>
              <button onClick={handleSave} disabled={saving || !content}
                className="flex-1 sm:flex-none px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors">
                {saving ? "Salvando..." : "Salvar"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {showTest && (
        <TestModal channel={channel} subject={subject} content={content} onClose={() => setShowTest(false)} />
      )}
    </>
  );
}

// ── Main Panel ─────────────────────────────────────────────
export default function AutomationPanel() {
  const [rules, setRules] = useState<FunnelRule[]>([]);
  const [editingRule, setEditingRule] = useState<FunnelRule | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [lastResult, setLastResult] = useState<string | null>(null);

  const fetchRules = useCallback(async () => {
    try {
      const res = await fetch("/api/funnel/rules");
      if (res.ok) setRules(await res.json());
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetchRules(); }, [fetchRules]);

  const handleSave = async (data: Partial<FunnelRule>) => {
    const method = data.id ? "PUT" : "POST";
    await fetch("/api/funnel/rules", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    setEditingRule(undefined);
    fetchRules();
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Deletar esta regra?")) return;
    await fetch("/api/funnel/rules", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    fetchRules();
  };

  const handleToggle = async (rule: FunnelRule) => {
    await fetch("/api/funnel/rules", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: rule.id, active: !rule.active }),
    });
    fetchRules();
  };

  const handleProcess = async () => {
    setProcessing(true);
    setLastResult(null);
    try {
      const res = await fetch("/api/funnel/process", { method: "POST" });
      const data = await res.json();
      setLastResult(`✅ ${data.sent || 0} enviados, ${data.failed || 0} falharam`);
    } catch {
      setLastResult("❌ Erro ao processar");
    }
    setProcessing(false);
  };

  const activeCount = rules.filter((r) => r.active).length;

  const toggleAll = async () => {
    const newState = activeCount === 0;
    for (const rule of rules) {
      await fetch("/api/funnel/rules", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: rule.id, active: newState }),
      });
    }
    fetchRules();
  };

  if (loading) return <div className="text-gray-500 text-center py-8">Carregando automações...</div>;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-lg sm:text-xl font-bold">⚡ Automações</h2>
          {rules.length > 0 && (
            <span className={`px-3 py-1 rounded-full text-xs font-medium ${
              activeCount > 0 ? "bg-green-900/50 text-green-400" : "bg-gray-800 text-gray-400"
            }`}>
              {activeCount > 0 ? `${activeCount} ativa${activeCount > 1 ? "s" : ""}` : "Nenhuma ativa"}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 w-full sm:w-auto">
          <button onClick={() => setEditingRule(null)}
            className="flex-1 sm:flex-none px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-xs sm:text-sm font-medium transition-colors">
            + Nova regra
          </button>
        </div>
      </div>

      {lastResult && (
        <div className="bg-gray-800/50 rounded-lg px-4 py-2 text-sm">{lastResult}</div>
      )}

      {/* Rules */}
      {rules.length === 0 ? (
        <div className="bg-gray-800/30 rounded-xl p-6 sm:p-8 text-center text-gray-500">
          <p className="text-base sm:text-lg mb-2">Nenhuma regra configurada</p>
          <p className="text-xs sm:text-sm">Crie regras para enviar SMS e emails automáticos quando usuários pararem no funil</p>
        </div>
      ) : (
        <div className="grid gap-3">
          {rules.map((rule) => (
            <div key={rule.id} className={`bg-gray-800/50 rounded-xl p-3 sm:p-4 border transition-colors ${
              rule.active ? "border-green-800/50" : "border-gray-700/50"
            }`}>
              <div className="flex items-start sm:items-center justify-between gap-2">
                <div className="flex items-start sm:items-center gap-2 sm:gap-3 flex-1 min-w-0">
                  {/* Toggle */}
                  <button onClick={() => handleToggle(rule)}
                    className={`w-10 h-5 sm:w-12 sm:h-6 rounded-full transition-colors flex items-center px-0.5 sm:px-1 flex-shrink-0 mt-0.5 sm:mt-0 ${
                      rule.active ? "bg-green-600" : "bg-gray-600"
                    }`}>
                    <div className={`w-4 h-4 bg-white rounded-full transition-transform ${
                      rule.active ? "translate-x-5 sm:translate-x-6" : "translate-x-0"
                    }`} />
                  </button>

                  {/* Info */}
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1 sm:gap-2 text-xs sm:text-sm">
                      <span className="font-medium text-indigo-400">{STAGE_LABEL(rule.stage)}</span>
                      <span className="text-gray-500">→</span>
                      <span className="text-gray-400">{rule.next_stage ? STAGE_LABEL(rule.next_stage) : "—"}</span>
                      <span className="hidden sm:inline text-gray-600">|</span>
                      <span className="text-gray-400">{rule.delay_minutes}min</span>
                      <span>{CHANNEL_ICONS[rule.channel]}</span>
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5 line-clamp-1 break-all">
                      {rule.subject && `📌 ${rule.subject} — `}
                      {rule.content.replace(/<[^>]*>/g, "").substring(0, 50)}…
                    </p>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button onClick={() => setEditingRule(rule)}
                    className="text-gray-400 hover:text-white text-sm p-1.5">✏️</button>
                  <button onClick={() => handleDelete(rule.id)}
                    className="text-gray-400 hover:text-red-400 text-sm p-1.5">🗑️</button>
                </div>
              </div>
            </div>
          ))}
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

// Export the email wrapper for use in process route
export { wrapEmailHTML };
