"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { supabase } from "@/lib/supabase";
import AutomationPanel, { UserActionsList } from "@/components/AutomationPanel";

const CADASTRO_STEPS = [
  { key: "onboarding_step_account_creation", label: "Cadastro", icon: "📋" },
  { key: "signup_completed", label: "Conta criada", icon: "🔑" },
] as const;

const MOBILE_ONLY_STEPS = [
  { key: "onboarding_step_welcome", label: "Boas-vindas", icon: "👋" },
  { key: "onboarding_step_intent", label: "Jornada", icon: "🎯" },
  { key: "onboarding_step_experience", label: "Experiência", icon: "✨" },
  { key: "onboarding_method_selected", label: "Ir para computador", icon: "💻" },
  { key: "onboarding_completed", label: "Completo", icon: "✅" },
] as const;

const POST_STEPS = [
  { key: "installer_login", label: "Login Instalador", icon: "🔐" },
  { key: "plugin_installed", label: "Plugin Instalado", icon: "🔌" },
  { key: "first_download", label: "1º Download", icon: "📥" },
] as const;

const ALL_STEPS = [...CADASTRO_STEPS, ...MOBILE_ONLY_STEPS, ...POST_STEPS] as const;

const STEP_COLORS = ["#6366f1", "#7c3aed", "#8b5cf6", "#a78bfa", "#10b981", "#06b6d4", "#f59e0b", "#ef4444"];
const PIE_COLORS = ["#3B82F6", "#8B5CF6", "#EC4899", "#F59E0B", "#10B981", "#06B6D4"];

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
  intent: string;
  method: string;
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
          name: "", email: "", phone: "", profession: "", intent: "", method: "", platform: "", signupMethod: "",
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
      if (m.phone && !j.phone) j.phone = m.phone;
      if (m.profession && !j.profession) j.profession = m.profession;
      if (m.intent && !j.intent) j.intent = m.intent;
      if (m.method && !j.method && ev.event === "onboarding_method_selected") j.method = m.method;
      if (m.method && !j.signupMethod && ev.event === "signup_completed") j.signupMethod = m.method;
      if (m.platform && !j.platform) j.platform = m.platform;
      if (ALL_STEPS.some(s => s.key === ev.event)) j.stepsCompleted.add(ev.event);
      if (ev.created_at > j.lastSeen) j.lastSeen = ev.created_at;
      if (ev.created_at < j.firstSeen) j.firstSeen = ev.created_at;
    }

    for (const j of map.values()) {
      for (let i = ALL_STEPS.length - 1; i >= 0; i--) {
        if (j.stepsCompleted.has(ALL_STEPS[i].key)) {
          j.lastStep = ALL_STEPS[i].key;
          j.lastStepLabel = ALL_STEPS[i].label;
          break;
        }
      }
    }

    return Array.from(map.values()).sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime());
  }, [events]);

  const stepCounts = useMemo(() => {
    return ALL_STEPS.map(s => ({ ...s, count: journeys.filter(j => j.stepsCompleted.has(s.key)).length }));
  }, [journeys]);

  const splitCounts = useMemo(() => {
    const mobileUsers = journeys.filter(j => j.platform === "mobile");
    const desktopUsers = journeys.filter(j => j.platform === "desktop");
    return { platforms: { mobile: mobileUsers.length, desktop: desktopUsers.length } };
  }, [journeys]);

  const maxCount = Math.max(1, ...stepCounts.map(s => s.count));

  const analytics = useMemo(() => {
    const profs = new Map<string, number>();
    const intents = new Map<string, number>();
    const methods = new Map<string, number>();
    const platforms = new Map<string, number>();
    const signupMethods = new Map<string, number>();

    for (const j of journeys) {
      if (j.profession) profs.set(PROFESSION_LABELS[j.profession] || j.profession, (profs.get(PROFESSION_LABELS[j.profession] || j.profession) || 0) + 1);
      if (j.intent) intents.set(INTENT_LABELS[j.intent] || j.intent, (intents.get(INTENT_LABELS[j.intent] || j.intent) || 0) + 1);
      if (j.method) methods.set(j.method === "plugin" ? "Plugin SketchUp" : j.method === "web" ? "Biblioteca Web" : j.method, (methods.get(j.method === "plugin" ? "Plugin SketchUp" : j.method === "web" ? "Biblioteca Web" : j.method) || 0) + 1);
      if (j.platform) platforms.set(j.platform === "mobile" ? "📱 Mobile" : "🖥️ Desktop", (platforms.get(j.platform === "mobile" ? "📱 Mobile" : "🖥️ Desktop") || 0) + 1);
      if (j.signupMethod) signupMethods.set(j.signupMethod === "google" ? "Google" : "Email/Senha", (signupMethods.get(j.signupMethod === "google" ? "Google" : "Email/Senha") || 0) + 1);
    }

    return {
      professions: Array.from(profs.entries()).sort((a, b) => b[1] - a[1]),
      intents: Array.from(intents.entries()).sort((a, b) => b[1] - a[1]),
      methods: Array.from(methods.entries()).sort((a, b) => b[1] - a[1]),
      platforms: Array.from(platforms.entries()).sort((a, b) => b[1] - a[1]),
      signupMethods: Array.from(signupMethods.entries()).sort((a, b) => b[1] - a[1]),
    };
  }, [journeys]);

  const usersAtStep = useMemo(() => selectedStep ? journeys.filter(j => j.stepsCompleted.has(selectedStep)) : [], [journeys, selectedStep]);

  const filteredJourneys = useMemo(() => {
    if (!searchTerm) return journeys;
    const q = searchTerm.toLowerCase();
    return journeys.filter(j => j.name?.toLowerCase().includes(q) || j.email?.toLowerCase().includes(q) || j.profession?.toLowerCase().includes(q));
  }, [journeys, searchTerm]);

  const pagedJourneys = filteredJourneys.slice(userPage * USERS_PER_PAGE, (userPage + 1) * USERS_PER_PAGE);

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-7xl mx-auto px-3 sm:px-4 py-4 sm:py-8 space-y-4 sm:space-y-6">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight bg-gradient-to-r from-white to-gray-300 bg-clip-text text-transparent">🎯 Onboarding Dashboard</h1>
            <p className="text-gray-400 mt-1 text-xs sm:text-base">Collection — cadastro simplificado em tempo real</p>
          </div>
          <div className="flex items-center gap-2 text-sm text-gray-400">
            {loading && <span className="inline-block w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />}
            <span>{lastRefresh.toLocaleTimeString("pt-BR")} · 30s</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {(["today", "7d", "30d", "90d", "custom"] as DatePreset[]).map(p => (
            <button key={p} onClick={() => { setPreset(p); setUserPage(0); }} className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${preset === p ? "bg-gradient-to-r from-indigo-600 to-purple-600 text-white shadow-lg" : "bg-gray-800/50 text-gray-300 hover:bg-gray-700/60 border border-gray-700/50"}`}>
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

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-4">
          <Card label="Iniciaram cadastro" value={stepCounts.find(s => s.key === "onboarding_step_account_creation")?.count.toString() || "0"} sub="Tela de cadastro" />
          <Card label="Cadastraram" value={stepCounts.find(s => s.key === "signup_completed")?.count.toString() || "0"} sub="Criaram conta" />
          <Card label="Mobile" value={splitCounts.platforms.mobile.toString()} sub="Continuam na experiência" />
          <Card label="Desktop" value={splitCounts.platforms.desktop.toString()} sub="Entram direto no app" />
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-4">
          <PieCard title="Profissão" data={analytics.professions.slice(0, 5)} />
          <PieCard title="Jornada" data={analytics.intents.slice(0, 5)} />
          <PieCard title="Método" data={analytics.methods.slice(0, 5)} />
          <PieCard title="Plataforma" data={analytics.platforms.slice(0, 5)} />
          <PieCard title="Cadastro" data={analytics.signupMethods.slice(0, 5)} />
        </div>

        <div className="bg-gray-900/50 backdrop-blur-sm rounded-2xl p-4 sm:p-6 space-y-4 border border-gray-800/50">
          <div className="flex items-center justify-between">
            <h2 className="text-base sm:text-lg font-semibold">Funil atual do cadastro</h2>
            <span className="text-xs text-gray-500">{journeys.length} usuários</span>
          </div>
          <div className="space-y-2">
            {stepCounts.filter(s => CADASTRO_STEPS.some(cs => cs.key === s.key)).map((step, i, arr) => {
              const widthPct = (step.count / maxCount) * 100;
              const prevCount = i > 0 ? arr[i - 1].count : step.count;
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
                    </div>
                  </div>
                  <div className="h-8 sm:h-9 bg-gray-800/50 rounded-lg overflow-hidden cursor-pointer hover:bg-gray-800/70 transition-all" onClick={() => setSelectedStep(step.key)}>
                    <div className="h-full rounded-lg transition-all duration-700 ease-out" style={{ width: `${Math.max(widthPct, 2)}%`, backgroundColor: STEP_COLORS[i] }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {journeys.filter(j => j.platform === "mobile").length > 0 && (
          <div className="bg-gray-900/50 backdrop-blur-sm rounded-2xl p-4 sm:p-6 border border-gray-800/50">
            <h2 className="text-base sm:text-lg font-semibold mb-4">Fluxo mobile</h2>
            <div className="space-y-2">
              {stepCounts.filter(s => MOBILE_ONLY_STEPS.some(ms => ms.key === s.key)).map((step, i) => {
                const widthPct = (step.count / Math.max(1, journeys.filter(j => j.platform === "mobile").length)) * 100;
                return (
                  <div key={step.key} className="group">
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <span className="text-base">{step.icon}</span>
                        <span className="text-xs sm:text-sm font-medium text-gray-300">{step.label}</span>
                        <span className="text-sm sm:text-lg font-bold tabular-nums">{step.count}</span>
                      </div>
                    </div>
                    <div className="h-8 sm:h-9 bg-gray-800/50 rounded-lg overflow-hidden cursor-pointer hover:bg-gray-800/70 transition-all" onClick={() => setSelectedStep(step.key)}>
                      <div className="h-full rounded-lg transition-all duration-700 ease-out" style={{ width: `${Math.max(widthPct, 2)}%`, backgroundColor: STEP_COLORS[i + 3] || STEP_COLORS[STEP_COLORS.length - 1] }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="bg-gray-900/50 backdrop-blur-sm rounded-2xl p-4 sm:p-6 border border-gray-800/50">
          <h2 className="text-base sm:text-lg font-semibold mb-4">Saída por plataforma</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="bg-blue-500/5 border border-blue-500/20 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2"><span className="text-lg">🖥️</span><span className="font-medium text-sm text-blue-300">Desktop</span></div>
                <span className="text-lg font-bold text-blue-300">{splitCounts.platforms.desktop}</span>
              </div>
              <p className="text-xs text-gray-400">Cadastro → entra direto na plataforma logado.</p>
            </div>
            <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2"><span className="text-lg">📱</span><span className="font-medium text-sm text-emerald-300">Mobile</span></div>
                <span className="text-lg font-bold text-emerald-300">{splitCounts.platforms.mobile}</span>
              </div>
              <p className="text-xs text-gray-400">Cadastro → experiência → ir para computador.</p>
            </div>
          </div>
        </div>

        <div className="bg-gray-900/50 rounded-2xl p-3 sm:p-6 border border-gray-800">
          <AutomationPanel />
        </div>

        <div className="bg-gray-900/50 backdrop-blur-sm rounded-2xl p-3 sm:p-6 border border-gray-800/50">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-3">
            <h2 className="text-base sm:text-lg font-semibold">Usuários ({filteredJourneys.length})</h2>
            <input type="text" placeholder="Buscar por nome ou email..." value={searchTerm} onChange={e => { setSearchTerm(e.target.value); setUserPage(0); }} className="bg-gray-800/50 border border-gray-700/50 rounded-lg px-3 py-2 text-sm w-full sm:w-72 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>
          <div className="space-y-2">
            {pagedJourneys.map(j => (
              <div key={j.key} className="bg-gray-800/30 rounded-lg p-3 hover:bg-gray-800/50 cursor-pointer transition-all" onClick={() => setSelectedUser(j)}>
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm truncate">{j.name || j.email || j.key.slice(0, 8) + "…"}</span>
                      {j.profession && <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300">{PROFESSION_LABELS[j.profession] || j.profession}</span>}
                      {j.platform && <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-500/20 text-slate-300">{j.platform === "mobile" ? "Mobile" : "Desktop"}</span>}
                    </div>
                    <p className="text-xs text-gray-400 truncate mt-1">{j.email || "Sem email"}</p>
                  </div>
                  <div className="text-xs text-gray-500">{j.lastStepLabel || "—"}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <footer className="text-center text-xs text-gray-500 py-4">Atualização automática a cada 30s</footer>
      </div>

      {selectedUser && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-0 sm:p-4 z-50" onClick={() => setSelectedUser(null)}>
          <div className="bg-gray-900 sm:rounded-2xl max-w-2xl w-full h-full sm:h-auto sm:max-h-[85vh] overflow-hidden border-0 sm:border border-gray-700" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-gray-700">
              <div>
                <h3 className="text-lg font-semibold">{selectedUser.name || selectedUser.email || "Usuário"}</h3>
                <p className="text-xs text-gray-400">{selectedUser.email || selectedUser.key}</p>
              </div>
              <button onClick={() => setSelectedUser(null)} className="text-gray-400 hover:text-white text-xl">✕</button>
            </div>
            <div className="p-4 overflow-y-auto h-[calc(100vh-60px)] sm:h-auto sm:max-h-[calc(85vh-60px)] space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                <Meta label="Profissão" value={PROFESSION_LABELS[selectedUser.profession] || selectedUser.profession || "—"} />
                <Meta label="Jornada" value={INTENT_LABELS[selectedUser.intent] || selectedUser.intent || "—"} />
                <Meta label="Plataforma" value={selectedUser.platform || "—"} />
                <Meta label="Cadastro" value={selectedUser.signupMethod || "—"} />
              </div>
              <div className="space-y-2">
                {selectedUser.allEvents.map(ev => (
                  <div key={ev.id} className="bg-gray-800/30 rounded-lg p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span>{ALL_STEPS.find(s => s.key === ev.event)?.icon || "•"}</span>
                        <span className="text-sm font-medium">{ALL_STEPS.find(s => s.key === ev.event)?.label || ev.event}</span>
                      </div>
                      <span className="text-xs text-gray-500">{formatDate(ev.created_at)}</span>
                    </div>
                  </div>
                ))}
              </div>
              {selectedUser.email && <div className="border-t border-gray-800 pt-3"><UserActionsList email={selectedUser.email} /></div>}
            </div>
          </div>
        </div>
      )}

      {selectedStep && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-0 sm:p-4 z-50" onClick={() => setSelectedStep(null)}>
          <div className="bg-gray-900 sm:rounded-2xl max-w-3xl w-full h-full sm:h-auto sm:max-h-[80vh] overflow-hidden border-0 sm:border border-gray-700" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-gray-700">
              <div className="flex items-center gap-2">
                <span className="text-xl">{ALL_STEPS.find(s => s.key === selectedStep)?.icon}</span>
                <h3 className="text-lg font-semibold">{ALL_STEPS.find(s => s.key === selectedStep)?.label}</h3>
                <span className="text-sm text-gray-400">({usersAtStep.length} usuários)</span>
              </div>
              <button onClick={() => setSelectedStep(null)} className="text-gray-400 hover:text-white text-xl">✕</button>
            </div>
            <div className="p-3 sm:p-4 overflow-y-auto h-[calc(100vh-60px)] sm:h-auto sm:max-h-[calc(80vh-60px)] space-y-2">
              {usersAtStep.map(j => (
                <div key={j.key} className="bg-gray-800/30 rounded-lg p-3 hover:bg-gray-800/50 cursor-pointer transition-all" onClick={() => { setSelectedStep(null); setSelectedUser(j); }}>
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

function Card({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="bg-gray-900/50 backdrop-blur-sm rounded-2xl p-4 border border-gray-800/50">
      <div className="text-2xl sm:text-3xl font-bold tabular-nums">{value}</div>
      <div className="text-sm font-medium text-gray-200 mt-1">{label}</div>
      <div className="text-xs text-gray-500 mt-1">{sub}</div>
    </div>
  );
}

function PieCard({ title, data }: { title: string; data: [string, number][] }) {
  const total = data.reduce((acc, [, v]) => acc + v, 0);
  return (
    <div className="bg-gray-900/50 backdrop-blur-sm rounded-2xl p-4 border border-gray-800/50">
      <h3 className="text-sm font-semibold mb-3">{title}</h3>
      <div className="space-y-2">
        {data.length === 0 ? <p className="text-xs text-gray-500">Sem dados</p> : data.map(([label, value], i) => (
          <div key={label} className="space-y-1">
            <div className="flex items-center justify-between text-xs gap-2">
              <div className="flex items-center gap-2 min-w-0"><span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }} /><span className="truncate">{label}</span></div>
              <span className="text-gray-400">{value}</span>
            </div>
            <div className="h-2 bg-gray-800 rounded-full overflow-hidden"><div className="h-full rounded-full" style={{ width: `${total > 0 ? (value / total) * 100 : 0}%`, backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }} /></div>
          </div>
        ))}
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
