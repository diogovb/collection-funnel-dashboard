"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { supabase } from "@/lib/supabase";
import AutomationPanel, { UserActionsList } from "@/components/AutomationPanel";

// ─── DDD → State mapping ────────────────────────────────────────────────────
const DDD_TO_STATE: Record<string, string> = {
  "11": "SP", "12": "SP", "13": "SP", "14": "SP", "15": "SP",
  "16": "SP", "17": "SP", "18": "SP", "19": "SP",
  "21": "RJ", "22": "RJ", "24": "RJ",
  "27": "ES", "28": "ES",
  "31": "MG", "32": "MG", "33": "MG", "34": "MG", "35": "MG",
  "37": "MG", "38": "MG",
  "41": "PR", "42": "PR", "43": "PR", "44": "PR", "45": "PR", "46": "PR",
  "47": "SC", "48": "SC", "49": "SC",
  "51": "RS", "53": "RS", "54": "RS", "55": "RS",
  "61": "DF",
  "62": "GO", "64": "GO",
  "63": "TO",
  "65": "MT", "66": "MT",
  "67": "MS",
  "68": "AC",
  "69": "RO",
  "71": "BA", "73": "BA", "74": "BA", "75": "BA", "77": "BA",
  "79": "SE",
  "81": "PE", "87": "PE",
  "82": "AL",
  "83": "PB",
  "84": "RN",
  "85": "CE", "88": "CE",
  "86": "PI", "89": "PI",
  "91": "PA", "93": "PA", "94": "PA",
  "92": "AM", "97": "AM",
  "95": "RR",
  "96": "AP",
  "98": "MA", "99": "MA",
};

const STATE_NAMES: Record<string, string> = {
  SP: "São Paulo", RJ: "Rio de Janeiro", MG: "Minas Gerais",
  BA: "Bahia", PR: "Paraná", RS: "Rio Grande do Sul",
  PE: "Pernambuco", CE: "Ceará", PA: "Pará", SC: "Santa Catarina",
  MA: "Maranhão", GO: "Goiás", AM: "Amazonas", ES: "Espírito Santo",
  PB: "Paraíba", RN: "Rio Grande do Norte", MT: "Mato Grosso",
  AL: "Alagoas", PI: "Piauí", DF: "Distrito Federal",
  MS: "Mato Grosso do Sul", SE: "Sergipe", RO: "Rondônia",
  TO: "Tocantins", AC: "Acre", AP: "Amapá", RR: "Roraima",
};

function extractReferrerDomain(referrer: string): string {
  if (!referrer) return "Direto";
  try {
    const url = new URL(referrer);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return referrer.slice(0, 50) || "Direto";
  }
}

function extractDDD(phone: string): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  const local = digits.startsWith("55") && digits.length >= 12 ? digits.slice(2) : digits;
  if (local.length >= 2) return local.slice(0, 2);
  return null;
}

function dddToState(phone: string): string | null {
  const ddd = extractDDD(phone);
  if (!ddd) return null;
  return DDD_TO_STATE[ddd] || null;
}

function waLink(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  const number = digits.startsWith("55") ? digits : `55${digits}`;
  return `https://wa.me/${number}`;
}

function formatNumber(n: number): string {
  return n.toLocaleString("pt-BR");
}

const FUNNEL_STEPS = [
  { key: "signup_completed", label: "Cadastro", icon: "📋", desc: "Criaram conta" },
  { key: "first_download", label: "1º Download", icon: "📥", desc: "Baixaram o primeiro bloco" },
] as const;

const FUNNEL_COLORS = ["#6366f1", "#a855f7"];
const SEG_COLORS = ["#6366f1", "#a855f7", "#ec4899", "#f59e0b", "#10b981", "#06b6d4", "#3b82f6", "#f97316"];

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
  id: string; // id of the signup_completed event (for delete)
  name: string;
  email: string;
  profession: string;
  method: string;
  platform: string;
  phone: string;
  software: string;
  whatBrought: string;
  state: string | null;
  referrerDomain: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  stepsCompleted: Set<string>;
  lastStep: string;
  lastStepLabel: string;
  firstSeen: string;
  lastSeen: string;
  allEvents: FunnelEvent[];
}

type DatePreset = "today" | "7d" | "30d" | "90d" | "custom";

type DrillType = "profession" | "platform" | "method" | "software" | "whatBrought" | "state" | "step" | "referrer" | "campaign" | "domain" | "hour" | "day";
type DrillFilter = { type: DrillType; value: string; label: string } | null;

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

function todayStart(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
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
  const [profFilter, setProfFilter] = useState("");
  const [userPage, setUserPage] = useState(0);
  const [selectedUser, setSelectedUser] = useState<UserJourney | null>(null);
  const [drillFilter, setDrillFilter] = useState<DrillFilter>(null);
  const [view, setView] = useState<"dashboard" | "drillList" | "userDetail">("dashboard");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const USERS_PER_PAGE = 25;

  const dateFrom = useMemo(() => {
    if (preset === "today") return todayStart();
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

  const handleDeleteUser = useCallback(async () => {
    if (!selectedUser) return;
    setDeleting(true);
    try {
      const res = await fetch("/api/delete-lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: selectedUser.id }),
      });
      if (!res.ok) throw new Error("Falha ao deletar");
      setEvents(prev => prev.filter(ev => ev.id !== selectedUser.id));
      setSelectedUser(null);
      setConfirmDelete(false);
      setView(drillFilter ? "drillList" : "dashboard");
    } finally {
      setDeleting(false);
    }
  }, [selectedUser, drillFilter]);

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
          id: "",
          name: "", email: "", profession: "", method: "", platform: "", phone: "",
          software: "", whatBrought: "", state: null,
          referrerDomain: "Direto", utmSource: "", utmMedium: "", utmCampaign: "",
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
      if (ev.event === "signup_completed") {
        if (!j.id) j.id = ev.id;
        if (m.method && !j.method) j.method = m.method;
        if (m.software && !j.software) j.software = m.software;
        if (m.what_brought && !j.whatBrought) j.whatBrought = m.what_brought;
        if (m.referrer && j.referrerDomain === "Direto") j.referrerDomain = extractReferrerDomain(m.referrer);
        if (m.utm_source && !j.utmSource) j.utmSource = m.utm_source;
        if (m.utm_medium && !j.utmMedium) j.utmMedium = m.utm_medium;
        if (m.utm_campaign && !j.utmCampaign) j.utmCampaign = m.utm_campaign;
      }
      if (m.platform && !j.platform) j.platform = m.platform;
      if ((m.phone || m.whatsapp) && !j.phone) j.phone = m.phone || m.whatsapp;
      if (FUNNEL_STEPS.some(s => s.key === ev.event)) j.stepsCompleted.add(ev.event);
      if (ev.created_at > j.lastSeen) j.lastSeen = ev.created_at;
      if (ev.created_at < j.firstSeen) j.firstSeen = ev.created_at;
    }

    for (const j of map.values()) {
      if (j.phone) j.state = dddToState(j.phone);
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
      count: journeys.filter(j =>
        j.stepsCompleted.has(s.key) &&
        (s.key === "signup_completed" || j.stepsCompleted.has("signup_completed"))
      ).length,
    }));
  }, [journeys]);

  const signupJourneys = useMemo(() => journeys.filter(j => j.stepsCompleted.has("signup_completed")), [journeys]);

  // ─── Metric cards ───────────────────────────────────────────────────────────
  const todaySignups = useMemo(() => {
    const start = todayStart();
    return signupJourneys.filter(j => j.firstSeen >= start).length;
  }, [signupJourneys]);

  const mobileCount = useMemo(() => signupJourneys.filter(j => j.platform === "mobile").length, [signupJourneys]);
  const desktopCount = useMemo(() => signupJourneys.filter(j => j.platform !== "mobile" && j.platform).length, [signupJourneys]);

  // ─── Cadastros per day (last 15 days) ────────────────────────────────────────
  const signupsByDay = useMemo(() => {
    const map = new Map<string, number>();
    for (const j of signupJourneys) {
      const day = j.firstSeen.slice(0, 10);
      map.set(day, (map.get(day) || 0) + 1);
    }
    const days: { day: string; count: number }[] = [];
    for (let i = 14; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      days.push({ day: key, count: map.get(key) || 0 });
    }
    return days;
  }, [signupJourneys]);
  const maxDayCount = useMemo(() => Math.max(...signupsByDay.map(d => d.count), 1), [signupsByDay]);

  // ─── Hourly distribution ────────────────────────────────────────────────────
  const hourlyDist = useMemo(() => {
    const counts = Array(24).fill(0) as number[];
    for (const j of signupJourneys) {
      const h = new Date(j.firstSeen).getHours();
      counts[h]++;
    }
    return counts;
  }, [signupJourneys]);
  const maxHour = useMemo(() => Math.max(...hourlyDist, 1), [hourlyDist]);

  // ─── Analytics segmentation ────────────────────────────────────────────────
  const analytics = useMemo(() => {
    const profs = new Map<string, number>();
    const platforms = new Map<string, number>();
    const methods = new Map<string, number>();
    const softwares = new Map<string, number>();
    const whatBroughts = new Map<string, number>();
    const states = new Map<string, number>();

    for (const j of signupJourneys) {
      const profLabel = j.profession ? (PROFESSION_LABELS[j.profession] || j.profession) : "Não informado";
      profs.set(profLabel, (profs.get(profLabel) || 0) + 1);

      const platLabel = j.platform ? (j.platform === "mobile" ? "Mobile" : "Desktop") : "Não informado";
      platforms.set(platLabel, (platforms.get(platLabel) || 0) + 1);

      const methLabel = j.method ? (j.method === "google" ? "Google" : "Email/Senha") : "Não informado";
      methods.set(methLabel, (methods.get(methLabel) || 0) + 1);

      const swLabel = j.software || "Não informado";
      softwares.set(swLabel, (softwares.get(swLabel) || 0) + 1);

      const wbLabel = j.whatBrought || "Não informado";
      whatBroughts.set(wbLabel, (whatBroughts.get(wbLabel) || 0) + 1);

      if (j.state) {
        const stateLabel = `${j.state} — ${STATE_NAMES[j.state] || j.state}`;
        states.set(stateLabel, (states.get(stateLabel) || 0) + 1);
      }
    }

    return {
      professions: Array.from(profs.entries()).sort((a, b) => b[1] - a[1]),
      platforms: Array.from(platforms.entries()).sort((a, b) => b[1] - a[1]),
      methods: Array.from(methods.entries()).sort((a, b) => b[1] - a[1]),
      softwares: Array.from(softwares.entries()).sort((a, b) => b[1] - a[1]),
      whatBroughts: Array.from(whatBroughts.entries()).sort((a, b) => b[1] - a[1]),
      states: Array.from(states.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8),
    };
  }, [signupJourneys]);

  // ─── Email domains ──────────────────────────────────────────────────────────
  const emailDomains = useMemo(() => {
    const map = new Map<string, number>();
    for (const j of signupJourneys) {
      if (!j.email) continue;
      const domain = j.email.split("@")[1]?.toLowerCase() || "desconhecido";
      map.set(domain, (map.get(domain) || 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [signupJourneys]);

  // ─── Referrer & campaigns ───────────────────────────────────────────────────
  const referrerSeg = useMemo(() => {
    const map = new Map<string, number>();
    for (const j of signupJourneys) {
      map.set(j.referrerDomain, (map.get(j.referrerDomain) || 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [signupJourneys]);

  const campaignSeg = useMemo(() => {
    const map = new Map<string, number>();
    for (const j of signupJourneys) {
      if (!j.utmSource) continue;
      const key = j.utmCampaign ? `${j.utmSource} / ${j.utmCampaign}` : j.utmSource;
      map.set(key, (map.get(key) || 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [signupJourneys]);

  const hasCampaigns = campaignSeg.length > 0;

  // ─── Drill journeys ─────────────────────────────────────────────────────────
  const drillJourneys = useMemo(() => {
    if (!drillFilter) return [];
    if (drillFilter.type === "step") {
      return journeys.filter(j =>
        j.stepsCompleted.has(drillFilter.value) &&
        (drillFilter.value === "signup_completed" || j.stepsCompleted.has("signup_completed"))
      );
    }
    return signupJourneys.filter(j => {
      switch (drillFilter.type) {
        case "profession":
          return (PROFESSION_LABELS[j.profession] || j.profession || "Não informado") === drillFilter.value;
        case "platform":
          return (j.platform === "mobile" ? "Mobile" : j.platform ? "Desktop" : "Não informado") === drillFilter.value;
        case "method":
          return (j.method === "google" ? "Google" : j.method ? "Email/Senha" : "Não informado") === drillFilter.value;
        case "software":
          return (j.software || "Não informado") === drillFilter.value;
        case "whatBrought":
          return (j.whatBrought || "Não informado") === drillFilter.value;
        case "state":
          return (j.state ?? null) === drillFilter.value;
        case "referrer":
          return j.referrerDomain === drillFilter.value;
        case "campaign": {
          const key = j.utmCampaign ? `${j.utmSource} / ${j.utmCampaign}` : j.utmSource;
          return key === drillFilter.value;
        }
        case "domain":
          return j.email.split("@")[1]?.toLowerCase() === drillFilter.value;
        case "hour":
          return new Date(j.firstSeen).getHours() === parseInt(drillFilter.value);
        case "day":
          return j.firstSeen.slice(0, 10) === drillFilter.value;
        default:
          return false;
      }
    });
  }, [journeys, signupJourneys, drillFilter]);

  const allProfessions = useMemo(() => {
    const set = new Set<string>();
    for (const j of journeys) if (j.profession) set.add(j.profession);
    return Array.from(set).sort((a, b) => (PROFESSION_LABELS[a] || a).localeCompare(PROFESSION_LABELS[b] || b, "pt-BR"));
  }, [journeys]);

  const filteredJourneys = useMemo(() => {
    let list = signupJourneys;
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      list = list.filter(j => j.name?.toLowerCase().includes(q) || j.email?.toLowerCase().includes(q) || j.phone?.includes(q));
    }
    if (profFilter) list = list.filter(j => j.profession === profFilter);
    return list;
  }, [signupJourneys, searchTerm, profFilter]);

  const pagedJourneys = filteredJourneys.slice(userPage * USERS_PER_PAGE, (userPage + 1) * USERS_PER_PAGE);
  const totalPages = Math.ceil(filteredJourneys.length / USERS_PER_PAGE);
  const topCount = funnelCounts[0]?.count || 1;

  function openDrill(type: DrillType, value: string, label: string) {
    setDrillFilter({ type, value, label });
    setView("drillList");
  }

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

        {/* Metric cards */}
        <div className="grid grid-cols-3 gap-2 sm:gap-4">
          <MetricCard label="Total de cadastros" value={formatNumber(signupJourneys.length)} sub="no período selecionado" color="#6366f1" />
          <MetricCard
            label="Mobile"
            value={formatNumber(mobileCount)}
            sub={signupJourneys.length > 0 ? `${((mobileCount / signupJourneys.length) * 100).toFixed(0)}% do total` : "—"}
            color="#ec4899"
          />
          <MetricCard
            label="Desktop"
            value={formatNumber(desktopCount)}
            sub={signupJourneys.length > 0 ? `${((desktopCount / signupJourneys.length) * 100).toFixed(0)}% do total` : "—"}
            color="#f59e0b"
          />
        </div>

        {/* Cadastros per day chart */}
        <div className="bg-gray-900/50 backdrop-blur-sm rounded-2xl p-4 sm:p-6 border border-gray-800/50">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-5">Cadastros por dia (últimos 15 dias)</h2>
          <div className="flex items-end gap-0.5 h-28 overflow-x-auto pb-5">
            {signupsByDay.map(({ day, count }) => {
              const heightPct = maxDayCount > 0 ? (count / maxDayCount) * 100 : 0;
              const label = new Date(day + "T12:00:00").toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
              return (
                <div
                  key={day}
                  className={`flex-1 min-w-[18px] flex flex-col items-center gap-1 group relative ${count > 0 ? "cursor-pointer" : ""}`}
                  onClick={() => { if (count > 0) { openDrill("day", day, label); } }}
                >
                  {count > 0 && (
                    <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-gray-800 text-xs text-white px-1.5 py-0.5 rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">
                      {label}: {count}
                    </div>
                  )}
                  <div className="w-full flex items-end h-20">
                    <div
                      className="w-full rounded-t transition-all duration-500 group-hover:brightness-125"
                      style={{
                        height: `${Math.max(heightPct, count > 0 ? 4 : 0)}%`,
                        minHeight: count > 0 ? "3px" : "0",
                        background: "linear-gradient(180deg, #6366f1, #a855f7)",
                        opacity: count > 0 ? 1 : 0.1,
                      }}
                    />
                  </div>
                  <span className="text-[9px] text-gray-600 rotate-45 origin-left whitespace-nowrap translate-x-1">{label}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Segmentation row 1 */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <SegCard title="Plataforma" data={analytics.platforms} onItemClick={(label) => openDrill("platform", label, label)} />
          <SegCard title="Método de cadastro" data={analytics.methods} onItemClick={(label) => openDrill("method", label, label)} />
          <SegCard title="Profissão" data={analytics.professions.slice(0, 6)} onItemClick={(label) => openDrill("profession", label, label)} />
        </div>

        {/* Segmentation row 2 */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <SegCard title="Software" data={analytics.softwares.slice(0, 6)} onItemClick={(label) => openDrill("software", label, label)} />
          <SegCard title="Interesse" data={analytics.whatBroughts.slice(0, 6)} onItemClick={(label) => openDrill("whatBrought", label, label)} />
          <SegCard
            title="Estado (DDD)"
            data={analytics.states.slice(0, 6)}
            onItemClick={(label) => {
              const code = label.split(" — ")[0];
              openDrill("state", code, label);
            }}
          />
        </div>

        {/* Origin & Campaigns */}
        <div className={`grid grid-cols-1 ${hasCampaigns ? "sm:grid-cols-2" : ""} gap-4`}>
          <SegCard title="Origem" data={referrerSeg} onItemClick={(label) => openDrill("referrer", label, label)} />
          {hasCampaigns && (
            <SegCard title="Campanhas (UTM)" data={campaignSeg} onItemClick={(label) => openDrill("campaign", label, label)} />
          )}
        </div>

        {/* Hourly distribution */}
        <div className="bg-gray-900/50 backdrop-blur-sm rounded-2xl p-5 sm:p-6 border border-gray-800/50">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">Distribuição por hora do dia</h2>
          {signupJourneys.length === 0 && !loading ? (
            <p className="text-xs text-gray-500">Sem dados</p>
          ) : (
            <div className="flex items-end gap-1 h-24">
              {hourlyDist.map((count, h) => {
                const heightPct = maxHour > 0 ? (count / maxHour) * 100 : 0;
                return (
                  <div
                    key={h}
                    className={`flex-1 flex flex-col items-center gap-0.5 group relative ${count > 0 ? "cursor-pointer" : ""}`}
                    onClick={() => { if (count > 0) { openDrill("hour", String(h), `${h}h`); } }}
                  >
                    <div
                      className="w-full rounded-t transition-all duration-500 group-hover:brightness-125"
                      style={{
                        height: `${Math.max(heightPct, count > 0 ? 4 : 0)}%`,
                        minHeight: count > 0 ? "3px" : undefined,
                        background: "linear-gradient(180deg, #6366f1, #a855f7)",
                        opacity: count > 0 ? 1 : 0.15,
                      }}
                    />
                    {count > 0 && (
                      <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-gray-800 text-xs text-white px-1.5 py-0.5 rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">
                        {h}h: {count}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <div className="flex justify-between text-[10px] text-gray-600 mt-1">
            <span>0h</span><span>6h</span><span>12h</span><span>18h</span><span>23h</span>
          </div>
        </div>

        {/* Email domains */}
        <div className="bg-gray-900/50 backdrop-blur-sm rounded-2xl p-5 sm:p-6 border border-gray-800/50">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">Domínios de email</h2>
          {emailDomains.length === 0 ? (
            <p className="text-xs text-gray-500">Sem dados</p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {emailDomains.map(([domain, count], i) => {
                const pct = signupJourneys.length > 0 ? ((count / signupJourneys.length) * 100).toFixed(1) : "0";
                return (
                  <div
                    key={domain}
                    className="bg-gray-800/40 rounded-xl p-3 hover:bg-gray-800/60 transition-colors cursor-pointer"
                    onClick={() => openDrill("domain", domain, domain)}
                  >
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: SEG_COLORS[i % SEG_COLORS.length] }} />
                      <span className="text-xs text-gray-300 truncate font-medium">{domain}</span>
                    </div>
                    <div className="text-xl font-bold tabular-nums">{formatNumber(count)}</div>
                    <div className="text-xs text-gray-500">{pct}%</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Automations */}
        <div className="bg-gray-900/50 rounded-2xl p-3 sm:p-6 border border-gray-800">
          <AutomationPanel />
        </div>

        {/* Cadastros table */}
        <div className="bg-gray-900/50 backdrop-blur-sm rounded-2xl p-3 sm:p-6 border border-gray-800/50">
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 mb-3">
            <h2 className="text-base sm:text-lg font-semibold shrink-0">Cadastros ({formatNumber(filteredJourneys.length)})</h2>
            <div className="flex flex-1 flex-col sm:flex-row gap-2 w-full">
              <input
                type="text"
                placeholder="Buscar por nome, email ou telefone..."
                value={searchTerm}
                onChange={e => { setSearchTerm(e.target.value); setUserPage(0); }}
                className="flex-1 bg-gray-800/50 border border-gray-700/50 rounded-lg px-3 py-2 text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <select
                value={profFilter}
                onChange={e => { setProfFilter(e.target.value); setUserPage(0); }}
                className="bg-gray-800/50 border border-gray-700/50 rounded-lg px-3 py-2 text-sm text-gray-300 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="">Todas as profissões</option>
                {allProfessions.map(p => (
                  <option key={p} value={p}>{PROFESSION_LABELS[p] || p}</option>
                ))}
              </select>
            </div>
          </div>

          {loading && signupJourneys.length === 0 ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-14 bg-gray-800/30 rounded-lg animate-pulse" />
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              {pagedJourneys.length === 0 ? (
                <p className="text-sm text-gray-500 py-4 text-center">Nenhum cadastro encontrado</p>
              ) : (
                pagedJourneys.map(j => (
                  <div
                    key={j.key}
                    className="bg-gray-800/30 rounded-lg p-3 hover:bg-gray-800/50 cursor-pointer transition-all group"
                    onClick={() => { setSelectedUser(j); setView("userDetail"); }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-sm truncate group-hover:text-indigo-300 transition-colors">
                            {j.name || j.email || "Sem nome"}
                          </span>
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
                          {j.state && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300">{j.state}</span>
                          )}
                          {j.software && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300">{j.software}</span>
                          )}
                          {j.whatBrought && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">{j.whatBrought}</span>
                          )}
                        </div>
                        <p className="text-xs text-gray-400 truncate mt-0.5">{j.email || "Sem email"}</p>
                      </div>
                      <div className="text-xs text-gray-500 shrink-0 text-right">
                        <div>{j.lastStepLabel || "—"}</div>
                        <div className="text-gray-600 mt-0.5">{formatDate(j.firstSeen)}</div>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

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
      {view === "userDetail" && selectedUser && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-0 sm:p-4 z-50"
          onClick={() => { setSelectedUser(null); setConfirmDelete(false); setView(drillFilter ? "drillList" : "dashboard"); }}
        >
          <div
            className="bg-gray-900 sm:rounded-2xl max-w-2xl w-full h-full sm:h-auto sm:max-h-[85vh] overflow-hidden border-0 sm:border border-gray-700"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-gray-700">
              <div className="flex items-center gap-3 min-w-0">
                {drillFilter && (
                  <button
                    onClick={() => { setSelectedUser(null); setConfirmDelete(false); setView("drillList"); }}
                    className="shrink-0 text-gray-400 hover:text-white text-sm transition-colors flex items-center gap-1"
                  >
                    ← Voltar
                  </button>
                )}
                <div className="min-w-0">
                  <h3 className="text-lg font-semibold truncate">{selectedUser.name || selectedUser.email || "Usuário"}</h3>
                  <p className="text-xs text-gray-400">{selectedUser.email || selectedUser.key}</p>
                </div>
              </div>
              <button
                onClick={() => { setSelectedUser(null); setConfirmDelete(false); setView(drillFilter ? "drillList" : "dashboard"); }}
                className="text-gray-400 hover:text-white text-xl shrink-0"
              >✕</button>
            </div>
            <div className="p-4 overflow-y-auto h-[calc(100vh-60px)] sm:h-auto sm:max-h-[calc(85vh-60px)] space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <Meta label="Profissão" value={PROFESSION_LABELS[selectedUser.profession] || selectedUser.profession || "—"} />
                <Meta label="Plataforma" value={selectedUser.platform || "—"} />
                <Meta label="Método" value={selectedUser.method === "google" ? "Google" : selectedUser.method ? "Email/Senha" : "—"} />
                <Meta label="Estado" value={selectedUser.state ? `${selectedUser.state} — ${STATE_NAMES[selectedUser.state] || ""}` : "—"} />
                <Meta label="Software" value={selectedUser.software || "—"} />
                <Meta label="Interesse" value={selectedUser.whatBrought || "—"} />
                <Meta label="Origem" value={selectedUser.referrerDomain || "—"} />
                <Meta label="Desde" value={selectedUser.firstSeen ? formatDate(selectedUser.firstSeen) : "—"} />
              </div>

              {selectedUser.phone && (
                <div className="bg-gray-800/40 rounded-xl p-3 flex items-center justify-between gap-2">
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-0.5">Telefone / WhatsApp</div>
                    <div className="text-sm text-gray-200 font-medium">{selectedUser.phone}</div>
                  </div>
                  <a
                    href={waLink(selectedUser.phone)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-600/20 text-green-400 hover:bg-green-600/30 border border-green-700/40 text-sm font-medium transition-all"
                    onClick={e => e.stopPropagation()}
                  >
                    <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current" xmlns="http://www.w3.org/2000/svg">
                      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z" />
                    </svg>
                    WhatsApp
                  </a>
                </div>
              )}

              {selectedUser.email && (
                <div className="border-t border-gray-800 pt-3">
                  <UserActionsList email={selectedUser.email} />
                </div>
              )}

              {/* Delete */}
              {selectedUser.id && (
                <div className="pt-2 border-t border-gray-800">
                  {confirmDelete ? (
                    <div className="bg-red-950/40 border border-red-800/50 rounded-xl p-4 space-y-3">
                      <p className="text-sm text-red-300 font-medium">Tem certeza que quer deletar este cadastro?</p>
                      <div className="flex gap-2">
                        <button
                          onClick={handleDeleteUser}
                          disabled={deleting}
                          className="flex-1 px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white text-sm font-medium transition-colors disabled:opacity-50"
                        >
                          {deleting ? "Deletando..." : "Sim, deletar"}
                        </button>
                        <button
                          onClick={() => setConfirmDelete(false)}
                          disabled={deleting}
                          className="flex-1 px-4 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium transition-colors"
                        >
                          Cancelar
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(true)}
                      className="w-full px-4 py-2.5 rounded-xl bg-red-900/20 hover:bg-red-900/40 text-red-400 hover:text-red-300 border border-red-800/40 text-sm font-medium transition-all"
                    >
                      Deletar cadastro
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Drill list modal */}
      {view === "drillList" && drillFilter && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-0 sm:p-4 z-40"
          onClick={() => { setDrillFilter(null); setView("dashboard"); }}
        >
          <div
            className="bg-gray-900 sm:rounded-2xl max-w-lg w-full h-full sm:h-auto sm:max-h-[85vh] flex flex-col overflow-hidden border-0 sm:border border-gray-700"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 p-4 border-b border-gray-700 shrink-0">
              <button
                onClick={() => { setDrillFilter(null); setView("dashboard"); }}
                className="text-gray-400 hover:text-white text-sm transition-colors flex items-center gap-1 shrink-0"
              >
                ← Voltar
              </button>
              <div className="min-w-0">
                <h3 className="text-base font-semibold truncate">Cadastros — {drillFilter.label}</h3>
                <p className="text-xs text-gray-500">{drillJourneys.length} cadastro{drillJourneys.length !== 1 ? "s" : ""}</p>
              </div>
            </div>
            <div className="overflow-y-auto flex-1 p-3 space-y-2">
              {drillJourneys.length === 0 ? (
                <p className="text-sm text-gray-500 py-8 text-center">Nenhum cadastro encontrado</p>
              ) : (
                drillJourneys.map(j => (
                  <div
                    key={j.key}
                    className="bg-gray-800/40 rounded-lg p-3 hover:bg-gray-800/70 cursor-pointer transition-all group"
                    onClick={() => { setSelectedUser(j); setView("userDetail"); }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-sm truncate group-hover:text-indigo-300 transition-colors">
                            {j.name || j.email || j.key.slice(0, 8) + "…"}
                          </span>
                          {j.state && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300">{j.state}</span>
                          )}
                        </div>
                        <p className="text-xs text-gray-400 truncate mt-0.5">{j.email || "Sem email"}</p>
                        {j.phone && (
                          <a
                            href={waLink(j.phone)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-green-500 hover:text-green-400 mt-0.5 inline-block"
                            onClick={e => e.stopPropagation()}
                          >
                            {j.phone}
                          </a>
                        )}
                      </div>
                      <div className="text-xs text-gray-500 shrink-0 text-right">
                        <div>{j.lastStepLabel || "—"}</div>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MetricCard({ label, value, sub, color }: {
  label: string; value: string; sub: string; color: string;
}) {
  return (
    <div className="bg-gray-900/50 backdrop-blur-sm rounded-2xl p-4 border border-gray-800/50 relative overflow-hidden">
      <div className="absolute inset-0 opacity-5 pointer-events-none" style={{ background: `radial-gradient(circle at 80% 20%, ${color}, transparent 60%)` }} />
      <div className="text-2xl sm:text-3xl font-bold tabular-nums">{value}</div>
      <div className="text-sm font-medium text-gray-200 mt-1">{label}</div>
      <div className="text-xs text-gray-500 mt-0.5">{sub}</div>
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

function SegCard({ title, data, onItemClick }: {
  title: string;
  data: [string, number][];
  onItemClick?: (label: string) => void;
}) {
  const total = data.reduce((acc, [, v]) => acc + v, 0);
  return (
    <div className="bg-gray-900/50 backdrop-blur-sm rounded-2xl p-4 border border-gray-800/50">
      <h3 className="text-sm font-semibold text-gray-300 mb-3">{title}</h3>
      <div className="space-y-3">
        {data.length === 0 ? (
          <p className="text-xs text-gray-500">Sem dados</p>
        ) : (
          data.map(([label, value], i) => (
            <div
              key={label}
              className={onItemClick ? "cursor-pointer group/seg" : ""}
              onClick={() => onItemClick?.(label)}
            >
              <div className="flex items-center justify-between text-xs mb-1">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: SEG_COLORS[i % SEG_COLORS.length] }} />
                  <span className="truncate text-gray-300 group-hover/seg:text-white transition-colors">{label}</span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0 ml-2">
                  <span className="font-medium text-gray-200">{formatNumber(value)}</span>
                  <span className="text-gray-600">·</span>
                  <span className="text-gray-500">{total > 0 ? ((value / total) * 100).toFixed(0) : 0}%</span>
                </div>
              </div>
              <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-700 group-hover/seg:brightness-125"
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
