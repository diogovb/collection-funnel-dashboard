"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { supabase } from "@/lib/supabase";
import AutomationPanel, { UserActionsList } from "@/components/AutomationPanel";

// ── Onboarding Steps (the ONLY funnel now) ─────────────────────
// Pre-split steps (shared by all users)
const PRE_SPLIT_STEPS = [
  { key: "onboarding_started", label: "Nome", icon: "📝", fields: ["name", "profession"] },
  { key: "onboarding_step_welcome", label: "Boas-vindas", icon: "👋", fields: [] },
  { key: "onboarding_step_intent", label: "Jornada", icon: "🎯", fields: ["intent"] },
  { key: "onboarding_step_experience", label: "Experiência", icon: "✨", fields: ["intent"] },
  { key: "onboarding_step_account_creation", label: "Tela Cadastro", icon: "📋", fields: [] },
  { key: "signup_completed", label: "Cadastrou", icon: "🔑", fields: ["email", "phone"] },
  { key: "onboarding_method_selected", label: "Método", icon: "🧩", fields: ["method"] },
] as const;

// Split: Plans + Payment (two branches: free vs paid)
const PLAN_STEPS = [
  { key: "onboarding_step_plans", label: "Planos", icon: "💳", fields: ["plan"] },
  { key: "checkout_completed", label: "Pagamento", icon: "💰", fields: ["plan"] },
] as const;

// Post-split steps (shared again)
const POST_SPLIT_STEPS = [
  { key: "onboarding_step_workshop", label: "Workshop", icon: "🎓", fields: [] },
  { key: "onboarding_step_install", label: "Acesso", icon: "🚀", fields: ["method"] },
  { key: "onboarding_completed", label: "Completo", icon: "✅", fields: [] },
] as const;

// Combined for backwards compat
const STEPS = [...PRE_SPLIT_STEPS, ...PLAN_STEPS, ...POST_SPLIT_STEPS] as const;

// Plugin-only sub-steps (right branch)
const PLUGIN_STEPS = [
  { key: "installer_login", label: "Login Instalador", icon: "🔐", fields: [] },
  { key: "plugin_installed", label: "Plugin Instalado", icon: "🔌", fields: [] },
] as const;

// Convergence steps (both paths lead here)
const CONVERGE_STEPS = [
  { key: "first_download", label: "1º Download", icon: "📥", fields: [] },
] as const;

// All steps combined (for user journey tracking)
const ALL_STEPS = [...STEPS, ...PLUGIN_STEPS, ...CONVERGE_STEPS] as const;

type StepKey = (typeof ALL_STEPS)[number]["key"];

const STEP_COLORS = [
  "#6366f1", "#7c3aed", "#8b5cf6", "#a78bfa", "#c084fc",
  "#d946ef", "#ec4899", "#f43f5e", "#f97316", "#eab308", "#10b981",
];

const PIE_COLORS = [
  "#3B82F6", "#8B5CF6", "#EC4899", "#F59E0B", "#10B981",
  "#F97316", "#EF4444", "#6366F1", "#84CC16", "#06B6D4",
];

const PROFESSION_LABELS: Record<string, string> = {
  arquiteto: "Arquiteto(a)",
  designer_interiores: "Designer de Interiores",
  engenheiro: "Engenheiro(a)",
  projetista: "Projetista",
  estudante: "Estudante",
  outro: "Outro",
};

const INTENT_LABELS: Record<string, string> = {
  biblioteca: "Blocos 3D",
  render: "Render IA",
  apresentacao: "Apresentações",
  explorar: "Explorar tudo",
};

// ── Types ──────────────────────────────────────────────────────
interface FunnelEvent {
  id: string;
  user_id: string;
  email: string;
  event: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

interface UserJourney {
  key: string; // email || user_id || session_id
  name: string;
  email: string;
  phone: string;
  profession: string;
  intent: string;
  method: string;
  plan: string; // raw: "premium_anual_pix"
  planName: string; // "premium", "basico", "expert", "teste"
  period: string; // "anual", "mensal", ""
  paymentMethod: string; // "pix", "cartao", ""
  platform: string;
  signupMethod: string; // "google" | "email" | ""
  stepsCompleted: Set<string>;
  lastStep: string;
  lastStepLabel: string;
  firstSeen: string;
  lastSeen: string;
  allEvents: FunnelEvent[];
}

type DatePreset = "today" | "7d" | "30d" | "90d" | "custom";

// ── Helpers ────────────────────────────────────────────────────
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("pt-BR", {
    day: "2-digit", month: "2-digit", year: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function pct(a: number, b: number): string {
  if (b === 0) return "—";
  return ((a / b) * 100).toFixed(1) + "%";
}

// ── Component ──────────────────────────────────────────────────
export default function Dashboard() {
  const [events, setEvents] = useState<FunnelEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [preset, setPreset] = useState<DatePreset>("today");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [searchTerm, setSearchTerm] = useState("");
  const [userPage, setUserPage] = useState(0);
  const [selectedUser, setSelectedUser] = useState<UserJourney | null>(null);
  const [selectedStep, setSelectedStep] = useState<string | null>(null);
  const [deletingUser, setDeletingUser] = useState<string | null>(null);
  const USERS_PER_PAGE = 20;

  const dateFrom = useMemo(() => {
    if (preset === "today") { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString(); }
    if (preset === "7d") return daysAgo(7);
    if (preset === "30d") return daysAgo(30);
    if (preset === "90d") return daysAgo(90);
    if (preset === "custom" && customFrom) return new Date(customFrom).toISOString();
    return daysAgo(30);
  }, [preset, customFrom]);

  const dateTo = useMemo(() => {
    if (preset === "custom" && customTo) return new Date(customTo + "T23:59:59").toISOString();
    return new Date().toISOString();
  }, [preset, customTo]);

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    fetch("/api/sync-downloads").catch(() => {});
    const { data, error } = await supabase
      .from("funnel_events")
      .select("*")
      .gte("created_at", dateFrom)
      .lte("created_at", dateTo)
      .order("created_at", { ascending: true });
    if (!error && data) setEvents(data as FunnelEvent[]);
    setLastRefresh(new Date());
    setLoading(false);
  }, [dateFrom, dateTo]);

  useEffect(() => { fetchEvents(); }, [fetchEvents]);
  useEffect(() => {
    const interval = setInterval(fetchEvents, 30_000);
    return () => clearInterval(interval);
  }, [fetchEvents]);

  // ── Build user journeys ──────────────────────────────────────
  const journeys = useMemo(() => {
    // Cross-reference user_id ↔ email ↔ session_id
    const uidToEmail = new Map<string, string>();
    const sidToEmail = new Map<string, string>();
    const sidToUid = new Map<string, string>();

    for (const ev of events) {
      const sid = (ev.metadata as any)?.session_id;
      if (ev.user_id && ev.email) uidToEmail.set(ev.user_id, ev.email);
      if (sid && ev.email) sidToEmail.set(sid, ev.email);
      if (sid && ev.user_id) sidToUid.set(sid, ev.user_id);
    }

    // Enrich events
    const enriched = events.map(ev => {
      let email = ev.email;
      let userId = ev.user_id;
      const sid = (ev.metadata as any)?.session_id;
      if (!email && userId) email = uidToEmail.get(userId) || "";
      if (!email && sid) email = sidToEmail.get(sid) || "";
      if (!userId && sid) userId = sidToUid.get(sid) || "";
      return { ...ev, email, user_id: userId };
    });

    // Group by canonical key (email > user_id > session_id)
    const map = new Map<string, UserJourney>();
    for (const ev of enriched) {
      const sid = (ev.metadata as any)?.session_id;
      const key = ev.email || ev.user_id || sid || ev.id;
      if (!key) continue;

      if (!map.has(key)) {
        map.set(key, {
          key,
          name: "", email: "", phone: "", profession: "", intent: "", method: "", plan: "", planName: "", period: "", paymentMethod: "", platform: "", signupMethod: "",
          stepsCompleted: new Set(),
          lastStep: "", lastStepLabel: "",
          firstSeen: ev.created_at,
          lastSeen: ev.created_at,
          allEvents: [],
        });
      }
      const j = map.get(key)!;
      j.allEvents.push(ev);

      // Extract metadata fields
      const m = (ev.metadata || {}) as any;
      if (m.name && !j.name) j.name = m.name;
      if (ev.email && !j.email) j.email = ev.email;
      if (m.phone && !j.phone) j.phone = m.phone;
      if (m.profession && !j.profession) j.profession = m.profession;
      if (m.intent && !j.intent) j.intent = m.intent;
      if (m.method && !j.method && ev.event === "onboarding_method_selected") j.method = m.method;
      if (m.method && !j.signupMethod && ev.event === "signup_completed") j.signupMethod = m.method; // "google" | "email"
      // Plan comes from checkout_completed (actual payment) or onboarding_offer_skipped, not abandoned
      if (m.plan && (ev.event === "checkout_completed" || ev.event === "onboarding_offer_skipped")) {
        j.plan = m.plan;
        // New enriched fields (if present)
        if (m.plan_name) j.planName = m.plan_name;
        if (m.period) j.period = m.period;
        if (m.payment_method) j.paymentMethod = m.payment_method;
        // Fallback: parse from plan string "premium_anual_pix"
        if (!j.planName && m.plan) {
          const parts = (m.plan as string).split("_");
          j.planName = parts[0] || "";
          j.period = parts[1] === "anual" ? "anual" : parts[1] === "mensal" ? "mensal" : "";
          j.paymentMethod = (m.plan as string).includes("_pix") ? "pix" : (m.plan as string).includes("_stripe") ? "cartao" : m.plan === "teste_gratis" ? "" : "cartao";
        }
      }
      if (m.platform && !j.platform) j.platform = m.platform;

      // Track steps
      if (ALL_STEPS.some(s => s.key === ev.event)) {
        j.stepsCompleted.add(ev.event);
      }

      if (ev.created_at > j.lastSeen) j.lastSeen = ev.created_at;
      if (ev.created_at < j.firstSeen) j.firstSeen = ev.created_at;
    }

    // Compute lastStep
    for (const j of map.values()) {
      for (let i = ALL_STEPS.length - 1; i >= 0; i--) {
        if (j.stepsCompleted.has(ALL_STEPS[i].key)) {
          j.lastStep = ALL_STEPS[i].key;
          j.lastStepLabel = ALL_STEPS[i].label;
          break;
        }
      }
    }

    return Array.from(map.values()).sort(
      (a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime()
    );
  }, [events]);

  // ── Step counts ──────────────────────────────────────────────
  const stepCounts = useMemo(() => {
    return STEPS.map(s => {
      let count = 0;
      for (const j of journeys) {
        if (j.stepsCompleted.has(s.key)) count++;
      }
      return { ...s, count };
    });
  }, [journeys]);

  // ── Split funnel counts ────────────────────────────────────
  const splitCounts = useMemo(() => {
    const webUsers = journeys.filter(j => j.method === "web");
    const pluginUsers = journeys.filter(j => j.method === "plugin");
    // Plan split: free vs paid
    const sawPlans = journeys.filter(j => j.stepsCompleted.has("onboarding_step_plans"));
    const paid = journeys.filter(j => j.stepsCompleted.has("checkout_completed") && j.planName !== "teste");
    const free = journeys.filter(j => j.stepsCompleted.has("checkout_completed") && j.planName === "teste");
    return {
      web: { total: webUsers.length, firstDownload: webUsers.filter(j => j.stepsCompleted.has("first_download")).length },
      plugin: {
        total: pluginUsers.length,
        installerLogin: pluginUsers.filter(j => j.stepsCompleted.has("installer_login")).length,
        pluginInstalled: pluginUsers.filter(j => j.stepsCompleted.has("plugin_installed")).length,
        firstDownload: pluginUsers.filter(j => j.stepsCompleted.has("first_download")).length,
      },
      converge: { firstDownload: journeys.filter(j => j.stepsCompleted.has("first_download")).length },
      plans: { sawPlans: sawPlans.length, paid: paid.length, free: free.length },
    };
  }, [journeys]);

  const maxCount = Math.max(1, ...stepCounts.map(s => s.count));

  // ── Analytics ────────────────────────────────────────────────
  const analytics = useMemo(() => {
    const profs = new Map<string, number>();
    const intents = new Map<string, number>();
    const methods = new Map<string, number>();
    const plans = new Map<string, number>();
    const periods = new Map<string, number>();
    const payMethods = new Map<string, number>();
    const platforms = new Map<string, number>();
    const signupMethods = new Map<string, number>();

    for (const j of journeys) {
      if (j.profession) {
        const label = PROFESSION_LABELS[j.profession] || j.profession;
        profs.set(label, (profs.get(label) || 0) + 1);
      }
      if (j.intent) {
        const label = INTENT_LABELS[j.intent] || j.intent;
        intents.set(label, (intents.get(label) || 0) + 1);
      }
      if (j.method) {
        const label = j.method === "plugin" ? "Plugin SketchUp" : j.method === "web" ? "Biblioteca Web" : j.method;
        methods.set(label, (methods.get(label) || 0) + 1);
      }
      if (j.plan) {
        const pn = j.planName || j.plan.split("_")[0];
        const label = pn.charAt(0).toUpperCase() + pn.slice(1);
        plans.set(label, (plans.get(label) || 0) + 1);
      }
      if (j.period) {
        const label = j.period === "anual" ? "Anual" : "Mensal";
        periods.set(label, (periods.get(label) || 0) + 1);
      }
      if (j.paymentMethod) {
        const label = j.paymentMethod === "pix" ? "PIX" : "Cartão";
        payMethods.set(label, (payMethods.get(label) || 0) + 1);
      }
      if (j.platform) {
        const label = j.platform === "mobile" ? "📱 Mobile" : "🖥️ Desktop";
        platforms.set(label, (platforms.get(label) || 0) + 1);
      }
      if (j.signupMethod) {
        const label = j.signupMethod === "google" ? "Google" : "Email/Senha";
        signupMethods.set(label, (signupMethods.get(label) || 0) + 1);
      }
    }

    return {
      professions: Array.from(profs.entries()).sort((a, b) => b[1] - a[1]),
      intents: Array.from(intents.entries()).sort((a, b) => b[1] - a[1]),
      methods: Array.from(methods.entries()).sort((a, b) => b[1] - a[1]),
      plans: Array.from(plans.entries()).sort((a, b) => b[1] - a[1]),
      periods: Array.from(periods.entries()).sort((a, b) => b[1] - a[1]),
      payMethods: Array.from(payMethods.entries()).sort((a, b) => b[1] - a[1]),
      platforms: Array.from(platforms.entries()).sort((a, b) => b[1] - a[1]),
      signupMethods: Array.from(signupMethods.entries()).sort((a, b) => b[1] - a[1]),
    };
  }, [journeys]);

  // ── Users at a specific step ─────────────────────────────────
  const usersAtStep = useMemo(() => {
    if (!selectedStep) return [];
    // Virtual steps for split cards
    if (selectedStep === "checkout_free") return journeys.filter(j => j.stepsCompleted.has("checkout_completed") && j.planName === "teste");
    if (selectedStep === "checkout_paid") return journeys.filter(j => j.stepsCompleted.has("checkout_completed") && j.planName !== "teste" && j.planName !== "");
    return journeys.filter(j => j.stepsCompleted.has(selectedStep));
  }, [journeys, selectedStep]);

  // ── Filtered users for main list ─────────────────────────────
  const filteredJourneys = useMemo(() => {
    if (!searchTerm) return journeys;
    const q = searchTerm.toLowerCase();
    return journeys.filter(j =>
      j.name?.toLowerCase().includes(q) ||
      j.email?.toLowerCase().includes(q) ||
      j.profession?.toLowerCase().includes(q)
    );
  }, [journeys, searchTerm]);

  const pagedJourneys = filteredJourneys.slice(userPage * USERS_PER_PAGE, (userPage + 1) * USERS_PER_PAGE);
  const totalPages = Math.ceil(filteredJourneys.length / USERS_PER_PAGE);

  // ── Delete user ──────────────────────────────────────────────
  const handleDeleteUser = useCallback(async (email: string, userId?: string) => {
    const id = email || userId || "este usuário";
    if (!confirm(`Deletar todos os eventos de ${id}?`)) return;
    setDeletingUser(id);
    try {
      const res = await fetch("/api/delete-user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email || null, user_id: userId || null }),
      });
      if (res.ok) {
        setSelectedUser(null);
        setSelectedStep(null);
        await fetchEvents();
      }
    } catch {} finally { setDeletingUser(null); }
  }, [fetchEvents]);

  // ── Render ─────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-7xl mx-auto px-3 sm:px-4 py-4 sm:py-8 space-y-4 sm:space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight bg-gradient-to-r from-white to-gray-300 bg-clip-text text-transparent">
              🎯 Onboarding Dashboard
            </h1>
            <p className="text-gray-400 mt-1 text-xs sm:text-base">Collection — Jornada do usuário em tempo real</p>
          </div>
          <div className="flex items-center gap-2 text-sm text-gray-400">
            {loading && <span className="inline-block w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />}
            <span>{lastRefresh.toLocaleTimeString("pt-BR")} · 30s</span>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2">
          {(["today", "7d", "30d", "90d", "custom"] as DatePreset[]).map(p => (
            <button key={p} onClick={() => { setPreset(p); setUserPage(0); }}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                preset === p
                  ? "bg-gradient-to-r from-indigo-600 to-purple-600 text-white shadow-lg"
                  : "bg-gray-800/50 text-gray-300 hover:bg-gray-700/60 border border-gray-700/50"
              }`}>
              {p === "today" ? "Hoje" : p === "7d" ? "7d" : p === "30d" ? "30d" : p === "90d" ? "90d" : "Custom"}
            </button>
          ))}
          {preset === "custom" && (
            <div className="flex items-center gap-2">
              <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)}
                className="bg-gray-800/50 border border-gray-700/50 rounded-lg px-3 py-1.5 text-sm" />
              <span className="text-gray-500">até</span>
              <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)}
                className="bg-gray-800/50 border border-gray-700/50 rounded-lg px-3 py-1.5 text-sm" />
            </div>
          )}
          <button onClick={fetchEvents}
            className="ml-auto px-3 py-1.5 rounded-lg text-sm bg-gray-800/50 text-gray-300 hover:bg-gray-700/60 border border-gray-700/50">
            ↻
          </button>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-4">
          <Card label="Iniciaram" value={stepCounts[0]?.count.toString() || "0"} sub="Preencheram nome" />
          <Card label="Cadastraram" value={stepCounts.find(s => s.key === "signup_completed")?.count.toString() || "0"} sub="Criaram conta" />
          <Card label="Pagaram" value={journeys.filter(j => j.plan && j.plan !== "teste_gratis").length.toString()} sub="Assinaram plano pago" />
          <Card label="Conversão"
            value={pct(journeys.filter(j => j.plan && j.plan !== "teste_gratis").length, stepCounts[0]?.count || 0)}
            sub="Início → Pagamento" />
        </div>

        {/* Analytics pie charts */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-4">
          <PieCard title="Profissão" data={analytics.professions.slice(0, 5)} />
          <PieCard title="Jornada" data={analytics.intents.slice(0, 5)} />
          <PieCard title="Método" data={analytics.methods.slice(0, 5)} />
          <PieCard title="Plano" data={analytics.plans.slice(0, 5)} />
          <PieCard title="Período" data={analytics.periods.slice(0, 5)} />
          <PieCard title="Pagamento" data={analytics.payMethods.slice(0, 5)} />
          <PieCard title="Plataforma" data={analytics.platforms.slice(0, 5)} />
          <PieCard title="Cadastro" data={analytics.signupMethods.slice(0, 5)} />
        </div>

        {/* ── MAIN FUNNEL: Step-by-step onboarding ──────────────── */}
        <div className="bg-gray-900/50 backdrop-blur-sm rounded-2xl p-4 sm:p-6 space-y-4 border border-gray-800/50">
          <div className="flex items-center justify-between">
            <h2 className="text-base sm:text-lg font-semibold">Funil do Onboarding</h2>
            <span className="text-xs text-gray-500">{journeys.length} usuários</span>
          </div>

          <div className="space-y-2">
            {/* Pre-split linear steps */}
            {stepCounts.filter(s => PRE_SPLIT_STEPS.some(ps => ps.key === s.key)).map((step, i) => {
              const widthPct = (step.count / maxCount) * 100;
              const prevCount = i > 0 ? stepCounts[i - 1].count : step.count;
              const dropPct = i > 0 && prevCount > 0 ? Math.round(((prevCount - step.count) / prevCount) * 100) : 0;
              return (
                <div key={step.key} className="group">
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span className="text-base">{step.icon}</span>
                      <span className="text-xs sm:text-sm font-medium text-gray-300">{step.label}</span>
                      <span className="text-sm sm:text-lg font-bold tabular-nums">{step.count}</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                      {i > 0 && dropPct > 0 && <span className="text-red-400">-{dropPct}%</span>}
                      {i > 0 && dropPct === 0 && step.count > 0 && <span className="text-green-400">100%</span>}
                      {i > 0 && <span className="text-gray-500 hidden sm:inline">{pct(step.count, stepCounts[0].count)} do início</span>}
                    </div>
                  </div>
                  <div className="h-8 sm:h-9 bg-gray-800/50 rounded-lg overflow-hidden cursor-pointer hover:bg-gray-800/70 transition-all"
                    onClick={() => setSelectedStep(step.key)} title={`Clique para ver usuários em ${step.label}`}>
                    <div className="h-full rounded-lg transition-all duration-700 ease-out"
                      style={{ width: `${Math.max(widthPct, 2)}%`, backgroundColor: STEP_COLORS[i] }} />
                  </div>
                </div>
              );
            })}

            {/* ── SPLIT: Teste Grátis vs Pagou ──────────── */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 my-3">
              {/* Free path */}
              <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-4 space-y-3 cursor-pointer hover:bg-amber-500/10 transition-all"
                onClick={() => setSelectedStep("checkout_free")}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-lg">🆓</span>
                    <span className="font-medium text-sm text-amber-300">Teste Grátis</span>
                  </div>
                  <span className="text-lg font-bold text-amber-300">{splitCounts.plans.free}</span>
                </div>
                <div className="h-6 bg-gray-800/50 rounded-lg overflow-hidden">
                  <div className="h-full bg-amber-500/40 rounded-lg transition-all duration-700"
                    style={{ width: `${splitCounts.plans.sawPlans > 0 ? Math.max((splitCounts.plans.free / splitCounts.plans.sawPlans) * 100, 2) : 0}%` }} />
                </div>
                <p className="text-[10px] text-gray-500">
                  {splitCounts.plans.sawPlans > 0 ? pct(splitCounts.plans.free, splitCounts.plans.sawPlans) : "0%"} dos que viram planos
                </p>
              </div>

              {/* Paid path */}
              <div className="bg-green-500/5 border border-green-500/20 rounded-xl p-4 space-y-3 cursor-pointer hover:bg-green-500/10 transition-all"
                onClick={() => setSelectedStep("checkout_paid")}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-lg">💰</span>
                    <span className="font-medium text-sm text-green-300">Pagaram</span>
                  </div>
                  <span className="text-lg font-bold text-green-300">{splitCounts.plans.paid}</span>
                </div>
                {splitCounts.plans.paid > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {analytics.plans.filter(([label]) => label !== "Teste").map(([label, count]) => (
                      <span key={label} className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-300">{label} {count}</span>
                    ))}
                    {analytics.periods.map(([label, count]) => (
                      <span key={label} className={`text-[10px] px-1.5 py-0.5 rounded ${label === "Anual" ? "bg-blue-500/20 text-blue-300" : "bg-purple-500/20 text-purple-300"}`}>
                        {label} {count}
                      </span>
                    ))}
                    {analytics.payMethods.map(([label, count]) => (
                      <span key={label} className={`text-[10px] px-1.5 py-0.5 rounded ${label === "PIX" ? "bg-emerald-500/20 text-emerald-300" : "bg-orange-500/20 text-orange-300"}`}>
                        {label} {count}
                      </span>
                    ))}
                  </div>
                )}
                <div className="h-6 bg-gray-800/50 rounded-lg overflow-hidden">
                  <div className="h-full bg-green-500/40 rounded-lg transition-all duration-700"
                    style={{ width: `${splitCounts.plans.sawPlans > 0 ? Math.max((splitCounts.plans.paid / splitCounts.plans.sawPlans) * 100, 2) : 0}%` }} />
                </div>
                <p className="text-[10px] text-gray-500">
                  {splitCounts.plans.sawPlans > 0 ? pct(splitCounts.plans.paid, splitCounts.plans.sawPlans) : "0%"} dos que viram planos
                </p>
              </div>
            </div>

            {/* Post-split linear steps */}
            {stepCounts.filter(s => POST_SPLIT_STEPS.some(ps => ps.key === s.key)).map((step) => {
              const globalIdx = stepCounts.findIndex(sc => sc.key === step.key);
              const widthPct = (step.count / maxCount) * 100;
              const prevCount = globalIdx > 0 ? stepCounts[globalIdx - 1].count : step.count;
              const dropPct = globalIdx > 0 && prevCount > 0 ? Math.round(((prevCount - step.count) / prevCount) * 100) : 0;
              return (
                <div key={step.key} className="group">
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span className="text-base">{step.icon}</span>
                      <span className="text-xs sm:text-sm font-medium text-gray-300">{step.label}</span>
                      <span className="text-sm sm:text-lg font-bold tabular-nums">{step.count}</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                      {dropPct > 0 && <span className="text-red-400">-{dropPct}%</span>}
                      {dropPct === 0 && step.count > 0 && <span className="text-green-400">100%</span>}
                      <span className="text-gray-500 hidden sm:inline">{pct(step.count, stepCounts[0].count)} do início</span>
                    </div>
                  </div>
                  <div className="h-8 sm:h-9 bg-gray-800/50 rounded-lg overflow-hidden cursor-pointer hover:bg-gray-800/70 transition-all"
                    onClick={() => setSelectedStep(step.key)} title={`Clique para ver usuários em ${step.label}`}>
                    <div className="h-full rounded-lg transition-all duration-700 ease-out"
                      style={{ width: `${Math.max(widthPct, 2)}%`, backgroundColor: STEP_COLORS[globalIdx] || STEP_COLORS[STEP_COLORS.length - 1] }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── SPLIT FUNNEL: Web vs Plugin ────────────────────── */}
        {(splitCounts.web.total > 0 || splitCounts.plugin.total > 0) && (
          <div className="bg-gray-900/50 backdrop-blur-sm rounded-2xl p-4 sm:p-6 border border-gray-800/50">
            <h2 className="text-base sm:text-lg font-semibold mb-4">Pós-onboarding</h2>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Web path */}
              <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-lg">🌐</span>
                    <span className="font-medium text-sm text-emerald-300">Biblioteca Web</span>
                  </div>
                  <span className="text-lg font-bold text-emerald-300">{splitCounts.web.total}</span>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-gray-400">📥 1º Download</span>
                    <span className="font-bold">{splitCounts.web.firstDownload}</span>
                  </div>
                  <div className="h-6 bg-gray-800/50 rounded-lg overflow-hidden">
                    <div className="h-full bg-emerald-500/40 rounded-lg transition-all duration-700"
                      style={{ width: `${splitCounts.web.total > 0 ? Math.max((splitCounts.web.firstDownload / splitCounts.web.total) * 100, 2) : 0}%` }} />
                  </div>
                </div>
              </div>

              {/* Plugin path */}
              <div className="bg-blue-500/5 border border-blue-500/20 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-lg">🔌</span>
                    <span className="font-medium text-sm text-blue-300">Plugin SketchUp</span>
                  </div>
                  <span className="text-lg font-bold text-blue-300">{splitCounts.plugin.total}</span>
                </div>
                <div className="space-y-2">
                  {[
                    { icon: "🔐", label: "Login Instalador", count: splitCounts.plugin.installerLogin },
                    { icon: "🔌", label: "Plugin Instalado", count: splitCounts.plugin.pluginInstalled },
                    { icon: "📥", label: "1º Download", count: splitCounts.plugin.firstDownload },
                  ].map((s, i) => (
                    <div key={i}>
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="text-gray-400">{s.icon} {s.label}</span>
                        <span className="font-bold">{s.count}</span>
                      </div>
                      <div className="h-6 bg-gray-800/50 rounded-lg overflow-hidden">
                        <div className="h-full bg-blue-500/40 rounded-lg transition-all duration-700"
                          style={{ width: `${splitCounts.plugin.total > 0 ? Math.max((s.count / splitCounts.plugin.total) * 100, 2) : 0}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Convergence */}
            <div className="mt-4 pt-4 border-t border-gray-800/50">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-lg">📥</span>
                  <span className="font-medium text-sm">1º Download (todos)</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-lg font-bold">{splitCounts.converge.firstDownload}</span>
                  <span className="text-xs text-gray-500">
                    {journeys.length > 0 ? pct(splitCounts.converge.firstDownload, journeys.length) : "0%"} do total
                  </span>
                </div>
              </div>
              <div className="h-8 bg-gray-800/50 rounded-lg overflow-hidden mt-2">
                <div className="h-full bg-gradient-to-r from-emerald-500/40 to-blue-500/40 rounded-lg transition-all duration-700"
                  style={{ width: `${journeys.length > 0 ? Math.max((splitCounts.converge.firstDownload / journeys.length) * 100, 2) : 0}%` }} />
              </div>
            </div>
          </div>
        )}

        {/* Automações */}
        <div className="bg-gray-900/50 rounded-2xl p-3 sm:p-6 border border-gray-800">
          <AutomationPanel />
        </div>

        {/* ── Users list ────────────────────────────────────────── */}
        <div className="bg-gray-900/50 backdrop-blur-sm rounded-2xl p-3 sm:p-6 border border-gray-800/50">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-3">
            <h2 className="text-base sm:text-lg font-semibold">
              Usuários ({filteredJourneys.length})
            </h2>
            <input type="text" placeholder="Buscar por nome ou email..."
              value={searchTerm} onChange={e => { setSearchTerm(e.target.value); setUserPage(0); }}
              className="bg-gray-800/50 border border-gray-700/50 rounded-lg px-3 py-2 text-sm w-full sm:w-72 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>

          <div className="space-y-2">
            {pagedJourneys.map(j => (
              <div key={j.key}
                className="bg-gray-800/30 rounded-lg p-3 hover:bg-gray-800/50 cursor-pointer transition-all"
                onClick={() => setSelectedUser(j)}>
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm truncate">
                        {j.name || j.email || j.key.slice(0, 8) + "…"}
                      </span>
                      {j.name && j.email && (
                        <span className="text-xs text-gray-500 truncate hidden sm:inline">{j.email}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      {j.profession && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300">
                          {PROFESSION_LABELS[j.profession] || j.profession}
                        </span>
                      )}
                      {j.intent && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300">
                          {INTENT_LABELS[j.intent] || j.intent}
                        </span>
                      )}
                      {j.plan && (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${j.planName === "teste" ? "bg-amber-500/20 text-amber-300" : "bg-green-500/20 text-green-300"}`}>
                          {j.planName === "teste" ? "🆓 Grátis" : `💰 ${(j.planName || j.plan.split("_")[0]).charAt(0).toUpperCase() + (j.planName || j.plan.split("_")[0]).slice(1)}`}
                          {j.period && ` · ${j.period === "anual" ? "Anual" : "Mensal"}`}
                          {j.paymentMethod && ` · ${j.paymentMethod === "pix" ? "PIX" : "Cartão"}`}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {ALL_STEPS.map((s) => (
                      <span key={s.key} title={s.label}
                        className={`text-xs ${j.stepsCompleted.has(s.key) ? "" : "opacity-15 grayscale"}`}>
                        {s.icon}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="flex items-center justify-between mt-1.5">
                  <span className="text-[10px] text-gray-500">
                    Parou em: <span className="text-gray-400">{j.lastStepLabel || "—"}</span>
                  </span>
                  <div className="flex items-center gap-1.5">
                    {j.platform && (
                      <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${j.platform === "mobile" ? "bg-orange-500/20 text-orange-300" : "bg-gray-500/20 text-gray-300"}`}>
                        {j.platform === "mobile" ? "📱" : "🖥️"}
                      </span>
                    )}
                    {j.method && (
                      <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${j.method === "plugin" ? "bg-blue-500/20 text-blue-300" : "bg-emerald-500/20 text-emerald-300"}`}>
                        {j.method === "plugin" ? "🔌 Plugin" : "🌐 Web"}
                      </span>
                    )}
                    <span className="text-[10px] text-gray-500">{formatDate(j.lastSeen)}</span>
                  </div>
                </div>
              </div>
            ))}
            {pagedJourneys.length === 0 && (
              <p className="py-8 text-center text-gray-500 text-sm">
                {loading ? "Carregando..." : "Nenhum usuário encontrado"}
              </p>
            )}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-3 text-xs">
              <span className="text-gray-500">{userPage + 1}/{totalPages}</span>
              <div className="flex gap-2">
                <button onClick={() => setUserPage(p => Math.max(0, p - 1))} disabled={userPage === 0}
                  className="px-2 py-1 rounded bg-gray-800/50 text-gray-300 hover:bg-gray-700/60 disabled:opacity-40 border border-gray-700/50">←</button>
                <button onClick={() => setUserPage(p => Math.min(totalPages - 1, p + 1))} disabled={userPage >= totalPages - 1}
                  className="px-2 py-1 rounded bg-gray-800/50 text-gray-300 hover:bg-gray-700/60 disabled:opacity-40 border border-gray-700/50">→</button>
              </div>
            </div>
          )}
        </div>

        <footer className="text-center text-xs text-gray-600 pb-4">
          Collection © {new Date().getFullYear()} · Onboarding Dashboard
        </footer>
      </div>

      {/* ── User detail modal ──────────────────────────────────── */}
      {selectedUser && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-0 sm:p-4 z-50" onClick={() => setSelectedUser(null)}>
          <div className="bg-gray-900 sm:rounded-2xl max-w-2xl w-full h-full sm:h-auto sm:max-h-[85vh] overflow-hidden border-0 sm:border border-gray-700"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-gray-700">
              <div>
                <h3 className="text-lg font-semibold">{selectedUser.name || "Usuário anônimo"}</h3>
                <p className="text-sm text-gray-400">{selectedUser.email || selectedUser.key.slice(0, 12) + "…"}</p>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => handleDeleteUser(selectedUser.email, selectedUser.key)}
                  disabled={deletingUser === (selectedUser.email || selectedUser.key)}
                  className="bg-red-600/80 hover:bg-red-600 text-white px-3 py-1.5 rounded-lg text-xs transition-colors">
                  {deletingUser ? "..." : "Deletar"}
                </button>
                <button onClick={() => setSelectedUser(null)} className="text-gray-400 hover:text-white text-xl">✕</button>
              </div>
            </div>

            <div className="p-4 overflow-y-auto h-[calc(100vh-70px)] sm:h-auto sm:max-h-[calc(85vh-70px)] space-y-4">
              {/* User info */}
              <div className="grid grid-cols-2 gap-2">
                {selectedUser.name && <InfoPill label="Nome" value={selectedUser.name} />}
                {selectedUser.email && <InfoPill label="Email" value={selectedUser.email} />}
                {selectedUser.phone && <InfoPill label="Telefone" value={selectedUser.phone} />}
                {selectedUser.profession && <InfoPill label="Profissão" value={PROFESSION_LABELS[selectedUser.profession] || selectedUser.profession} />}
                {selectedUser.intent && <InfoPill label="Jornada" value={INTENT_LABELS[selectedUser.intent] || selectedUser.intent} />}
                {selectedUser.method && <InfoPill label="Método" value={selectedUser.method === "plugin" ? "Plugin SketchUp" : "Biblioteca Web"} />}
                {selectedUser.signupMethod && <InfoPill label="Cadastro" value={selectedUser.signupMethod === "google" ? "Google" : "Email/Senha"} />}
                {selectedUser.plan && <InfoPill label="Plano" value={selectedUser.planName === "teste" ? "Teste Grátis" : `${(selectedUser.planName || selectedUser.plan.split("_")[0]).charAt(0).toUpperCase() + (selectedUser.planName || selectedUser.plan.split("_")[0]).slice(1)}${selectedUser.period ? ` · ${selectedUser.period === "anual" ? "Anual" : "Mensal"}` : ""}${selectedUser.paymentMethod ? ` · ${selectedUser.paymentMethod === "pix" ? "PIX" : "Cartão"}` : ""}`} />}
                {selectedUser.platform && <InfoPill label="Plataforma" value={selectedUser.platform === "mobile" ? "📱 Mobile" : "🖥️ Desktop"} />}
              </div>

              {/* Journey timeline */}
              <div className="space-y-1">
                <h4 className="text-sm font-semibold text-gray-300 mb-2">Jornada no Onboarding</h4>
                {ALL_STEPS.map((step, i) => {
                  const completed = selectedUser.stepsCompleted.has(step.key);
                  const stepEvents = selectedUser.allEvents.filter(e => e.event === step.key);
                  const latestEvent = stepEvents[stepEvents.length - 1];
                  const meta = (latestEvent?.metadata || {}) as any;

                  return (
                    <div key={step.key} className={`flex items-start gap-3 p-2 rounded-lg ${completed ? "bg-gray-800/40" : "opacity-40"}`}>
                      <div className="flex flex-col items-center">
                        <span className={`text-lg ${completed ? "" : "grayscale"}`}>{step.icon}</span>
                        {i < ALL_STEPS.length - 1 && (
                          <div className={`w-0.5 h-4 mt-1 ${completed ? "bg-gray-600" : "bg-gray-800"}`} />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <span className={`text-sm font-medium ${completed ? "text-white" : "text-gray-500"}`}>
                            {step.label}
                          </span>
                          {latestEvent && (
                            <span className="text-[10px] text-gray-500">{formatTime(latestEvent.created_at)}</span>
                          )}
                        </div>
                        {completed && meta && (
                          <div className="flex flex-wrap gap-1 mt-0.5">
                            {meta.name && step.key === "onboarding_started" && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300">
                                {meta.name}
                              </span>
                            )}
                            {meta.profession && step.key === "onboarding_started" && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300">
                                {PROFESSION_LABELS[meta.profession] || meta.profession}
                              </span>
                            )}
                            {meta.intent && (step.key === "onboarding_step_intent" || step.key === "onboarding_step_experience") && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300">
                                {INTENT_LABELS[meta.intent] || meta.intent}
                              </span>
                            )}
                            {meta.email && step.key === "signup_completed" && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-300">
                                {meta.email}
                              </span>
                            )}
                            {meta.method && step.key === "onboarding_method_selected" && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300">
                                {meta.method === "plugin" ? "Plugin SketchUp" : "Biblioteca Web"}
                              </span>
                            )}
                            {meta.plan && (step.key === "onboarding_step_plans" || step.key === "checkout_completed") && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-300">
                                {meta.plan}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                      {completed && <span className="text-green-400 text-sm mt-0.5">✓</span>}
                    </div>
                  );
                })}
              </div>

              {/* Automation actions */}
              {selectedUser.email && (
                <div className="border-t border-gray-800 pt-3">
                  <UserActionsList email={selectedUser.email} />
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Step users modal ───────────────────────────────────── */}
      {selectedStep && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-0 sm:p-4 z-50" onClick={() => setSelectedStep(null)}>
          <div className="bg-gray-900 sm:rounded-2xl max-w-3xl w-full h-full sm:h-auto sm:max-h-[80vh] overflow-hidden border-0 sm:border border-gray-700"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-gray-700">
              <div className="flex items-center gap-2">
                <span className="text-xl">{selectedStep === "checkout_free" ? "🆓" : selectedStep === "checkout_paid" ? "💰" : ALL_STEPS.find(s => s.key === selectedStep)?.icon}</span>
                <h3 className="text-lg font-semibold">{selectedStep === "checkout_free" ? "Teste Grátis" : selectedStep === "checkout_paid" ? "Pagaram" : ALL_STEPS.find(s => s.key === selectedStep)?.label}</h3>
                <span className="text-sm text-gray-400">({usersAtStep.length} usuários)</span>
              </div>
              <button onClick={() => setSelectedStep(null)} className="text-gray-400 hover:text-white text-xl">✕</button>
            </div>
            <div className="p-3 sm:p-4 overflow-y-auto h-[calc(100vh-60px)] sm:h-auto sm:max-h-[calc(80vh-60px)]">
              {usersAtStep.length === 0 ? (
                <p className="text-gray-500 text-center py-8 text-sm">Nenhum usuário</p>
              ) : (
                <div className="space-y-2">
                  {usersAtStep.map(j => (
                    <div key={j.key}
                      className="bg-gray-800/30 rounded-lg p-3 hover:bg-gray-800/50 cursor-pointer transition-all"
                      onClick={() => { setSelectedStep(null); setSelectedUser(j); }}>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="font-medium text-sm truncate">{j.name || j.email || j.key.slice(0, 8) + "…"}</span>
                          {j.profession && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300">
                              {PROFESSION_LABELS[j.profession] || j.profession}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          {ALL_STEPS.map(s => (
                            <span key={s.key} className={`text-[10px] ${j.stepsCompleted.has(s.key) ? "" : "opacity-15 grayscale"}`}>
                              {s.icon}
                            </span>
                          ))}
                        </div>
                      </div>
                      <div className="flex items-center justify-between mt-1">
                        <span className="text-[10px] text-gray-500">
                          {j.email && <span className="text-gray-400">{j.email}</span>}
                          {!j.email && <span>Sem email ainda</span>}
                        </span>
                        <span className="text-[10px] text-gray-500">{formatDate(j.lastSeen)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Card ───────────────────────────────────────────────────────
function Card({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-gray-900/50 backdrop-blur-sm rounded-xl p-3 sm:p-4 border border-gray-800/50">
      <p className="text-[10px] sm:text-xs text-gray-400 uppercase tracking-wide">{label}</p>
      <p className="text-lg sm:text-2xl font-bold mt-0.5 tabular-nums">{value}</p>
      {sub && <p className="text-[10px] sm:text-xs text-gray-500 mt-0.5 truncate">{sub}</p>}
    </div>
  );
}

// ── Info Pill ──────────────────────────────────────────────────
function InfoPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-800/40 rounded-lg p-2">
      <p className="text-[10px] text-gray-500 uppercase">{label}</p>
      <p className="text-sm text-gray-200 truncate">{value}</p>
    </div>
  );
}

// ── Pie Chart Card ─────────────────────────────────────────────
function PieCard({ title, data }: { title: string; data: [string, number][] }) {
  const total = data.reduce((acc, [_, count]) => acc + count, 0);
  if (total === 0) {
    return (
      <div className="bg-gray-900/50 backdrop-blur-sm rounded-xl p-4 border border-gray-800/50">
        <p className="text-xs text-gray-400 uppercase tracking-wide mb-3">{title}</p>
        <div className="flex items-center justify-center h-16">
          <p className="text-gray-500 text-sm">—</p>
        </div>
      </div>
    );
  }

  let cum = 0;
  const segments = data.map(([label, count], i) => {
    const pct = (count / total) * 100;
    const seg = { label, count, pct, color: PIE_COLORS[i % PIE_COLORS.length], start: cum * 3.6 };
    cum += pct;
    return seg;
  });

  return (
    <div className="bg-gray-900/50 backdrop-blur-sm rounded-xl p-3 sm:p-4 border border-gray-800/50">
      <p className="text-[10px] sm:text-xs text-gray-400 uppercase tracking-wide mb-2">{title}</p>
      <div className="flex items-center gap-2 sm:gap-3">
        <div className="relative w-12 h-12 sm:w-14 sm:h-14 flex-shrink-0">
          <div className="w-full h-full rounded-full"
            style={{ background: `conic-gradient(${segments.map(s => `${s.color} ${s.start}deg ${s.start + s.pct * 3.6}deg`).join(", ")})` }} />
          <div className="absolute inset-1.5 bg-gray-900 rounded-full flex items-center justify-center">
            <span className="text-[10px] font-bold">{total}</span>
          </div>
        </div>
        <div className="flex-1 space-y-0.5">
          {segments.slice(0, 3).map(seg => (
            <div key={seg.label} className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: seg.color }} />
              <span className="text-[10px] text-gray-400 truncate flex-1">{seg.label}</span>
              <span className="text-[10px] text-gray-300 font-mono">{seg.count}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
