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
  { key: "email_confirmed", label: "Email Confirmado" },
  { key: "onboarding_started", label: "Onboarding Iniciado" },
  { key: "onboarding_completed", label: "Onboarding Completo" },
  { key: "installer_login", label: "Login no Instalador" },
  { key: "plugin_installed", label: "Plugin Instalado" },
  { key: "first_download", label: "Primeiro Download" },
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
  const [nextStage, setNextStage] = useState(rule?.next_stage || "email_confirmed");
  const [delay, setDelay] = useState(rule?.delay_minutes || 30);
  const [channel, setChannel] = useState(rule?.channel || "email");
  const [subject, setSubject] = useState(rule?.subject || "");
  const [content, setContent] = useState(rule?.content || "");
  const [saving, setSaving] = useState(false);

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
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-0 sm:p-4 z-50">
      <div className="bg-gray-900 sm:rounded-2xl w-full h-full sm:h-auto sm:max-w-2xl sm:max-h-[90vh] overflow-y-auto border-0 sm:border border-gray-700">
        <div className="flex items-center justify-between p-5 border-b border-gray-700">
          <h3 className="text-lg font-semibold">{rule?.id ? "Editar Regra" : "Nova Regra"}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white">✕</button>
        </div>

        <div className="p-5 space-y-4">
          {/* Stage */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Quando o usuário chegar em</label>
              <select value={stage} onChange={(e) => setStage(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm">
                {STAGES.map((s) => (
                  <option key={s.key} value={s.key}>{s.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">E não avançar para</label>
              <select value={nextStage} onChange={(e) => setNextStage(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm">
                {STAGES.map((s) => (
                  <option key={s.key} value={s.key}>{s.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Delay + Channel */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Após (minutos)</label>
              <input type="number" value={delay} onChange={(e) => setDelay(Number(e.target.value))}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm" min={1} />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Canal</label>
              <div className="flex gap-2">
                {(["email", "sms", "both"] as const).map((ch) => (
                  <button key={ch} onClick={() => setChannel(ch)}
                    className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
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
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm" />
            </div>
          )}

          {/* Content */}
          <div>
            <label className="block text-sm text-gray-400 mb-1">
              {channel === "sms" ? "Mensagem SMS (máx 160 chars)" : "Conteúdo do email (HTML)"}
            </label>
            <textarea value={content} onChange={(e) => setContent(e.target.value)}
              rows={channel === "sms" ? 3 : 8}
              maxLength={channel === "sms" ? 160 : undefined}
              placeholder={channel === "sms" 
                ? "Oi {{name}}! Sua conta Collection está quase pronta..." 
                : "<h2>Oi {{name}}!</h2><p>Falta pouco para você começar...</p>"}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono" />
            <p className="text-xs text-gray-500 mt-1">
              Variáveis: {"{{name}}"}, {"{{email}}"}, {"{{phone}}"}
              {channel === "sms" && ` — ${content.length}/160 chars`}
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-3 p-5 border-t border-gray-700">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white">Cancelar</button>
          <button onClick={handleSave} disabled={saving || !content}
            className="px-6 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors">
            {saving ? "Salvando..." : "Salvar"}
          </button>
        </div>
      </div>
    </div>
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

  const allPaused = rules.every((r) => !r.active);

  const toggleAll = async () => {
    const newState = allPaused;
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
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-bold">⚡ Automações</h2>
          <span className={`px-3 py-1 rounded-full text-xs font-medium ${
            allPaused ? "bg-yellow-900/50 text-yellow-400" : "bg-green-900/50 text-green-400"
          }`}>
            {allPaused ? "⏸️ Pausado" : "▶️ Ativo"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {rules.length > 0 && (
            <button onClick={toggleAll}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                allPaused 
                  ? "bg-green-600 hover:bg-green-700 text-white" 
                  : "bg-yellow-600 hover:bg-yellow-700 text-white"
              }`}>
              {allPaused ? "▶️ Ativar tudo" : "⏸️ Pausar tudo"}
            </button>
          )}
          <button onClick={handleProcess} disabled={processing || allPaused}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors">
            {processing ? "Processando..." : "🔄 Rodar agora"}
          </button>
          <button onClick={() => setEditingRule(null)}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm font-medium transition-colors">
            + Nova regra
          </button>
        </div>
      </div>

      {lastResult && (
        <div className="bg-gray-800/50 rounded-lg px-4 py-2 text-sm">{lastResult}</div>
      )}

      {/* Rules */}
      {rules.length === 0 ? (
        <div className="bg-gray-800/30 rounded-xl p-8 text-center text-gray-500">
          <p className="text-lg mb-2">Nenhuma regra configurada</p>
          <p className="text-sm">Crie regras para enviar SMS e emails automáticos baseados no progresso do funil</p>
        </div>
      ) : (
        <div className="grid gap-3">
          {rules.map((rule) => (
            <div key={rule.id} className={`bg-gray-800/50 rounded-xl p-4 border transition-colors ${
              rule.active ? "border-green-800/50" : "border-gray-700/50"
            }`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  {/* Toggle */}
                  <button onClick={() => handleToggle(rule)}
                    className={`w-12 h-6 rounded-full transition-colors flex items-center px-1 ${
                      rule.active ? "bg-green-600" : "bg-gray-600"
                    }`}>
                    <div className={`w-4 h-4 bg-white rounded-full transition-transform ${
                      rule.active ? "translate-x-6" : "translate-x-0"
                    }`} />
                  </button>

                  {/* Info */}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-medium text-indigo-400">{STAGE_LABEL(rule.stage)}</span>
                      <span className="text-gray-500">→</span>
                      <span className="text-gray-400">{rule.next_stage ? STAGE_LABEL(rule.next_stage) : "—"}</span>
                      <span className="text-gray-600">|</span>
                      <span className="text-gray-400">{rule.delay_minutes}min</span>
                      <span className="text-gray-600">|</span>
                      <span>{CHANNEL_ICONS[rule.channel]}</span>
                    </div>
                    <p className="text-xs text-gray-500 truncate mt-1">
                      {rule.subject && `📌 ${rule.subject} — `}
                      {rule.content.replace(/<[^>]*>/g, "").substring(0, 80)}...
                    </p>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 ml-3">
                  <button onClick={() => setEditingRule(rule)}
                    className="text-gray-400 hover:text-white text-sm px-2 py-1">✏️</button>
                  <button onClick={() => handleDelete(rule.id)}
                    className="text-gray-400 hover:text-red-400 text-sm px-2 py-1">🗑️</button>
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
          {a.metadata?.subject && <span className="truncate text-gray-500">— {a.metadata.subject}</span>}
        </div>
      ))}
    </div>
  );
}
