"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { supabase } from "@/lib/supabase";
import AutomationPanel, { UserActionsList } from "@/components/AutomationPanel";

const FUNNEL_STEPS = [
  { key: "signup_completed", label: "Cadastro", icon: "📋", desc: "Criaram conta" },
  { key: "first_download", label: "1º Download", icon: "📥", desc: "Baixaram o primeiro bloco" },
] as const;

const FUNNEL_COLORS = ["#6366f1", "#a855f7"];
const SEG_COLORS = ["#3B82F6", "#8B5CF6", "#EC4899", "#F59E0B", "#10B981", "#06B6D4"];

const PROFESSION_LABELS: Record<string, string> = {
  arquiteto: "Arquiteto(a)",
  designer_interiores: "Designer de Interiores",
  engenheiro: "Engenheiro(a)",
  projetista: "Projetista",
  estudante: "Estudante",
  outro: "Outro",
};

interface FunnelEvent {
  id: string;
  user_id: string;
  email: string;
  event: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

interface UserJourney {
  key: string;
  name: string;
  email: string;
  profession: string;
  method: string;
  platform: string;
  stepsCompleted: Set<string>;
  lastStep: string;
  lastStepLabel: string;
  firstSeen: string;
  lastSeen: string;
  allEvents: FunnelEvent[];
}

type DatePreset = "today" | "7d" | "30d" | "90d" | "custom";

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
    let allData: FunnelEvent[] = [];
    let page = 0;
    const PAGE_SIZE = 1000;
    while (true) {
      const { data, error } = await supabase
        .from("funnel_events")
        .select("*")
        .gte("created_at", dateFrom)
        .lte("created_at", dateTo)
        .order("created_at", { ascending: true })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
      if (error || !data) break;
      allData = allData.concat(data as FunnelEvent[]);
      if (data.length < PAGE_SIZE) break;
      page++;
    }
    setEvents(allData);
    setLastRefresh(new Date());
    setLoading(false);
  }, [dateFrom, dateTo]);

  useEffect(() => { fetchEvents(); }, [fetchEvents]);
  useEffect(() => {
    const interval = setInterval(fetchEvents, 30_000);
    return () => clearInterval(interval);
  }, [fetchEvents]);

  useEffect(() => {
    const syncDownloads = () => fetch("/api/sync-downloads", { method: "POST" }).catch(() => {});
    syncDownloads();
    const interval = setInterval(syncDownloads, 5 * 60_000);
    return () => clearInterval(interval);
  }, []);

  const journeys = useMemo(() => {
    const uidToEmail = new Map<string, string>();
    const sidToEmail = new Map<string, string>();
    const sidToUid = new Map<string, string>();

    for (const ev of events) {
      const sid = (ev.metadata as any)?.session_id;
      if (ev.user_id && ev.email) uidToEmail.set(ev.user_id, ev.email);
      if (sid && ev.email) sidToEmail.set(sid, ev.email);
      if (sid && ev.user_id) sidToUid.set(sid, ev.user_id);
    }

    const enriched = events.map(ev => {
      let email = ev.email;
      let userId = ev.user_id;
      const sid = (ev.metadata as any)?.session_id;
      if (userId && sid && userId === sid) userId = "";
      if (!email && userId) email = uidToEmail.get(userId) || "";
      if (!email && sid) email = sidToEmail.get(sid) || "";
      if (!userId && sid) userId = sidToUid.get(sid) || "";
      return { ...ev, email, user_id: userId };
    });

    const map = new Map<string, UserJourney>();
    for (const ev of enriched) {
      const sid = (ev.metadata as any)?.session_id;
      const key = ev.email || sid || ev.user_id || ev.id;
      if (!map.has(key)) {
        map.set(key, {
          key,
          name: "", email: "", profession: "", method: "", platform: "",
          stepsCompleted: new Set(),
          lastStep: "", lastStepLabel: "",
          firstSeen: ev.created_at,
          lastSeen: ev.created_at,
          allEvents: [],
        });
      }
      const j = map.get(key)!;
      j.allEvents.push(ev);
      const m = (ev.metadata || {}) as any;
      if (m.name && !j.name) j.name = m.name;
      if (ev.email && !j.email) j.email = ev.email;
      if (m.profession && !j.profession) j.profession = m.profession;
      if (m.method && !j.method && ev.event === "signup_completed") j.method = m.method;
      if (m.platform && !j.platform) j.platform = m.platform;
      if (FUNNEL_STEPS.some(s => s.key === ev.event)) j.stepsCompleted.add(ev.event);
      if (ev.created_at > j.lastSeen) j.lastSeen = ev.created_at;
      if (ev.created_at < j.firstSeen) j.firstSeen = ev.created_at;
    }

    for (const j of map.values()) {
      for (let i = FUNNEL_STEPS.length - 1; i >= 0; i--) {
        if (j.stepsCompleted.has(FUNNEL_STEPS[i].key)) {
          j.lastStep = FUNNEL_STEPS[i].key;
          j.lastStepLabel = FUNNEL_STEPS[i].label;
          break;
        }
      }
    }

    return Array.from(map.values()).sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime());
  }, [events]);

  const funnelCounts = useMemo(() => {
    return FUNNEL_STEPS.map(s => ({
      ...s,
      // first_download only counts users who also have signup_completed (real funnel)
      count: journeys.filter(j =>
        j.stepsCompleted.has(s.key) &&
        (s.key === "signup_completed" || j.stepsCompleted.has("signup_completed"))
      ).length,
    }));
  }, [journeys]);

  const analytics = useMemo(() => {
    const profs = new Map<string, number>();
    const platforms = new Map<string, number>();
    const methods = new Map<string, number>();

    for (const j of journeys) {
      if (j.profession) {
        const label = PROFESSION_LABELS[j.profession] || j.profession;
        profs.set(label, (profs.get(label) || 0) + 1);
      }
      if (j.platform) {
        const label = j.platform === "mobile" ? "Mobile" : "Desktop";
        platforms.set(label, (platforms.get(label) || 0) + 1);
      }
      if (j.method) {
        const label = j.method === "google" ? "Google" : "Email/Senha";
        methods.set(label, (methods.get(label) || 0) + 1);
      }
    }

    return {
      professions: Array.from(profs.entries()).sort((a, b) => b[1] - a[1]),
      platforms: Array.from(platforms.entries()).sort((a, b) => b[1] - a[1]),
      methods: Array.from(methods.entries()).sort((a, b) => b[1] - a[1]),
    };
  }, [journeys]);

  const usersAtStep = useMemo(() => selectedStep ? journeys.filter(j =>
    j.stepsCompleted.has(selectedStep) &&
    (selectedStep === "signup_completed" || j.stepsCompleted.has("signup_completed"))
  ) : [], [journeys, selectedStep]);

  const filteredJourneys = useMemo(() => {
    if (!searchTerm) return journeys;
    const q = searchTerm.toLowerCase();
    return journeys.filter(j => j.name?.toLowerCase().includes(q) || j.email?.toLowerCase().includes(q) || j.profession?.toLowerCase().includes(q));
  }, [journeys, searchTerm]);

  const pagedJourneys = filteredJourneys.slice(userPage * USERS_PER_PAGE, (userPage + 1) * USERS_PER_PAGE);
  const totalPages = Math.ceil(filteredJourneys.length / USERS_PER_PAGE);
  const topCount = funnelCounts[0]?.count || 1;

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-5xl mx-auto px-3 sm:px-4 py-4 sm:py-8 space-y-4 sm:space-y-6">

        {/* Header */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight bg-gradient-to-r from-white to-gray-400 bg-clip-text text-transparent">
              Funil de Onboarding
            </h1>
            <p className="text-gray-500 mt-1 text-sm">Collection — acompanhamento em tempo real</p>
          </div>
          <div className="flex items-center gap-2 text-sm text-gray-500">
            {loading && <span className="inline-block w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />}
            <span>{lastRefresh.toLocaleTimeString("pt-BR")} · 30s</span>
          </div>
        </div>

        {/* Date filters */}
        <div className="flex flex-wrap items-center gap-2">
          {(["today", "7d", "30d", "90d", "custom"] as DatePreset[]).map(p => (
            <button
              key={p}
              onClick={() => { setPreset(p); setUserPage(0); }}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
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
              <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} className="bg-gray-800/50 border border-gray-700/50 rounded-lg px-3 py-1.5 text-sm" />
              <span className="text-gray-500">até</span>
              <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} className="bg-gray-800/50 border border-gray-700/50 rounded-lg px-3 py-1.5 text-sm" />
            </div>
          )}
          <button onClick={fetchEvents} className="ml-auto px-3 py-1.5 rounded-lg text-sm bg-gray-800/50 text-gray-300 hover:bg-gray-700/60 border border-gray-700/50">↻</button>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-3 gap-2 sm:gap-4">
          {funnelCounts.map((step, i) => {
            const prev = i > 0 ? funnelCounts[i - 1].count : null;
            const conv = prev !== null && prev > 0 ? ((step.count / prev) * 100).toFixed(1) + "%" : null;
            return (
              <SummaryCard
                key={step.key}
                label={step.label}
                value={step.count}
                sub={step.desc}
                conversion={conv}
                color={FUNNEL_COLORS[i]}
              />
            );
          })}
        </div>

        {/* Funnel visualization */}
        <div className="bg-gray-900/50 backdrop-blur-sm rounded-2xl p-5 sm:p-8 border border-gray-800/50">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-6">Funil de conversão</h2>
          <div className="space-y-1">
            {funnelCounts.map((step, i) => {
              const widthPct = topCount > 0 ? (step.count / topCount) * 100 : 0;
              const prev = i > 0 ? funnelCounts[i - 1].count : null;
              const convRate = prev !== null && prev > 0 ? ((step.count / prev) * 100).toFixed(1) : null;
              const dropRate = prev !== null && prev > 0 ? (((prev - step.count) / prev) * 100).toFixed(1) : null;

              return (
                <div key={step.key}>
                  {/* Conversion connector between steps */}
                  {i > 0 && (
                    <div className="flex items-center justify-center py-3 gap-3">
                      <div className="flex-1 border-t border-dashed border-gray-800" />
                      <div className="flex items-center gap-2 text-xs">
                        <span className="px-2 py-0.5 rounded-full bg-green-900/40 text-green-400 font-medium">
                          ↓ {convRate}%
                        </span>
                        <span className="px-2 py-0.5 rounded-full bg-red-900/30 text-red-400">
                          {dropRate}% saíram
                        </span>
                      </div>
                      <div className="flex-1 border-t border-dashed border-gray-800" />
                    </div>
                  )}

                  {/* Funnel bar — centered, narrowing */}
                  <div
                    className="cursor-pointer group"
                    onClick={() => setSelectedStep(step.key)}
                  >
                    <div className="flex items-center gap-3 mb-1.5 px-1">
                      <span className="text-base">{step.icon}</span>
                      <span className="text-sm font-medium" style={{ color: FUNNEL_COLORS[i] }}>{step.label}</span>
                      <span className="text-xs text-gray-500 ml-auto">{step.desc}</span>
                    </div>
                    <div className="relative h-11 bg-gray-800/40 rounded-xl overflow-hidden group-hover:bg-gray-800/60 transition-colors">
                      {/* centered funnel bar */}
                      <div
                        className="absolute top-0 bottom-0 rounded-xl transition-all duration-700"
                        style={{
                          width: `${Math.max(widthPct, 2)}%`,
                          left: `${(100 - Math.max(widthPct, 2)) / 2}%`,
                          background: `linear-gradient(90deg, ${FUNNEL_COLORS[i]}99, ${FUNNEL_COLORS[i]}, ${FUNNEL_COLORS[i]}99)`,
                        }}
                      />
                      {/* count label inside bar */}
                      <div className="absolute inset-0 flex items-center justify-center gap-2">
                        <span className="text-base font-bold tabular-nums drop-shadow-md">{step.count}</span>
                        <span className="text-xs text-white/60 drop-shadow-md">
                          {topCount > 0 ? ((step.count / topCount) * 100).toFixed(0) : 0}%
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Segmentation */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <SegCard title="Plataforma" data={analytics.platforms} />
          <SegCard title="Método de cadastro" data={analytics.methods} />
          <SegCard title="Profissão" data={analytics.professions.slice(0, 6)} />
        </div>

        {/* Automations */}
        <div className="bg-gray-900/50 rounded-2xl p-3 sm:p-6 border border-gray-800">
          <AutomationPanel />
        </div>

        {/* User list */}
        <div className="bg-gray-900/50 backdrop-blur-sm rounded-2xl p-3 sm:p-6 border border-gray-800/50">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-3">
            <h2 className="text-base sm:text-lg font-semibold">Usuários ({filteredJourneys.length})</h2>
            <input
              type="text"
              placeholder="Buscar por nome ou email..."
              value={searchTerm}
              onChange={e => { setSearchTerm(e.target.value); setUserPage(0); }}
              className="bg-gray-800/50 border border-gray-700/50 rounded-lg px-3 py-2 text-sm w-full sm:w-72 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div className="space-y-2">
            {pagedJourneys.map(j => (
              <div
                key={j.key}
                className="bg-gray-800/30 rounded-lg p-3 hover:bg-gray-800/50 cursor-pointer transition-all"
                onClick={() => setSelectedUser(j)}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm truncate">{j.name || j.email || j.key.slice(0, 8) + "…"}</span>
                      {j.profession && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300">
                          {PROFESSION_LABELS[j.profession] || j.profession}
                        </span>
                      )}
                      {j.platform && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-500/20 text-slate-300">
                          {j.platform === "mobile" ? "Mobile" : "Desktop"}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-400 truncate mt-0.5">{j.email || "Sem email"}</p>
                  </div>
                  <div className="text-xs text-gray-500 shrink-0">{j.lastStepLabel || "—"}</div>
                </div>
              </div>
            ))}
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4 pt-3 border-t border-gray-800">
              <button
                onClick={() => setUserPage(p => Math.max(0, p - 1))}
                disabled={userPage === 0}
                className="px-3 py-1.5 rounded-lg text-xs bg-gray-800/50 text-gray-300 hover:bg-gray-700/60 border border-gray-700/50 disabled:opacity-40"
              >
                ← Anterior
              </button>
              <span className="text-xs text-gray-500">{userPage + 1} / {totalPages}</span>
              <button
                onClick={() => setUserPage(p => Math.min(totalPages - 1, p + 1))}
                disabled={userPage === totalPages - 1}
                className="px-3 py-1.5 rounded-lg text-xs bg-gray-800/50 text-gray-300 hover:bg-gray-700/60 border border-gray-700/50 disabled:opacity-40"
              >
                Próximo →
              </button>
            </div>
          )}
        </div>

        <footer className="text-center text-xs text-gray-600 py-4">Atualização automática a cada 30s</footer>
      </div>

      {/* User detail modal */}
      {selectedUser && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-0 sm:p-4 z-50"
          onClick={() => setSelectedUser(null)}
        >
          <div
            className="bg-gray-900 sm:rounded-2xl max-w-2xl w-full h-full sm:h-auto sm:max-h-[85vh] overflow-hidden border-0 sm:border border-gray-700"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-gray-700">
              <div>
                <h3 className="text-lg font-semibold">{selectedUser.name || selectedUser.email || "Usuário"}</h3>
                <p className="text-xs text-gray-400">{selectedUser.email || selectedUser.key}</p>
              </div>
              <button onClick={() => setSelectedUser(null)} className="text-gray-400 hover:text-white text-xl">✕</button>
            </div>
            <div className="p-4 overflow-y-auto h-[calc(100vh-60px)] sm:h-auto sm:max-h-[calc(85vh-60px)] space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <Meta label="Profissão" value={PROFESSION_LABELS[selectedUser.profession] || selectedUser.profession || "—"} />
                <Meta label="Plataforma" value={selectedUser.platform || "—"} />
                <Meta label="Método" value={selectedUser.method === "google" ? "Google" : selectedUser.method ? "Email/Senha" : "—"} />
                <Meta label="Desde" value={selectedUser.firstSeen ? formatDate(selectedUser.firstSeen) : "—"} />
              </div>
              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Eventos</p>
                <div className="space-y-1.5">
                  {selectedUser.allEvents.filter(ev => [
                    "signup_completed", "onboarding_started", "first_download"
                  ].includes(ev.event)).map(ev => {
                    const step = FUNNEL_STEPS.find(s => s.key === ev.event);
                    return (
                      <div key={ev.id} className="bg-gray-800/30 rounded-lg p-3 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="text-base">{step?.icon || "•"}</span>
                          <span className="text-sm font-medium">{step?.label || ev.event}</span>
                        </div>
                        <span className="text-xs text-gray-500">{formatDate(ev.created_at)}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
              {selectedUser.email && (
                <div className="border-t border-gray-800 pt-3">
                  <UserActionsList email={selectedUser.email} />
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Step drill-down modal */}
      {selectedStep && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-0 sm:p-4 z-50"
          onClick={() => setSelectedStep(null)}
        >
          <div
            className="bg-gray-900 sm:rounded-2xl max-w-3xl w-full h-full sm:h-auto sm:max-h-[80vh] overflow-hidden border-0 sm:border border-gray-700"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-gray-700">
              <div className="flex items-center gap-2">
                <span className="text-xl">{FUNNEL_STEPS.find(s => s.key === selectedStep)?.icon}</span>
                <h3 className="text-lg font-semibold">{FUNNEL_STEPS.find(s => s.key === selectedStep)?.label}</h3>
                <span className="text-sm text-gray-400">({usersAtStep.length} usuários)</span>
              </div>
              <button onClick={() => setSelectedStep(null)} className="text-gray-400 hover:text-white text-xl">✕</button>
            </div>
            <div className="p-3 sm:p-4 overflow-y-auto h-[calc(100vh-60px)] sm:h-auto sm:max-h-[calc(80vh-60px)] space-y-2">
              {usersAtStep.map(j => (
                <div
                  key={j.key}
                  className="bg-gray-800/30 rounded-lg p-3 hover:bg-gray-800/50 cursor-pointer transition-all"
                  onClick={() => { setSelectedStep(null); setSelectedUser(j); }}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-medium text-sm">{j.name || j.email || j.key.slice(0, 8) + "…"}</div>
                      <div className="text-xs text-gray-400">{j.email || "Sem email"}</div>
                    </div>
                    <div className="text-xs text-gray-500">{j.platform || "—"}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryCard({ label, value, sub, conversion, color }: {
  label: string; value: number; sub: string; conversion: string | null; color: string;
}) {
  return (
    <div className="bg-gray-900/50 backdrop-blur-sm rounded-2xl p-4 border border-gray-800/50 relative overflow-hidden">
      <div className="absolute inset-0 opacity-5 pointer-events-none" style={{ background: `radial-gradient(circle at 80% 20%, ${color}, transparent 60%)` }} />
      <div className="text-2xl sm:text-3xl font-bold tabular-nums">{value}</div>
      <div className="text-sm font-medium text-gray-200 mt-1">{label}</div>
      <div className="text-xs text-gray-500 mt-0.5">{sub}</div>
      {conversion && (
        <div className="mt-2 text-xs font-semibold" style={{ color }}>{conversion} da etapa anterior</div>
      )}
    </div>
  );
}

function SegCard({ title, data }: { title: string; data: [string, number][] }) {
  const total = data.reduce((acc, [, v]) => acc + v, 0);
  return (
    <div className="bg-gray-900/50 backdrop-blur-sm rounded-2xl p-4 border border-gray-800/50">
      <h3 className="text-sm font-semibold text-gray-300 mb-3">{title}</h3>
      <div className="space-y-3">
        {data.length === 0 ? (
          <p className="text-xs text-gray-500">Sem dados</p>
        ) : (
          data.map(([label, value], i) => (
            <div key={label}>
              <div className="flex items-center justify-between text-xs mb-1">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: SEG_COLORS[i % SEG_COLORS.length] }} />
                  <span className="truncate text-gray-300">{label}</span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0 ml-2">
                  <span className="font-medium text-gray-200">{value}</span>
                  <span className="text-gray-600">·</span>
                  <span className="text-gray-500">{total > 0 ? ((value / total) * 100).toFixed(0) : 0}%</span>
                </div>
              </div>
              <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-700"
                  style={{
                    width: `${total > 0 ? (value / total) * 100 : 0}%`,
                    backgroundColor: SEG_COLORS[i % SEG_COLORS.length],
                  }}
                />
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-800/30 rounded-lg p-2.5">
      <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className="text-sm text-gray-200 mt-1 truncate">{value}</div>
    </div>
  );
}
