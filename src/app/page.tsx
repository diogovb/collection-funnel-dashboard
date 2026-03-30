"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { supabase } from "@/lib/supabase";
import AutomationPanel, { UserActionsList } from "@/components/AutomationPanel";

// ── Funnel config ──────────────────────────────────────────────
const STAGES = [
  { key: "signup_completed", label: "Cadastro" },
  { key: "onboarding_completed", label: "Onboarding Completo" },
  { key: "checkout_completed", label: "Pagamento" },
  { key: "installer_login", label: "Login Instalador" },
  { key: "plugin_installed", label: "Plugin Instalado" },
  { key: "first_download", label: "Primeiro Download" },
] as const;

type StageKey = (typeof STAGES)[number]["key"];

// Onboarding sub-stages for detailed funnel view
const ONBOARDING_SUBSTAGES = [
  { key: "onboarding_started", label: "Nome", icon: "📝" },
  { key: "onboarding_step_welcome", label: "Boas-vindas", icon: "👋" },
  { key: "onboarding_step_intent", label: "Jornada", icon: "🎯" },
  { key: "onboarding_step_experience", label: "Experiência", icon: "✨" },
  { key: "signup_completed", label: "Conta", icon: "🔑" },
  { key: "onboarding_step_how_to_use", label: "Plugin/Web", icon: "🧩" },
  { key: "onboarding_step_plans", label: "Planos", icon: "💳" },
  { key: "onboarding_step_workshop", label: "Workshop", icon: "🎓" },
  { key: "onboarding_step_install", label: "Instalar", icon: "⬇️" },
  { key: "onboarding_completed", label: "Completo", icon: "✅" },
] as const;

const STAGE_COLORS = [
  "#6366f1", "#8b5cf6", "#a78bfa", "#d946ef", "#ec4899", "#10b981",
];

// Pie chart colors for analytics cards
const PIE_COLORS = [
  "#3B82F6", "#8B5CF6", "#EC4899", "#F59E0B", "#10B981", 
  "#F97316", "#EF4444", "#6366F1", "#84CC16", "#06B6D4"
];

// ── Types ──────────────────────────────────────────────────────
interface FunnelEvent {
  id: string;
  user_id: string;
  email: string;
  event: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

interface UserRow {
  email: string;
  user_id: string;
  stages: Set<StageKey>;
  lastActivity: string;
  metadata?: Record<string, unknown> | null;
}

interface StageUser {
  email: string;
  name?: string;
  phone?: string;
  profession?: string;
  intent?: string;
  software?: string[];
  projects_per_month?: string;
  interests?: string[];
  sketchup_versions?: string;
  installed_versions?: string;
  created_at: string;
  user_id: string;
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
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
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
  const [selectedStage, setSelectedStage] = useState<StageKey | null>(null);
  const [stageUsers, setStageUsers] = useState<StageUser[]>([]);
  const [deletingUser, setDeletingUser] = useState<string | null>(null);
  const USERS_PER_PAGE = 20;

  const dateFrom = useMemo(() => {
    if (preset === "today") {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return d.toISOString();
    }
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
    
    // Sync downloads from Collection Postgres (non-blocking)
    fetch("/api/sync-downloads").catch(() => {});
    
    const { data, error } = await supabase
      .from("funnel_events")
      .select("*")
      .gte("created_at", dateFrom)
      .lte("created_at", dateTo)
      .order("created_at", { ascending: true });

    if (!error && data) {
      setEvents(data as FunnelEvent[]);
    }
    setLastRefresh(new Date());
    setLoading(false);
  }, [dateFrom, dateTo]);

  // initial + date-change fetch
  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  // auto-refresh every 30s
  useEffect(() => {
    const interval = setInterval(fetchEvents, 30_000);
    return () => clearInterval(interval);
  }, [fetchEvents]);

  // ── Merge events by user_id ↔ email crossref ──────────────
  const mergedEvents = useMemo(() => {
    // Build a map: user_id → email (from events that have both)
    const uidToEmail = new Map<string, string>();
    for (const ev of events) {
      if (ev.user_id && ev.email) uidToEmail.set(ev.user_id, ev.email);
    }
    // Enrich events that have user_id but no email
    const enriched = events.map(ev => {
      if (!ev.email && ev.user_id && uidToEmail.has(ev.user_id)) {
        return { ...ev, email: uidToEmail.get(ev.user_id)! };
      }
      return ev;
    });

    // Infer missing stages: if user has plugin_installed with a known user_id,
    // they must have logged in (installer only knows user_id after login)
    const userEvents = new Map<string, Set<string>>();
    for (const ev of enriched) {
      const key = ev.email || ev.user_id;
      if (!key) continue;
      if (!userEvents.has(key)) userEvents.set(key, new Set());
      userEvents.get(key)!.add(ev.event);
    }

    const synthetic: typeof enriched = [];
    userEvents.forEach((stages, key) => {
      if (stages.has("plugin_installed") && !stages.has("installer_login")) {
        // Find the plugin_installed event to copy metadata from
        const ref = enriched.find(e => (e.email === key || e.user_id === key) && e.event === "plugin_installed");
        if (ref) {
          synthetic.push({ ...ref, event: "installer_login", metadata: { ...((ref.metadata || {}) as any), inferred: true } });
        }
      }
    });

    return [...enriched, ...synthetic];
  }, [events]);

  // ── Handle stage click ─────────────────────────────────────────
  const handleStageClick = useCallback(async (stageKey: StageKey) => {
    setSelectedStage(stageKey);
    
    // Get users for this stage with their metadata
    const usersAtStage = new Map<string, StageUser>();
    
    // Build set of emails that have signup_completed (funnel entry)
    const signupEmails = new Set<string>();
    for (const ev of mergedEvents) {
      if (ev.event === "signup_completed" && ev.email) signupEmails.add(ev.email);
    }

    for (const event of mergedEvents) {
      if (event.event === stageKey) {
        const key = event.email || event.user_id || event.id;
        if (!key) continue;
        
        // Only show users who entered the funnel (have signup_completed)
        const email = event.email || "";
        if (!signupEmails.has(email) && stageKey !== "signup_completed") continue;
        
        // Find their signup_completed event for metadata
        const signupEvent = mergedEvents.find(e => 
          (e.email === event.email || e.user_id === event.user_id) && e.event === "signup_completed"
        );
        
        const metadata = (signupEvent?.metadata || event.metadata || {}) as any;
        
        // Find sketchup_detected event for this user
        const detectEvent = mergedEvents.find(e =>
          (e.email === (event.email || signupEvent?.email) || e.user_id === event.user_id) && e.event === "sketchup_detected"
        );
        const detectMeta = (detectEvent?.metadata || {}) as any;
        
        // Find plugin_installed event for installed versions
        const installEvent = mergedEvents.find(e =>
          (e.email === (event.email || signupEvent?.email) || e.user_id === event.user_id) && e.event === "plugin_installed"
        );
        const installMeta = (installEvent?.metadata || {}) as any;

        usersAtStage.set(key, {
          email: event.email || signupEvent?.email || "",
          name: metadata?.name || "",
          phone: metadata?.phone || "",
          profession: metadata?.profession || "",
          intent: metadata?.intent || "",
          software: metadata?.software || [],
          projects_per_month: metadata?.projects_per_month || "",
          interests: metadata?.interests || [],
          sketchup_versions: detectMeta?.versions_found || "",
          installed_versions: installMeta?.sketchup_versions || "",
          created_at: event.created_at,
          user_id: event.user_id || "",
        });
      }
    }
    
    setStageUsers(Array.from(usersAtStage.values()).sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    ));
  }, [mergedEvents]);

  // ── Handle user delete ─────────────────────────────────────────
  const handleDeleteUser = useCallback(async (email: string, userId?: string) => {
    const identifier = email || userId || "este usuário";
    if (!confirm(`Tem certeza que deseja deletar todos os eventos para ${identifier}?`)) {
      return;
    }
    
    setDeletingUser(email || userId || "");
    
    try {
      const response = await fetch("/api/delete-user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email || null, user_id: userId || null }),
      });
      
      if (response.ok) {
        // Close modal and refresh data
        setSelectedStage(null);
        setStageUsers([]);
        await fetchEvents();
      } else {
        alert("Erro ao deletar usuário");
      }
    } catch (error) {
      alert("Erro ao deletar usuário");
    } finally {
      setDeletingUser(null);
    }
  }, [fetchEvents]);

  // ── Computed data ──────────────────────────────────────────
  const stageCounts = useMemo(() => {
    // Build a map of email → Set of stages they completed
    const userStages = new Map<string, Set<string>>();
    for (const ev of mergedEvents) {
      const key = ev.email || ev.user_id;
      if (!key) continue;
      if (!userStages.has(key)) userStages.set(key, new Set());
      userStages.get(key)!.add(ev.event);
    }

    // Sequential funnel: only count users who started from signup_completed
    // Each stage = users who have signup_completed AND this stage
    const signupUsers = new Set<string>();
    userStages.forEach((stages, email) => {
      if (stages.has("signup_completed")) signupUsers.add(email);
    });

    return STAGES.map((s) => {
      let count = 0;
      signupUsers.forEach((email) => {
        if (userStages.get(email)?.has(s.key)) count++;
      });
      return { ...s, count };
    });
  }, [events]);

  const maxCount = Math.max(1, ...stageCounts.map((s) => s.count));

  // Onboarding sub-funnel counts
  const onboardingSubCounts = useMemo(() => {
    const userStages = new Map<string, Set<string>>();
    for (const ev of mergedEvents) {
      const key = ev.email || ev.user_id;
      if (!key) continue;
      if (!userStages.has(key)) userStages.set(key, new Set());
      userStages.get(key)!.add(ev.event);
    }
    return ONBOARDING_SUBSTAGES.map((s) => {
      let count = 0;
      userStages.forEach((stages) => {
        if (stages.has(s.key)) count++;
      });
      return { ...s, count };
    });
  }, [events]);

  const maxOnboardingCount = Math.max(1, ...onboardingSubCounts.map((s) => s.count));

  const users = useMemo(() => {
    const map = new Map<string, UserRow>();
    for (const ev of mergedEvents) {
      const key = ev.email || ev.user_id;
      if (!key) continue;
      if (!map.has(key)) {
        map.set(key, {
          email: ev.email,
          user_id: ev.user_id,
          stages: new Set(),
          lastActivity: ev.created_at,
          metadata: ev.metadata,
        });
      }
      const u = map.get(key)!;
      if (STAGES.some((s) => s.key === ev.event)) {
        u.stages.add(ev.event as StageKey);
      }
      if (ev.email && !u.email) u.email = ev.email;
      if (ev.user_id && !u.user_id) u.user_id = ev.user_id;
      if (ev.created_at > u.lastActivity) u.lastActivity = ev.created_at;
      if (ev.metadata && ev.event === "signup_completed") {
        u.metadata = ev.metadata;
      }
    }
    // Only include users who started from signup (sequential funnel)
    const filtered = Array.from(map.values()).filter(u => u.stages.has("signup_completed"));
    return filtered.sort(
      (a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime()
    );
  }, [mergedEvents]);

  // ── Analytics data for pie charts ─────────────────────────────
  const analyticsData = useMemo(() => {
    const signupEvents = events.filter(e => e.event === "signup_completed");
    
    const PROFESSION_LABELS: Record<string, string> = {
      "arquiteto": "Arquiteto(a)",
      "designer_interiores": "Designer de Interiores",
      "engenheiro": "Engenheiro(a)",
      "projetista": "Projetista",
      "estudante": "Estudante",
      "outro": "Outro",
    };
    
    // Profissão
    const professions = new Map<string, number>();
    signupEvents.forEach(event => {
      const profession = PROFESSION_LABELS[(event.metadata as any)?.profession] || (event.metadata as any)?.profession || "Não informado";
      professions.set(profession, (professions.get(profession) || 0) + 1);
    });
    
    // Planos comprados (from checkout_completed events)
    const checkoutEvents = events.filter(e => e.event === "checkout_completed");
    const plans = new Map<string, number>();
    const PLAN_LABELS: Record<string, string> = {
      "free": "Teste Grátis",
    };
    checkoutEvents.forEach(event => {
      const rawPlan = (event.metadata as any)?.plan || "Não informado";
      // Plan string can be "premium_anual_pix" or "básico_mensal_stripe_sub123" etc.
      const planName = rawPlan.split("_")[0];
      const label = PLAN_LABELS[planName] || planName.charAt(0).toUpperCase() + planName.slice(1);
      plans.set(label, (plans.get(label) || 0) + 1);
    });
    // Also count skipped (free) users
    const skippedEvents = events.filter(e => e.event === "onboarding_offer_skipped");
    if (skippedEvents.length > 0) {
      plans.set("Teste Grátis", (plans.get("Teste Grátis") || 0) + skippedEvents.length);
    }
    
    // Método de uso (plugin vs web)
    const methods = new Map<string, number>();
    const METHOD_LABELS: Record<string, string> = {
      "plugin": "Plugin SketchUp",
      "web": "Biblioteca Web",
    };
    const methodEvents = events.filter(e => e.event === "onboarding_method_selected");
    methodEvents.forEach(event => {
      const method = METHOD_LABELS[(event.metadata as any)?.method] || (event.metadata as any)?.method || "Não informado";
      methods.set(method, (methods.get(method) || 0) + 1);
    });
    
    // Intent/Jornada
    const intents = new Map<string, number>();
    const INTENT_LABELS: Record<string, string> = {
      "biblioteca": "Blocos 3D",
      "render": "Render IA",
      "apresentacao": "Apresentações",
      "explorar": "Explorar tudo",
    };
    signupEvents.forEach(event => {
      const intent = INTENT_LABELS[(event.metadata as any)?.intent] || (event.metadata as any)?.intent || "Não informado";
      intents.set(intent, (intents.get(intent) || 0) + 1);
    });
    
    return {
      professions: Array.from(professions.entries()).sort((a, b) => b[1] - a[1]),
      plans: Array.from(plans.entries()).sort((a, b) => b[1] - a[1]),
      methods: Array.from(methods.entries()).sort((a, b) => b[1] - a[1]),
      intents: Array.from(intents.entries()).sort((a, b) => b[1] - a[1]),
    };
  }, [events]);

  const filteredUsers = useMemo(() => {
    if (!searchTerm) return users;
    const q = searchTerm.toLowerCase();
    return users.filter((u) => u.email?.toLowerCase().includes(q));
  }, [users, searchTerm]);

  const pagedUsers = filteredUsers.slice(
    userPage * USERS_PER_PAGE,
    (userPage + 1) * USERS_PER_PAGE
  );
  const totalPages = Math.ceil(filteredUsers.length / USERS_PER_PAGE);

  // ── Render ─────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-7xl mx-auto px-3 sm:px-4 py-4 sm:py-8 space-y-4 sm:space-y-8">
        {/* Header */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight bg-gradient-to-r from-white to-gray-300 bg-clip-text text-transparent">
              Funil de Conversão
            </h1>
            <p className="text-gray-400 mt-1 text-xs sm:text-base">Collection — Dashboard em tempo real</p>
          </div>
          <div className="flex items-center gap-2 text-sm text-gray-400">
            {loading && (
              <span className="inline-block w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />
            )}
            <span>
              Atualizado: {lastRefresh.toLocaleTimeString("pt-BR")} · Auto-refresh 30s
            </span>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          {(["today", "7d", "30d", "90d", "custom"] as DatePreset[]).map((p) => (
            <button
              key={p}
              onClick={() => { setPreset(p); setUserPage(0); }}
              className={`px-3 sm:px-4 py-1.5 sm:py-2 rounded-lg text-xs sm:text-sm font-medium transition-all duration-200 ${
                preset === p
                  ? "bg-gradient-to-r from-indigo-600 to-purple-600 text-white shadow-lg"
                  : "bg-gray-800/50 text-gray-300 hover:bg-gray-700/60 border border-gray-700/50"
              }`}
            >
              {p === "today" ? "Hoje" : p === "7d" ? "7d" : p === "30d" ? "30d" : p === "90d" ? "90d" : "Custom"}
            </button>
          ))}
          {preset === "custom" && (
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="bg-gray-800/50 border border-gray-700/50 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              />
              <span className="text-gray-500">até</span>
              <input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className="bg-gray-800/50 border border-gray-700/50 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              />
            </div>
          )}
          <button
            onClick={fetchEvents}
            className="ml-auto px-4 py-2 rounded-lg text-sm bg-gray-800/50 text-gray-300 hover:bg-gray-700/60 border border-gray-700/50 transition-all duration-200"
          >
            ↻ Atualizar
          </button>
        </div>

        {/* Top summary cards */}
        <div className="grid grid-cols-3 gap-2 sm:gap-4">
          <Card label="Usuários Únicos" value={users.length.toLocaleString("pt-BR")} />
          <Card
            label="Taxa Geral"
            value={pct(stageCounts[stageCounts.length - 1]?.count ?? 0, stageCounts[0]?.count ?? 0)}
            sub={`${STAGES[0].label} → ${STAGES[STAGES.length - 1].label}`}
          />
          <Card
            label="Maior Drop-off"
            value={(() => {
              let maxDrop = 0, dropLabel = "—";
              for (let i = 1; i < stageCounts.length; i++) {
                const prev = stageCounts[i - 1].count;
                const curr = stageCounts[i].count;
                const drop = prev > 0 ? ((prev - curr) / prev) * 100 : 0;
                if (drop > maxDrop) {
                  maxDrop = drop;
                  dropLabel = `${stageCounts[i - 1].label} → ${stageCounts[i].label}`;
                }
              }
              return maxDrop > 0 ? `${maxDrop.toFixed(1)}%` : "—";
            })()}
            sub={(() => {
              let maxDrop = 0, dropLabel = "—";
              for (let i = 1; i < stageCounts.length; i++) {
                const prev = stageCounts[i - 1].count;
                const curr = stageCounts[i].count;
                const drop = prev > 0 ? ((prev - curr) / prev) * 100 : 0;
                if (drop > maxDrop) {
                  maxDrop = drop;
                  dropLabel = `${stageCounts[i - 1].label} → ${stageCounts[i].label}`;
                }
              }
              return dropLabel;
            })()}
          />
        </div>

        {/* Analytics pie charts */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-4">
          <PieCard title="Profissão" data={analyticsData.professions.slice(0, 5)} />
          <PieCard title="Planos" data={analyticsData.plans.slice(0, 5)} />
          <PieCard title="Método" data={analyticsData.methods.slice(0, 5)} />
          <PieCard title="Jornada" data={analyticsData.intents.slice(0, 5)} />
        </div>

        {/* Funnel visualization */}
        <div className="bg-gray-900/50 backdrop-blur-sm rounded-2xl p-4 sm:p-6 space-y-3 sm:space-y-4 border border-gray-800/50">
          <h2 className="text-base sm:text-lg font-semibold mb-1 sm:mb-2">Funil</h2>
          <div className="space-y-2 sm:space-y-3">
            {stageCounts.map((stage, i) => {
              const widthPct = (stage.count / maxCount) * 100;
              const convFromPrev =
                i > 0 && stageCounts[i - 1].count > 0
                  ? ((stage.count / stageCounts[i - 1].count) * 100).toFixed(1) + "%"
                  : null;
              const convFromFirst =
                i > 0 && stageCounts[0].count > 0
                  ? ((stage.count / stageCounts[0].count) * 100).toFixed(1) + "%"
                  : null;

              return (
                <div key={stage.key} className="group">
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                      <span className="text-xs sm:text-sm font-medium text-gray-300 truncate max-w-[120px] sm:max-w-[200px]">
                        {stage.label}
                      </span>
                      <span className="text-lg sm:text-xl font-bold tabular-nums flex-shrink-0">
                        {stage.count.toLocaleString("pt-BR")}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 sm:gap-4 text-[10px] sm:text-xs text-gray-400 flex-shrink-0">
                      {convFromPrev && (
                        <span>{convFromPrev}</span>
                      )}
                      {convFromFirst && (
                        <span className="text-gray-500 hidden sm:inline">
                          {convFromFirst} do início
                        </span>
                      )}
                    </div>
                  </div>
                  <div 
                    className="h-8 sm:h-10 bg-gray-800/50 rounded-lg overflow-hidden cursor-pointer hover:bg-gray-800/70 transition-all duration-200"
                    onClick={() => handleStageClick(stage.key)}
                    title={`Clique para ver usuários em ${stage.label}`}
                  >
                    <div
                      className="h-full rounded-lg transition-all duration-700 ease-out flex items-center justify-end pr-2 sm:pr-3 hover:opacity-90"
                      style={{
                        width: `${Math.max(widthPct, 2)}%`,
                        backgroundColor: STAGE_COLORS[i],
                      }}
                    >
                      {widthPct > 20 && (
                        <span className="text-[10px] sm:text-xs font-semibold text-white/90">
                          {stage.count.toLocaleString("pt-BR")}
                        </span>
                      )}
                    </div>
                  </div>
                  {i < stageCounts.length - 1 && (
                    <div className="flex justify-center my-0.5 sm:my-1">
                      <svg width="16" height="12" className="text-gray-600 sm:w-5 sm:h-4">
                        <path d="M8 0 L8 8 M4 5 L8 10 L12 5" stroke="currentColor" fill="none" strokeWidth="1.5" />
                      </svg>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Onboarding sub-funnel */}
        {onboardingSubCounts.some(s => s.count > 0) && (
        <div className="bg-gray-900/50 backdrop-blur-sm rounded-2xl p-4 sm:p-6 space-y-3 sm:space-y-4 border border-gray-800/50">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1">
            <h2 className="text-base sm:text-lg font-semibold">🎯 Detalhe do Onboarding</h2>
            <span className="text-[10px] sm:text-xs text-gray-500">Onde os usuários param?</span>
          </div>
          {/* Scrollable horizontal icon strip on mobile */}
          <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
            <div className="flex sm:grid sm:grid-cols-5 lg:grid-cols-9 gap-3 sm:gap-2 min-w-max sm:min-w-0">
              {onboardingSubCounts.map((sub, i) => {
                const prevCount = i > 0 ? onboardingSubCounts[i - 1].count : sub.count;
                const dropPct = prevCount > 0 && i > 0 ? Math.round(((prevCount - sub.count) / prevCount) * 100) : 0;
                return (
                  <div key={sub.key} className="text-center space-y-0.5 sm:space-y-1 min-w-[60px]">
                    <div className="text-xl sm:text-2xl">{sub.icon}</div>
                    <p className="text-lg sm:text-2xl font-bold tabular-nums">{sub.count}</p>
                    <p className="text-[9px] sm:text-[10px] text-gray-400 leading-tight whitespace-nowrap">{sub.label}</p>
                    {i > 0 && dropPct > 0 && (
                      <p className="text-[9px] sm:text-[10px] text-red-400">-{dropPct}%</p>
                    )}
                    {i > 0 && dropPct === 0 && sub.count > 0 && (
                      <p className="text-[9px] sm:text-[10px] text-green-400">100%</p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          {/* Mini funnel bars */}
          <div className="space-y-1 sm:space-y-1.5 mt-3 sm:mt-4">
            {onboardingSubCounts.map((sub, i) => {
              const widthPct = (sub.count / maxOnboardingCount) * 100;
              return (
                <div key={sub.key} className="flex items-center gap-2 sm:gap-3">
                  <span className="text-[10px] sm:text-xs text-gray-400 w-24 sm:w-36 truncate flex items-center gap-1">
                    {sub.icon} <span className="hidden sm:inline">{sub.label}</span><span className="sm:hidden">{sub.label.split(" ")[0]}</span>
                  </span>
                  <div className="flex-1 h-5 sm:h-6 bg-gray-800/40 rounded-md overflow-hidden">
                    <div
                      className="h-full rounded-md transition-all duration-500"
                      style={{
                        width: `${Math.max(widthPct, 1)}%`,
                        backgroundColor: `hsl(${260 - i * 20}, 70%, ${55 + i * 3}%)`,
                      }}
                    />
                  </div>
                  <span className="text-[10px] sm:text-xs font-medium tabular-nums w-8 sm:w-10 text-right">{sub.count}</span>
                </div>
              );
            })}
          </div>
        </div>
        )}

        {/* Stage-to-stage conversion table */}
        <div className="bg-gray-900/50 backdrop-blur-sm rounded-2xl p-4 sm:p-6 border border-gray-800/50">
          <h2 className="text-base sm:text-lg font-semibold mb-3 sm:mb-4">Conversão entre Etapas</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800/50">
                  <th className="text-left py-2 sm:py-3 px-2 sm:px-4 text-gray-400 font-medium text-xs sm:text-sm">Etapa</th>
                  <th className="text-right py-2 sm:py-3 px-2 sm:px-4 text-gray-400 font-medium text-xs sm:text-sm">Qtd</th>
                  <th className="text-right py-2 sm:py-3 px-2 sm:px-4 text-gray-400 font-medium text-xs sm:text-sm">Conv.</th>
                  <th className="text-right py-2 sm:py-3 px-2 sm:px-4 text-gray-400 font-medium text-xs sm:text-sm hidden sm:table-cell">Do Início</th>
                  <th className="text-right py-2 sm:py-3 px-2 sm:px-4 text-gray-400 font-medium text-xs sm:text-sm">Drop</th>
                </tr>
              </thead>
              <tbody>
                {stageCounts.map((stage, i) => {
                  const prev = i > 0 ? stageCounts[i - 1].count : stage.count;
                  const first = stageCounts[0].count;
                  const dropoff = i > 0 && prev > 0 ? prev - stage.count : 0;
                  return (
                    <tr key={stage.key} className="border-b border-gray-800/30 hover:bg-gray-800/20 transition-colors">
                      <td className="py-2 sm:py-3 px-2 sm:px-4 text-xs sm:text-sm">
                        <div className="flex items-center gap-1.5 sm:gap-2">
                          <span
                            className="w-2.5 h-2.5 sm:w-3 sm:h-3 rounded-full inline-block flex-shrink-0"
                            style={{ backgroundColor: STAGE_COLORS[i] }}
                          />
                          <span className="truncate max-w-[100px] sm:max-w-none">{stage.label}</span>
                        </div>
                      </td>
                      <td className="py-2 sm:py-3 px-2 sm:px-4 text-right font-mono font-semibold text-xs sm:text-sm">
                        {stage.count.toLocaleString("pt-BR")}
                      </td>
                      <td className="py-2 sm:py-3 px-2 sm:px-4 text-right text-xs sm:text-sm">
                        {i === 0 ? "—" : pct(stage.count, prev)}
                      </td>
                      <td className="py-2 sm:py-3 px-2 sm:px-4 text-right text-gray-400 text-xs sm:text-sm hidden sm:table-cell">
                        {i === 0 ? "100%" : pct(stage.count, first)}
                      </td>
                      <td className="py-2 sm:py-3 px-2 sm:px-4 text-right text-red-400/80 text-xs sm:text-sm">
                        {dropoff > 0 ? `-${dropoff.toLocaleString("pt-BR")}` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Automações */}
        <div className="bg-gray-900/50 rounded-2xl p-3 sm:p-6 border border-gray-800">
          <AutomationPanel />
        </div>

        {/* Users table */}
        <div className="bg-gray-900/50 backdrop-blur-sm rounded-2xl p-3 sm:p-6 border border-gray-800/50">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 sm:gap-4 mb-3 sm:mb-4">
            <h2 className="text-base sm:text-lg font-semibold">
              Usuários ({filteredUsers.length.toLocaleString("pt-BR")})
            </h2>
            <input
              type="text"
              placeholder="Buscar por email..."
              value={searchTerm}
              onChange={(e) => { setSearchTerm(e.target.value); setUserPage(0); }}
              className="bg-gray-800/50 border border-gray-700/50 rounded-lg px-3 sm:px-4 py-2 text-sm w-full sm:w-72 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            />
          </div>
          {/* Mobile: card layout */}
          <div className="sm:hidden space-y-2">
            {pagedUsers.map((u) => (
              <div key={u.user_id || u.email || Math.random().toString()} className="bg-gray-800/30 rounded-lg p-3 space-y-2">
                <p className="font-mono text-xs truncate text-gray-200">
                  {u.email || (u.user_id ? u.user_id.slice(0, 8) + "…" : "Anônimo")}
                </p>
                <div className="flex items-center gap-1 flex-wrap">
                  {STAGES.map((s, i) => (
                    <span
                      key={s.key}
                      title={s.label}
                      className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-[9px] ${
                        u.stages.has(s.key) ? "text-white" : "bg-gray-800/50 text-gray-600"
                      }`}
                      style={u.stages.has(s.key) ? { backgroundColor: STAGE_COLORS[i] } : {}}
                    >
                      {u.stages.has(s.key) ? "✓" : "·"}
                    </span>
                  ))}
                </div>
                <p className="text-[10px] text-gray-500">{formatDate(u.lastActivity)}</p>
              </div>
            ))}
            {pagedUsers.length === 0 && (
              <p className="py-8 text-center text-gray-500 text-sm">
                {loading ? "Carregando..." : "Nenhum usuário encontrado"}
              </p>
            )}
          </div>
          {/* Desktop: table layout */}
          <div className="overflow-x-auto hidden sm:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800/50">
                  <th className="text-left py-3 px-4 text-gray-400 font-medium">Email</th>
                  {STAGES.map((s) => (
                    <th
                      key={s.key}
                      className="py-3 px-2 text-center text-gray-400 font-medium text-xs"
                      title={s.label}
                    >
                      {s.label.split(" ")[0]}
                    </th>
                  ))}
                  <th className="text-right py-3 px-4 text-gray-400 font-medium">Última Atividade</th>
                </tr>
              </thead>
              <tbody>
                {pagedUsers.map((u) => (
                  <tr key={u.user_id || u.email || Math.random().toString()} className="border-b border-gray-800/30 hover:bg-gray-800/20 transition-colors">
                    <td className="py-3 px-4 font-mono text-xs truncate max-w-[200px]">
                      {u.email || (u.user_id ? u.user_id.slice(0, 8) + "…" : "Anônimo")}
                    </td>
                    {STAGES.map((s, i) => (
                      <td key={s.key} className="py-3 px-2 text-center">
                        {u.stages.has(s.key) ? (
                          <span
                            className="inline-block w-5 h-5 rounded-full text-white text-xs flex items-center justify-center"
                            style={{ backgroundColor: STAGE_COLORS[i] }}
                          >
                            ✓
                          </span>
                        ) : (
                          <span className="inline-block w-5 h-5 rounded-full bg-gray-800/50 text-gray-600 text-xs flex items-center justify-center">
                            ·
                          </span>
                        )}
                      </td>
                    ))}
                    <td className="py-3 px-4 text-right text-xs text-gray-400">
                      {formatDate(u.lastActivity)}
                    </td>
                  </tr>
                ))}
                {pagedUsers.length === 0 && (
                  <tr>
                    <td colSpan={STAGES.length + 2} className="py-12 text-center text-gray-500">
                      {loading ? "Carregando..." : "Nenhum usuário encontrado"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-3 sm:mt-4 text-xs sm:text-sm">
              <span className="text-gray-500">
                {userPage + 1}/{totalPages}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => setUserPage((p) => Math.max(0, p - 1))}
                  disabled={userPage === 0}
                  className="px-2 sm:px-3 py-1 rounded bg-gray-800/50 text-gray-300 hover:bg-gray-700/60 disabled:opacity-40 border border-gray-700/50 transition-colors"
                >
                  ←
                </button>
                <button
                  onClick={() => setUserPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={userPage >= totalPages - 1}
                  className="px-2 sm:px-3 py-1 rounded bg-gray-800/50 text-gray-300 hover:bg-gray-700/60 disabled:opacity-40 border border-gray-700/50 transition-colors"
                >
                  →
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <footer className="text-center text-xs text-gray-600 pb-4">
          Collection © {new Date().getFullYear()} · Funil de Conversão
        </footer>
      </div>

      {/* Modal for stage users */}
      {selectedStage && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-0 sm:p-4 z-50">
          <div className="bg-gray-900 sm:rounded-2xl max-w-4xl w-full h-full sm:h-auto sm:max-h-[80vh] overflow-hidden border-0 sm:border border-gray-700">
            <div className="flex items-center justify-between p-4 sm:p-6 border-b border-gray-700">
              <h3 className="text-base sm:text-lg font-semibold truncate">
                {STAGES.find(s => s.key === selectedStage)?.label}
              </h3>
              <button
                onClick={() => setSelectedStage(null)}
                className="text-gray-400 hover:text-white transition-colors ml-2 flex-shrink-0"
              >
                ✕
              </button>
            </div>
            <div className="p-3 sm:p-6 overflow-y-auto h-[calc(100vh-60px)] sm:h-auto sm:max-h-[60vh]">
              {stageUsers.length === 0 ? (
                <p className="text-gray-500 text-center py-8 text-sm">Nenhum usuário encontrado nesta etapa</p>
              ) : (
                <div className="space-y-3 sm:space-y-4">
                  {stageUsers.map((user) => (
                    <div key={user.user_id} className="bg-gray-800/30 rounded-lg p-3 sm:p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div className="space-y-1 min-w-0">
                        <p className="font-medium text-sm sm:text-base truncate">{user.email}</p>
                        {user.name && <p className="text-sm text-gray-400">Nome: {user.name}</p>}
                        {user.phone && <p className="text-sm text-gray-400">Telefone: {user.phone}</p>}
                        {user.profession && <p className="text-sm text-gray-400">Profissão: {user.profession}</p>}
                        {user.software && (
                          <p className="text-sm text-gray-400">Software: {user.software.join(", ")}</p>
                        )}
                        {user.projects_per_month && (
                          <p className="text-sm text-gray-400">Projetos/mês: {user.projects_per_month}</p>
                        )}
                        {user.intent && (
                          <p className="text-sm text-gray-400">Jornada: {user.intent}</p>
                        )}
                        {!user.intent && user.interests && (
                          <p className="text-sm text-gray-400">Interesses: {user.interests.join(", ")}</p>
                        )}
                        {user.sketchup_versions && (
                          <p className="text-sm text-gray-400">🔍 SketchUp detectado: {user.sketchup_versions}</p>
                        )}
                        {user.installed_versions && (
                          <p className="text-sm text-emerald-400">✅ Instalou em: {user.installed_versions}</p>
                        )}
                        {/* Onboarding progress */}
                        {(() => {
                          const userEvents = mergedEvents.filter(e => (e.email || e.user_id) === user.email || (e.email || e.user_id) === user.user_id);
                          const userEventSet = new Set(userEvents.map(e => e.event));
                          const onbSteps = ONBOARDING_SUBSTAGES.filter(s => userEventSet.has(s.key));
                          if (onbSteps.length > 0) {
                            const lastStep = onbSteps[onbSteps.length - 1];
                            return (
                              <div className="flex items-center gap-1 mt-1">
                                <span className="text-xs text-gray-500">Onboarding:</span>
                                {ONBOARDING_SUBSTAGES.map((s, i) => (
                                  <span
                                    key={s.key}
                                    title={s.label}
                                    className={`text-sm ${userEventSet.has(s.key) ? "" : "opacity-20 grayscale"}`}
                                  >
                                    {s.icon}
                                  </span>
                                ))}
                                <span className="text-[10px] text-gray-400 ml-1">Parou em: {lastStep.label}</span>
                              </div>
                            );
                          }
                          return null;
                        })()}
                        <p className="text-xs text-gray-500">Criado: {formatDate(user.created_at)}</p>
                        {user.email && <UserActionsList email={user.email} />}
                      </div>
                      <button
                        onClick={() => handleDeleteUser(user.email, user.user_id)}
                        disabled={deletingUser === (user.email || user.user_id)}
                        className="bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm transition-colors self-start sm:self-center flex-shrink-0"
                      >
                        {deletingUser === (user.email || user.user_id) ? "..." : "Deletar"}
                      </button>
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

// ── Card component ─────────────────────────────────────────────
function Card({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-gray-900/50 backdrop-blur-sm rounded-xl p-3 sm:p-4 border border-gray-800/50 hover:bg-gray-800/30 transition-colors">
      <p className="text-[10px] sm:text-xs text-gray-400 uppercase tracking-wide">{label}</p>
      <p className="text-lg sm:text-2xl font-bold mt-0.5 sm:mt-1 tabular-nums">{value}</p>
      {sub && <p className="text-[10px] sm:text-xs text-gray-500 mt-0.5 sm:mt-1 truncate">{sub}</p>}
    </div>
  );
}

// ── Pie Chart Card component ───────────────────────────────────
function PieCard({ title, data }: { title: string; data: [string, number][] }) {
  const total = data.reduce((acc, [_, count]) => acc + count, 0);
  
  if (total === 0) {
    return (
      <div className="bg-gray-900/50 backdrop-blur-sm rounded-xl p-4 border border-gray-800/50">
        <p className="text-xs text-gray-400 uppercase tracking-wide mb-3">{title}</p>
        <div className="flex items-center justify-center h-24">
          <p className="text-gray-500 text-sm">Sem dados</p>
        </div>
      </div>
    );
  }
  
  let cumulativePercentage = 0;
  const segments = data.map(([label, count], index) => {
    const percentage = (count / total) * 100;
    const color = PIE_COLORS[index % PIE_COLORS.length];
    const segment = {
      label,
      count,
      percentage,
      color,
      startAngle: cumulativePercentage * 3.6, // Convert to degrees
    };
    cumulativePercentage += percentage;
    return segment;
  });

  return (
    <div className="bg-gray-900/50 backdrop-blur-sm rounded-xl p-3 sm:p-4 border border-gray-800/50">
      <p className="text-[10px] sm:text-xs text-gray-400 uppercase tracking-wide mb-2 sm:mb-3">{title}</p>
      <div className="flex items-center gap-2 sm:gap-4">
        <div className="relative w-12 h-12 sm:w-16 sm:h-16 flex-shrink-0">
          <div
            className="w-12 h-12 sm:w-16 sm:h-16 rounded-full"
            style={{
              background: `conic-gradient(${segments
                .map(
                  (seg, i) =>
                    `${seg.color} ${seg.startAngle}deg ${
                      seg.startAngle + seg.percentage * 3.6
                    }deg`
                )
                .join(", ")})`,
            }}
          />
          <div className="absolute inset-1.5 sm:inset-2 bg-gray-900 rounded-full flex items-center justify-center">
            <span className="text-[10px] sm:text-xs font-bold">{total}</span>
          </div>
        </div>
        <div className="flex-1 space-y-1">
          {segments.slice(0, 3).map((seg) => (
            <div key={seg.label} className="flex items-center gap-1 sm:gap-2">
              <span
                className="w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: seg.color }}
              />
              <span className="text-[10px] sm:text-xs text-gray-400 truncate flex-1">
                {seg.label}
              </span>
              <span className="text-[10px] sm:text-xs text-gray-300 font-mono">
                {seg.count}
              </span>
            </div>
          ))}
          {data.length > 3 && (
            <div className="text-[10px] sm:text-xs text-gray-500">
              +{data.length - 3}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}