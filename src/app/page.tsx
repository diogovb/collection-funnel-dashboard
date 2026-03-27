"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { supabase } from "@/lib/supabase";

// ── Funnel config ──────────────────────────────────────────────
const STAGES = [
  { key: "signup_completed", label: "Cadastro" },
  { key: "email_confirmed", label: "Email Confirmado" },
  { key: "onboarding_started", label: "Onboarding Iniciado" },
  { key: "onboarding_completed", label: "Onboarding Completo" },
  { key: "installer_opened", label: "Instalador Aberto" },
  { key: "installer_login", label: "Login no Instalador" },
  { key: "plugin_installed", label: "Plugin Instalado" },
] as const;

type StageKey = (typeof STAGES)[number]["key"];

const STAGE_COLORS = [
  "#6366f1", "#8b5cf6", "#a78bfa", "#c084fc", "#d946ef", "#ec4899", "#f43f5e",
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
  software?: string[];
  projects_per_month?: string;
  interests?: string[];
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

  // ── Handle stage click ─────────────────────────────────────────
  const handleStageClick = useCallback(async (stageKey: StageKey) => {
    setSelectedStage(stageKey);
    
    // Get users for this stage with their metadata
    const usersAtStage = new Map<string, StageUser>();
    
    for (const event of events) {
      if (event.event === stageKey) {
        // Find their signup_completed event for metadata
        const signupEvent = events.find(e => 
          e.user_id === event.user_id && e.event === "signup_completed"
        );
        
        const metadata = signupEvent?.metadata as any;
        usersAtStage.set(event.user_id, {
          email: event.email,
          name: metadata?.name,
          phone: metadata?.phone,
          profession: metadata?.profession,
          software: metadata?.software,
          projects_per_month: metadata?.projects_per_month,
          interests: metadata?.interests,
          created_at: event.created_at,
          user_id: event.user_id,
        });
      }
    }
    
    setStageUsers(Array.from(usersAtStage.values()));
  }, [events]);

  // ── Handle user delete ─────────────────────────────────────────
  const handleDeleteUser = useCallback(async (email: string) => {
    if (!confirm(`Tem certeza que deseja deletar todos os eventos para ${email}?`)) {
      return;
    }
    
    setDeletingUser(email);
    
    try {
      const response = await fetch("/api/delete-user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      
      if (response.ok) {
        // Refresh data
        await fetchEvents();
        // Update stage users if modal is open
        if (selectedStage) {
          handleStageClick(selectedStage);
        }
      } else {
        alert("Erro ao deletar usuário");
      }
    } catch (error) {
      alert("Erro ao deletar usuário");
    } finally {
      setDeletingUser(null);
    }
  }, [fetchEvents, selectedStage, handleStageClick]);

  // ── Computed data ──────────────────────────────────────────
  const stageCounts = useMemo(() => {
    const uniqueByStage = new Map<StageKey, Set<string>>();
    STAGES.forEach((s) => uniqueByStage.set(s.key, new Set()));
    for (const ev of events) {
      const stage = ev.event as StageKey;
      uniqueByStage.get(stage)?.add(ev.user_id);
    }
    return STAGES.map((s) => ({
      ...s,
      count: uniqueByStage.get(s.key)?.size ?? 0,
    }));
  }, [events]);

  const maxCount = Math.max(1, ...stageCounts.map((s) => s.count));

  const users = useMemo(() => {
    const map = new Map<string, UserRow>();
    for (const ev of events) {
      const key = ev.user_id;
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
      if (ev.created_at > u.lastActivity) u.lastActivity = ev.created_at;
      // Keep the most recent metadata (usually from signup_completed)
      if (ev.metadata && ev.event === "signup_completed") {
        u.metadata = ev.metadata;
      }
    }
    return Array.from(map.values()).sort(
      (a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime()
    );
  }, [events]);

  // ── Analytics data for pie charts ─────────────────────────────
  const analyticsData = useMemo(() => {
    const signupEvents = events.filter(e => e.event === "signup_completed");
    
    // Profissão
    const professions = new Map<string, number>();
    signupEvents.forEach(event => {
      const profession = (event.metadata as any)?.profession || "Não informado";
      professions.set(profession, (professions.get(profession) || 0) + 1);
    });
    
    // Projetos/mês
    const projects = new Map<string, number>();
    signupEvents.forEach(event => {
      const projectsPerMonth = (event.metadata as any)?.projects_per_month || "Não informado";
      projects.set(projectsPerMonth, (projects.get(projectsPerMonth) || 0) + 1);
    });
    
    // Software (array)
    const software = new Map<string, number>();
    signupEvents.forEach(event => {
      const softwareList = (event.metadata as any)?.software || [];
      if (Array.isArray(softwareList)) {
        softwareList.forEach((sw: string) => {
          software.set(sw, (software.get(sw) || 0) + 1);
        });
      }
    });
    
    // O que trouxe (interests array)
    const interests = new Map<string, number>();
    signupEvents.forEach(event => {
      const interestsList = (event.metadata as any)?.interests || [];
      if (Array.isArray(interestsList)) {
        interestsList.forEach((interest: string) => {
          interests.set(interest, (interests.get(interest) || 0) + 1);
        });
      }
    });
    
    return {
      professions: Array.from(professions.entries()).sort((a, b) => b[1] - a[1]),
      projects: Array.from(projects.entries()).sort((a, b) => b[1] - a[1]),
      software: Array.from(software.entries()).sort((a, b) => b[1] - a[1]),
      interests: Array.from(interests.entries()).sort((a, b) => b[1] - a[1]),
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
      <div className="max-w-7xl mx-auto px-4 py-8 space-y-8">
        {/* Header */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-white to-gray-300 bg-clip-text text-transparent">
              Funil de Conversão
            </h1>
            <p className="text-gray-400 mt-1">Collection — Dashboard em tempo real</p>
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
        <div className="flex flex-wrap items-center gap-3">
          {(["today", "7d", "30d", "90d", "custom"] as DatePreset[]).map((p) => (
            <button
              key={p}
              onClick={() => { setPreset(p); setUserPage(0); }}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 ${
                preset === p
                  ? "bg-gradient-to-r from-indigo-600 to-purple-600 text-white shadow-lg"
                  : "bg-gray-800/50 text-gray-300 hover:bg-gray-700/60 border border-gray-700/50"
              }`}
            >
              {p === "today" ? "Hoje" : p === "7d" ? "7 dias" : p === "30d" ? "30 dias" : p === "90d" ? "90 dias" : "Personalizado"}
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
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
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
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <PieCard title="Profissão" data={analyticsData.professions.slice(0, 5)} />
          <PieCard title="Projetos/mês" data={analyticsData.projects.slice(0, 5)} />
          <PieCard title="Software" data={analyticsData.software.slice(0, 5)} />
          <PieCard title="O que trouxe" data={analyticsData.interests.slice(0, 5)} />
        </div>

        {/* Funnel visualization */}
        <div className="bg-gray-900/50 backdrop-blur-sm rounded-2xl p-6 space-y-4 border border-gray-800/50">
          <h2 className="text-lg font-semibold mb-2">Funil</h2>
          <div className="space-y-3">
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
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-medium text-gray-300 w-52 truncate">
                        {stage.label}
                      </span>
                      <span className="text-xl font-bold tabular-nums">
                        {stage.count.toLocaleString("pt-BR")}
                      </span>
                    </div>
                    <div className="flex items-center gap-4 text-xs text-gray-400">
                      {convFromPrev && (
                        <span>
                          {convFromPrev} do anterior
                        </span>
                      )}
                      {convFromFirst && (
                        <span className="text-gray-500">
                          {convFromFirst} do início
                        </span>
                      )}
                    </div>
                  </div>
                  <div 
                    className="h-10 bg-gray-800/50 rounded-lg overflow-hidden cursor-pointer hover:bg-gray-800/70 transition-all duration-200"
                    onClick={() => handleStageClick(stage.key)}
                    title={`Clique para ver usuários em ${stage.label}`}
                  >
                    <div
                      className="h-full rounded-lg transition-all duration-700 ease-out flex items-center justify-end pr-3 hover:opacity-90"
                      style={{
                        width: `${Math.max(widthPct, 2)}%`,
                        backgroundColor: STAGE_COLORS[i],
                      }}
                    >
                      {widthPct > 15 && (
                        <span className="text-xs font-semibold text-white/90">
                          {stage.count.toLocaleString("pt-BR")}
                        </span>
                      )}
                    </div>
                  </div>
                  {i < stageCounts.length - 1 && (
                    <div className="flex justify-center my-1">
                      <svg width="20" height="16" className="text-gray-600">
                        <path d="M10 0 L10 12 M5 8 L10 14 L15 8" stroke="currentColor" fill="none" strokeWidth="1.5" />
                      </svg>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Stage-to-stage conversion table */}
        <div className="bg-gray-900/50 backdrop-blur-sm rounded-2xl p-6 border border-gray-800/50">
          <h2 className="text-lg font-semibold mb-4">Conversão entre Etapas</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800/50">
                  <th className="text-left py-3 px-4 text-gray-400 font-medium">Etapa</th>
                  <th className="text-right py-3 px-4 text-gray-400 font-medium">Usuários</th>
                  <th className="text-right py-3 px-4 text-gray-400 font-medium">Conv. do Anterior</th>
                  <th className="text-right py-3 px-4 text-gray-400 font-medium">Conv. do Início</th>
                  <th className="text-right py-3 px-4 text-gray-400 font-medium">Drop-off</th>
                </tr>
              </thead>
              <tbody>
                {stageCounts.map((stage, i) => {
                  const prev = i > 0 ? stageCounts[i - 1].count : stage.count;
                  const first = stageCounts[0].count;
                  const dropoff = i > 0 && prev > 0 ? prev - stage.count : 0;
                  return (
                    <tr key={stage.key} className="border-b border-gray-800/30 hover:bg-gray-800/20 transition-colors">
                      <td className="py-3 px-4 flex items-center gap-2">
                        <span
                          className="w-3 h-3 rounded-full inline-block"
                          style={{ backgroundColor: STAGE_COLORS[i] }}
                        />
                        {stage.label}
                      </td>
                      <td className="py-3 px-4 text-right font-mono font-semibold">
                        {stage.count.toLocaleString("pt-BR")}
                      </td>
                      <td className="py-3 px-4 text-right">
                        {i === 0 ? "—" : pct(stage.count, prev)}
                      </td>
                      <td className="py-3 px-4 text-right text-gray-400">
                        {i === 0 ? "100%" : pct(stage.count, first)}
                      </td>
                      <td className="py-3 px-4 text-right text-red-400/80">
                        {dropoff > 0 ? `-${dropoff.toLocaleString("pt-BR")}` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Users table */}
        <div className="bg-gray-900/50 backdrop-blur-sm rounded-2xl p-6 border border-gray-800/50">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-4">
            <h2 className="text-lg font-semibold">
              Usuários ({filteredUsers.length.toLocaleString("pt-BR")})
            </h2>
            <input
              type="text"
              placeholder="Buscar por email..."
              value={searchTerm}
              onChange={(e) => { setSearchTerm(e.target.value); setUserPage(0); }}
              className="bg-gray-800/50 border border-gray-700/50 rounded-lg px-4 py-2 text-sm w-full sm:w-72 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            />
          </div>
          <div className="overflow-x-auto">
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
                  <tr key={u.user_id} className="border-b border-gray-800/30 hover:bg-gray-800/20 transition-colors">
                    <td className="py-3 px-4 font-mono text-xs truncate max-w-[200px]">
                      {u.email || u.user_id.slice(0, 8) + "…"}
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
            <div className="flex items-center justify-between mt-4 text-sm">
              <span className="text-gray-500">
                Página {userPage + 1} de {totalPages}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => setUserPage((p) => Math.max(0, p - 1))}
                  disabled={userPage === 0}
                  className="px-3 py-1 rounded bg-gray-800/50 text-gray-300 hover:bg-gray-700/60 disabled:opacity-40 border border-gray-700/50 transition-colors"
                >
                  ← Anterior
                </button>
                <button
                  onClick={() => setUserPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={userPage >= totalPages - 1}
                  className="px-3 py-1 rounded bg-gray-800/50 text-gray-300 hover:bg-gray-700/60 disabled:opacity-40 border border-gray-700/50 transition-colors"
                >
                  Próxima →
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
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-gray-900 rounded-2xl max-w-4xl w-full max-h-[80vh] overflow-hidden border border-gray-700">
            <div className="flex items-center justify-between p-6 border-b border-gray-700">
              <h3 className="text-lg font-semibold">
                Usuários em: {STAGES.find(s => s.key === selectedStage)?.label}
              </h3>
              <button
                onClick={() => setSelectedStage(null)}
                className="text-gray-400 hover:text-white transition-colors"
              >
                ✕
              </button>
            </div>
            <div className="p-6 overflow-y-auto max-h-[60vh]">
              {stageUsers.length === 0 ? (
                <p className="text-gray-500 text-center py-8">Nenhum usuário encontrado nesta etapa</p>
              ) : (
                <div className="space-y-4">
                  {stageUsers.map((user) => (
                    <div key={user.user_id} className="bg-gray-800/30 rounded-lg p-4 flex items-center justify-between">
                      <div className="space-y-1">
                        <p className="font-medium">{user.email}</p>
                        {user.name && <p className="text-sm text-gray-400">Nome: {user.name}</p>}
                        {user.phone && <p className="text-sm text-gray-400">Telefone: {user.phone}</p>}
                        {user.profession && <p className="text-sm text-gray-400">Profissão: {user.profession}</p>}
                        {user.software && (
                          <p className="text-sm text-gray-400">Software: {user.software.join(", ")}</p>
                        )}
                        {user.projects_per_month && (
                          <p className="text-sm text-gray-400">Projetos/mês: {user.projects_per_month}</p>
                        )}
                        {user.interests && (
                          <p className="text-sm text-gray-400">Interesses: {user.interests.join(", ")}</p>
                        )}
                        <p className="text-xs text-gray-500">Criado: {formatDate(user.created_at)}</p>
                      </div>
                      <button
                        onClick={() => handleDeleteUser(user.email)}
                        disabled={deletingUser === user.email}
                        className="bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm transition-colors"
                      >
                        {deletingUser === user.email ? "Deletando..." : "Deletar"}
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
    <div className="bg-gray-900/50 backdrop-blur-sm rounded-xl p-4 border border-gray-800/50 hover:bg-gray-800/30 transition-colors">
      <p className="text-xs text-gray-400 uppercase tracking-wide">{label}</p>
      <p className="text-2xl font-bold mt-1 tabular-nums">{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-1 truncate">{sub}</p>}
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
    <div className="bg-gray-900/50 backdrop-blur-sm rounded-xl p-4 border border-gray-800/50">
      <p className="text-xs text-gray-400 uppercase tracking-wide mb-3">{title}</p>
      <div className="flex items-center gap-4">
        <div className="relative w-16 h-16">
          <div
            className="w-16 h-16 rounded-full"
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
          <div className="absolute inset-2 bg-gray-900 rounded-full flex items-center justify-center">
            <span className="text-xs font-bold">{total}</span>
          </div>
        </div>
        <div className="flex-1 space-y-1">
          {segments.slice(0, 3).map((seg) => (
            <div key={seg.label} className="flex items-center gap-2">
              <span
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: seg.color }}
              />
              <span className="text-xs text-gray-400 truncate flex-1">
                {seg.label}
              </span>
              <span className="text-xs text-gray-300 font-mono">
                {seg.count}
              </span>
            </div>
          ))}
          {data.length > 3 && (
            <div className="text-xs text-gray-500">
              +{data.length - 3} outros
            </div>
          )}
        </div>
      </div>
    </div>
  );
}