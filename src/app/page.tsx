"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { supabase } from "@/lib/supabase";
import AutomationPanel, { UserActionsList } from "@/components/AutomationPanel";

const FUNNEL_STEPS = [
  { key: "signup_completed", label: "Cadastro", icon: "📋", color: "#6366f1" },
  { key: "installer_login", label: "Acesso", icon: "🔐", color: "#8b5cf6" },
  { key: "first_download", label: "1º Download", icon: "📥", color: "#10b981" },
] as const;

const PROFESSION_LABELS: Record<string, string> = {
  arquiteto: "Arquiteto(a)",
  designer_interiores: "Designer de Interiores",
  engenheiro: "Engenheiro(a)",
  projetista: "Projetista",
  estudante: "Estudante",
  outro: "Outro",
};

const PIE_COLORS = ["#3B82F6", "#8B5CF6", "#EC4899", "#F59E0B", "#10B981", "#06B6D4"];

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
  phone: string;
  profession: string;
  platform: string;
  signupMethod: string;
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

function pct(a: number, b: number): string {
  if (b === 0) return "—";
  return ((a / b) * 100).toFixed(1) + "%";
}

export default function Dashboard() {
  const [events, setEvents] = useState<FunnelEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [preset, setPreset] = useState<DatePreset>("today");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [searchTerm, setSearchTerm] = useState("");
  const [userPage, setUserPage] = useState(0);
  const [selectedUser, setSelectedUser] = useState<UserJourney | null>(null);
  const [selectedStep, setSelectedStep] = useState<string | null>(null);
  const [deletingUser, setDeletingUser] = useState(false);
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

  const handleSync = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch("/api/sync-downloads", { method: "POST" });
      const data = await res.json();
      setSyncResult(data.message || (data.error ? `❌ ${data.error}` : "✅ Sincronizado"));
      await fetchEvents();
    } catch {
      setSyncResult("❌ Erro ao sincronizar");
    }
    setSyncing(false);
  };

  const handleDeleteUser = async (userId: string, email: string) => {
    if (!confirm(`Deletar usuário ${email}? Esta ação não pode ser desfeita.`)) return;
    setDeletingUser(true);
    try {
      const res = await fetch("/api/delete-user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      const data = await res.json();
      if (data.success) {
        setSelectedUser(null);
        await fetchEvents();
      } else {
        alert(`Erro ao deletar: ${data.error || "Desconhecido"}`);
      }
    } catch {
      alert("Erro ao deletar usuário");
    }
    setDeletingUser(false);
  };

  const journeys = useMemo(() => {
    const uidToEmail = new Map<string, string>();
    const sidToEmail = new Map<string, string>();
    const sidToUid = new Map<string, string>();

    for (const ev of events) {
      const sid = (ev.metadata as Record<string, unknown>)?.session_id as string | undefined;
      if (ev.user_id && ev.email) uidToEmail.set(ev.user_id, ev.email);
      if (sid && ev.email) sidToEmail.set(sid, ev.email);
      if (sid && ev.user_id) sidToUid.set(sid, ev.user_id);
    }

    const enriched = events.map(ev => {
      let email = ev.email;
      let userId = ev.user_id;
      const sid = (ev.metadata as Record<string, unknown>)?.session_id as string | undefined;
      if (userId && sid && userId === sid) userId = "";
      if (!email && userId) email = uidToEmail.get(userId) || "";
      if (!email && sid) email = sidToEmail.get(sid) || "";
      if (!userId && sid) userId = sidToUid.get(sid) || "";
      return { ...ev, email, user_id: userId };
    });

    const map = new Map<string, UserJourney>();
    for (const ev of enriched) {
      const sid = (ev.metadata as Record<string, unknown>)?.session_id as string | undefined;
      const key = ev.email || sid || ev.user_id || ev.id;
      if (!map.has(key)) {
        map.set(key, {
          key,
          name: "", email: "", phone: "", profession: "", platform: "", signupMethod: "",
          stepsCompleted: new Set(),
          lastStep: "", lastStepLabel: "",
          firstSeen: ev.created_at,
          lastSeen: ev.created_at,
          allEvents: [],
        });
      }
      const j = map.get(key)!;
      j.allEvents.push(ev);
      const m = (ev.metadata || {}) as Record<string, unknown>;
      if (m.name && !j.name) j.name = String(m.name);
      if (ev.email && !j.email) j.email = ev.email;
      if (m.phone && !j.phone) j.phone = String(m.phone);
      if (m.profession && !j.profession) j.profession = String(m.profession);
      if (m.method && !j.signupMethod && ev.event === "signup_completed") j.signupMethod = String(m.method);
      if (m.platform && !j.platform) j.platform = String(m.platform);
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
      count: journeys.filter(j => j.stepsCompleted.has(s.key)).length,
    }));
  }, [journeys]);

  // Segmentações
  const segmentations = useMemo(() => {
    const cadastro = funnelCounts[0].count;

    // Mobile vs Desktop (based on all users with platform set, or all signups)
    const mobileSignups = journeys.filter(j => j.platform === "mobile" && j.stepsCompleted.has("signup_completed")).length;
    const desktopSignups = journeys.filter(j => j.platform === "desktop" && j.stepsCompleted.has("signup_completed")).length;
    const mobileDownloads = journeys.filter(j => j.platform === "mobile" && j.stepsCompleted.has("first_download")).length;
    const desktopDownloads = journeys.filter(j => j.platform === "desktop" && j.stepsCompleted.has("first_download")).length;

    // Google vs Email/Senha
    const googleSignups = journeys.filter(j => j.signupMethod === "google" && j.stepsCompleted.has("signup_completed")).length;
    const emailSignups = journeys.filter(j => j.signupMethod && j.signupMethod !== "google" && j.stepsCompleted.has("signup_completed")).length;
    const googleDownloads = journeys.filter(j => j.signupMethod === "google" && j.stepsCompleted.has("first_download")).length;
    const emailDownloads = journeys.filter(j => j.signupMethod && j.signupMethod !== "google" && j.stepsCompleted.has("first_download")).length;

    // Profissão
    const profs = new Map<string, { cadastro: number; download: number }>();
    for (const j of journeys) {
      if (!j.profession) continue;
      const label = PROFESSION_LABELS[j.profession] || j.profession;
      if (!profs.has(label)) profs.set(label, { cadastro: 0, download: 0 });
      const p = profs.get(label)!;
      if (j.stepsCompleted.has("signup_completed")) p.cadastro++;
      if (j.stepsCompleted.has("first_download")) p.download++;
    }

    return {
      cadastro,
      mobile: { signups: mobileSignups, downloads: mobileDownloads },
      desktop: { signups: desktopSignups, downloads: desktopDownloads },
      google: { signups: googleSignups, downloads: googleDownloads },
      email: { signups: emailSignups, downloads: emailDownloads },
      professions: Array.from(profs.entries()).sort((a, b) => b[1].cadastro - a[1].cadastro),
    };
  }, [journeys, funnelCounts]);

  const usersAtStep = useMemo(() =>
    selectedStep ? journeys.filter(j => j.stepsCompleted.has(selectedStep)) : [],
    [journeys, selectedStep]
  );

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
  const maxFunnelCount = Math.max(1, funnelCounts[0]?.count || 1);

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-7xl mx-auto px-3 sm:px-4 py-4 sm:py-8 space-y-4 sm:space-y-6">

        {/* Header */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight bg-gradient-to-r from-white to-gray-300 bg-clip-text text-transparent">
              🎯 Funil Collection
            </h1>
            <p className="text-gray-400 mt-1 text-xs sm:text-base">Cadastro → Acesso → 1º Download</p>
          </div>
          <div className="flex items-center gap-3 text-sm text-gray-400">
            {loading && <span className="inline-block w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />}
            <span>{lastRefresh.toLocaleTimeString("pt-BR")} · 30s</span>
            <button
              onClick={handleSync}
              disabled={syncing}
              className="px-3 py-1.5 rounded-lg text-xs bg-gray-800/50 text-gray-300 hover:bg-gray-700/60 border border-gray-700/50 disabled:opacity-50"
            >
              {syncing ? "Sincronizando..." : "↻ Metabase"}
            </button>
          </div>
        </div>

        {syncResult && (
          <div className="bg-gray-800/50 rounded-lg px-4 py-2 text-sm text-gray-300">{syncResult}</div>
        )}

        {/* Date presets */}
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

        {/* FUNIL VISUAL */}
        <div className="bg-gray-900/50 backdrop-blur-sm rounded-2xl p-4 sm:p-6 border border-gray-800/50">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-base sm:text-lg font-semibold">Funil de conversão</h2>
            <span className="text-xs text-gray-500">{journeys.length} usuários no período</span>
          </div>

          <div className="space-y-1">
            {funnelCounts.map((step, i) => {
              const widthPct = (step.count / maxFunnelCount) * 100;
              const prevCount = i > 0 ? funnelCounts[i - 1].count : step.count;
              const convPct = i > 0 ? pct(step.count, prevCount) : null;
              const dropCount = i > 0 ? prevCount - step.count : 0;

              return (
                <div key={step.key} className="flex flex-col items-center">
                  {/* Conversão entre etapas */}
                  {i > 0 && (
                    <div className="flex items-center gap-3 py-2 text-xs">
                      <span className="text-gray-500">▼</span>
                      <span className="text-emerald-400 font-medium">{convPct} conversão</span>
                      {dropCount > 0 && <span className="text-red-400">−{dropCount} saíram</span>}
                    </div>
                  )}

                  {/* Barra de funil (centralizada, diminui a cada etapa) */}
                  <div
                    className="w-full cursor-pointer group"
                    style={{ paddingLeft: `${(100 - widthPct) / 2}%`, paddingRight: `${(100 - widthPct) / 2}%` }}
                    onClick={() => setSelectedStep(step.key)}
                  >
                    <div
                      className="rounded-xl transition-all duration-700 ease-out group-hover:opacity-90 flex items-center justify-between px-4 sm:px-6"
                      style={{ backgroundColor: step.color, height: "56px" }}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-lg">{step.icon}</span>
                        <span className="font-semibold text-sm sm:text-base text-white">{step.label}</span>
                      </div>
                      <div className="text-right">
                        <div className="text-xl sm:text-2xl font-bold text-white tabular-nums">{step.count}</div>
                        <div className="text-[10px] text-white/70">
                          {pct(step.count, funnelCounts[0].count)} do total
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* SEGMENTAÇÕES */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

          {/* Mobile vs Desktop */}
          <div className="bg-gray-900/50 backdrop-blur-sm rounded-2xl p-4 sm:p-5 border border-gray-800/50">
            <h3 className="text-sm font-semibold mb-4">Plataforma</h3>
            <div className="space-y-3">
              <SegRow
                label="📱 Mobile"
                signups={segmentations.mobile.signups}
                downloads={segmentations.mobile.downloads}
                totalSignups={segmentations.cadastro}
                color="#3B82F6"
              />
              <SegRow
                label="🖥️ Desktop"
                signups={segmentations.desktop.signups}
                downloads={segmentations.desktop.downloads}
                totalSignups={segmentations.cadastro}
                color="#8B5CF6"
              />
            </div>
          </div>

          {/* Google vs Email */}
          <div className="bg-gray-900/50 backdrop-blur-sm rounded-2xl p-4 sm:p-5 border border-gray-800/50">
            <h3 className="text-sm font-semibold mb-4">Método de cadastro</h3>
            <div className="space-y-3">
              <SegRow
                label="🔵 Google"
                signups={segmentations.google.signups}
                downloads={segmentations.google.downloads}
                totalSignups={segmentations.cadastro}
                color="#3B82F6"
              />
              <SegRow
                label="✉️ Email/Senha"
                signups={segmentations.email.signups}
                downloads={segmentations.email.downloads}
                totalSignups={segmentations.cadastro}
                color="#EC4899"
              />
            </div>
          </div>
        </div>

        {/* Profissão */}
        {segmentations.professions.length > 0 && (
          <div className="bg-gray-900/50 backdrop-blur-sm rounded-2xl p-4 sm:p-5 border border-gray-800/50">
            <h3 className="text-sm font-semibold mb-4">Profissão</h3>
            <div className="space-y-3">
              {segmentations.professions.map(([label, counts], i) => (
                <div key={label} className="space-y-1">
                  <div className="flex items-center justify-between text-xs gap-2">
                    <div className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }} />
                      <span className="text-gray-300">{label}</span>
                    </div>
                    <div className="flex items-center gap-3 text-gray-400 tabular-nums">
                      <span>{counts.cadastro} cadastros</span>
                      <span className="text-emerald-400">{pct(counts.download, counts.cadastro)} download</span>
                    </div>
                  </div>
                  <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${segmentations.cadastro > 0 ? (counts.cadastro / segmentations.cadastro) * 100 : 0}%`,
                        backgroundColor: PIE_COLORS[i % PIE_COLORS.length],
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* AutomationPanel */}
        <div className="bg-gray-900/50 rounded-2xl p-3 sm:p-6 border border-gray-800">
          <AutomationPanel />
        </div>

        {/* Lista de usuários */}
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
                          {j.platform === "mobile" ? "📱" : "🖥️"} {j.platform}
                        </span>
                      )}
                      {j.signupMethod && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300">
                          {j.signupMethod === "google" ? "Google" : "Email"}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-400 truncate mt-1">{j.email || "Sem email"}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex gap-0.5">
                      {FUNNEL_STEPS.map(s => (
                        <div
                          key={s.key}
                          className="w-2 h-2 rounded-full"
                          style={{ backgroundColor: j.stepsCompleted.has(s.key) ? s.color : "#374151" }}
                          title={s.label}
                        />
                      ))}
                    </div>
                    <div className="text-xs text-gray-500">{j.lastStepLabel || "—"}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
          {filteredJourneys.length > USERS_PER_PAGE && (
            <div className="flex justify-center gap-2 mt-4">
              <button
                onClick={() => setUserPage(p => Math.max(0, p - 1))}
                disabled={userPage === 0}
                className="px-3 py-1.5 text-xs rounded-lg bg-gray-800 disabled:opacity-40 hover:bg-gray-700"
              >
                ← Anterior
              </button>
              <span className="px-3 py-1.5 text-xs text-gray-400">
                {userPage + 1} / {Math.ceil(filteredJourneys.length / USERS_PER_PAGE)}
              </span>
              <button
                onClick={() => setUserPage(p => Math.min(Math.ceil(filteredJourneys.length / USERS_PER_PAGE) - 1, p + 1))}
                disabled={(userPage + 1) * USERS_PER_PAGE >= filteredJourneys.length}
                className="px-3 py-1.5 text-xs rounded-lg bg-gray-800 disabled:opacity-40 hover:bg-gray-700"
              >
                Próximo →
              </button>
            </div>
          )}
        </div>

        <footer className="text-center text-xs text-gray-500 py-4">Atualização automática a cada 30s</footer>
      </div>

      {/* Modal: detalhe do usuário */}
      {selectedUser && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-0 sm:p-4 z-50"
          onClick={() => setSelectedUser(null)}
        >
          <div
            className="bg-gray-900 sm:rounded-2xl max-w-2xl w-full h-full sm:h-auto sm:max-h-[85vh] overflow-hidden border-0 sm:border border-gray-700 flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-gray-700">
              <div>
                <h3 className="text-lg font-semibold">{selectedUser.name || selectedUser.email || "Usuário"}</h3>
                <p className="text-xs text-gray-400">{selectedUser.email || selectedUser.key}</p>
              </div>
              <div className="flex items-center gap-2">
                {selectedUser.email && (
                  <button
                    onClick={() => handleDeleteUser(selectedUser.key, selectedUser.email)}
                    disabled={deletingUser}
                    className="px-3 py-1.5 text-xs rounded-lg bg-red-900/40 text-red-400 hover:bg-red-900/60 border border-red-800/50 disabled:opacity-50"
                  >
                    {deletingUser ? "Deletando..." : "🗑️ Deletar"}
                  </button>
                )}
                <button onClick={() => setSelectedUser(null)} className="text-gray-400 hover:text-white text-xl">✕</button>
              </div>
            </div>
            <div className="p-4 overflow-y-auto flex-1 space-y-4">
              {/* Metadata */}
              <div className="grid grid-cols-3 gap-2 text-xs">
                <Meta label="Profissão" value={PROFESSION_LABELS[selectedUser.profession] || selectedUser.profession || "—"} />
                <Meta label="Plataforma" value={selectedUser.platform || "—"} />
                <Meta label="Cadastro" value={selectedUser.signupMethod === "google" ? "Google" : selectedUser.signupMethod ? "Email/Senha" : "—"} />
              </div>

              {/* Progresso no funil */}
              <div className="bg-gray-800/30 rounded-xl p-3">
                <p className="text-xs text-gray-500 mb-2">Progresso no funil</p>
                <div className="flex gap-2">
                  {FUNNEL_STEPS.map(s => (
                    <div key={s.key} className="flex-1 text-center">
                      <div
                        className="rounded-lg py-2 px-1 text-xs font-medium"
                        style={{
                          backgroundColor: selectedUser.stepsCompleted.has(s.key) ? s.color + "33" : "#1f2937",
                          color: selectedUser.stepsCompleted.has(s.key) ? s.color : "#6b7280",
                          borderWidth: 1,
                          borderColor: selectedUser.stepsCompleted.has(s.key) ? s.color + "66" : "#374151",
                        }}
                      >
                        <div>{s.icon}</div>
                        <div className="mt-0.5">{s.label}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Eventos */}
              <div className="space-y-2">
                <p className="text-xs text-gray-500">Histórico de eventos ({selectedUser.allEvents.length})</p>
                {selectedUser.allEvents.map(ev => (
                  <div key={ev.id} className="bg-gray-800/30 rounded-lg p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span>{FUNNEL_STEPS.find(s => s.key === ev.event)?.icon || "•"}</span>
                        <span className="text-sm font-medium">
                          {FUNNEL_STEPS.find(s => s.key === ev.event)?.label || ev.event}
                        </span>
                      </div>
                      <span className="text-xs text-gray-500">{formatDate(ev.created_at)}</span>
                    </div>
                  </div>
                ))}
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

      {/* Modal: usuários em uma etapa do funil */}
      {selectedStep && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-0 sm:p-4 z-50"
          onClick={() => setSelectedStep(null)}
        >
          <div
            className="bg-gray-900 sm:rounded-2xl max-w-3xl w-full h-full sm:h-auto sm:max-h-[80vh] overflow-hidden border-0 sm:border border-gray-700 flex flex-col"
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
            <div className="p-3 sm:p-4 overflow-y-auto flex-1 space-y-2">
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
                    <div className="flex items-center gap-2 text-xs text-gray-500">
                      {j.platform && <span>{j.platform === "mobile" ? "📱" : "🖥️"}</span>}
                      {j.profession && <span>{PROFESSION_LABELS[j.profession] || j.profession}</span>}
                    </div>
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

function SegRow({
  label,
  signups,
  downloads,
  totalSignups,
  color,
}: {
  label: string;
  signups: number;
  downloads: number;
  totalSignups: number;
  color: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs gap-2">
        <span className="text-gray-300">{label}</span>
        <div className="flex items-center gap-3 tabular-nums">
          <span className="text-gray-400">{signups} cadastros</span>
          <span className="text-emerald-400">{pct(downloads, signups)} download</span>
        </div>
      </div>
      <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full"
          style={{
            width: `${totalSignups > 0 ? (signups / totalSignups) * 100 : 0}%`,
            backgroundColor: color,
          }}
        />
      </div>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-800/30 rounded-lg p-2.5">
      <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className="text-sm text-gray-200 mt-1">{value}</div>
    </div>
  );
}
