"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { supabase } from "@/lib/supabase";

// ─── DDD → State mapping ───────────────────────────────────────────────────
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
  // strip country code 55
  const local = digits.startsWith("55") && digits.length >= 12 ? digits.slice(2) : digits;
  if (local.length >= 2) return local.slice(0, 2);
  return null;
}

function dddToState(phone: string): string | null {
  const ddd = extractDDD(phone);
  if (!ddd) return null;
  return DDD_TO_STATE[ddd] || null;
}

// ─── Profession labels ────────────────────────────────────────────────────
const PROFESSION_LABELS: Record<string, string> = {
  arquiteto: "Arquiteto(a)",
  designer_interiores: "Designer de Interiores",
  engenheiro: "Engenheiro(a)",
  projetista: "Projetista",
  estudante: "Estudante",
  outro: "Outro",
};

const SEG_COLORS = ["#6366f1", "#a855f7", "#ec4899", "#f59e0b", "#10b981", "#06b6d4", "#3b82f6", "#f97316"];

// ─── Types ────────────────────────────────────────────────────────────────
interface Lead {
  id: string;
  email: string;
  created_at: string;
  metadata: Record<string, unknown> | null;
  // derived
  name: string;
  phone: string;
  profession: string;
  platform: string;
  state: string | null;
  referrerDomain: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
}

type DatePreset = "today" | "7d" | "30d" | "90d" | "custom";

type DrillFilter = {
  type: "profession" | "platform" | "state" | "domain" | "hour" | "day" | "referrer" | "campaign";
  value: string;
  label: string;
} | null;

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

function formatNumber(n: number): string {
  return n.toLocaleString("pt-BR");
}

function waLink(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  const number = digits.startsWith("55") ? digits : `55${digits}`;
  return `https://wa.me/${number}`;
}

// ─── Main component ───────────────────────────────────────────────────────
export default function ExperimentarDashboard() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [preset, setPreset] = useState<DatePreset>("today");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [searchTerm, setSearchTerm] = useState("");
  const [profFilter, setProfFilter] = useState("");
  const [page, setPage] = useState(0);
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [drillFilter, setDrillFilter] = useState<DrillFilter>(null);
  const [view, setView] = useState<"dashboard" | "drillList" | "leadDetail">("dashboard");
  const LEADS_PER_PAGE = 25;

  const dateFrom = useMemo(() => {
    if (preset === "today") return todayStart();
    if (preset === "7d") return daysAgo(7);
    if (preset === "30d") return daysAgo(30);
    if (preset === "custom" && customFrom) return new Date(customFrom).toISOString();
    return daysAgo(90);
  }, [preset, customFrom]);

  const dateTo = useMemo(() => {
    if (preset === "custom" && customTo) return new Date(customTo + "T23:59:59").toISOString();
    return new Date().toISOString();
  }, [preset, customTo]);

  const fetchLeads = useCallback(async () => {
    setLoading(true);
    let allData: Array<{ id: string; email: string; created_at: string; metadata: Record<string, unknown> | null }> = [];
    let pg = 0;
    const PAGE_SIZE = 1000;
    while (true) {
      const { data, error } = await supabase
        .from("funnel_events")
        .select("id, email, created_at, metadata")
        .eq("event", "experimentar_lead")
        .gte("created_at", dateFrom)
        .lte("created_at", dateTo)
        .order("created_at", { ascending: false })
        .range(pg * PAGE_SIZE, (pg + 1) * PAGE_SIZE - 1);
      if (error || !data) break;
      allData = allData.concat(data as typeof allData);
      if (data.length < PAGE_SIZE) break;
      pg++;
    }
    const parsed: Lead[] = allData.map(ev => {
      const m = (ev.metadata || {}) as Record<string, string>;
      const phone = m.phone || m.whatsapp || "";
      return {
        id: ev.id,
        email: ev.email || m.email || "",
        created_at: ev.created_at,
        metadata: ev.metadata,
        name: m.name || "",
        phone,
        profession: m.profession || "",
        platform: m.platform || "",
        state: dddToState(phone),
        referrerDomain: extractReferrerDomain(m.referrer || ""),
        utmSource: m.utm_source || "",
        utmMedium: m.utm_medium || "",
        utmCampaign: m.utm_campaign || "",
      };
    });
    setLeads(parsed);
    setLastRefresh(new Date());
    setLoading(false);
  }, [dateFrom, dateTo]);

  const handleDeleteLead = useCallback(async () => {
    if (!selectedLead) return;
    setDeleting(true);
    try {
      const res = await fetch("/api/delete-lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: selectedLead.id }),
      });
      if (!res.ok) throw new Error("Falha ao deletar");
      setLeads(prev => prev.filter(l => l.id !== selectedLead.id));
      setSelectedLead(null);
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  }, [selectedLead]);

  useEffect(() => { fetchLeads(); }, [fetchLeads]);
  useEffect(() => {
    const interval = setInterval(fetchLeads, 30_000);
    return () => clearInterval(interval);
  }, [fetchLeads]);

  // ─── Derived metrics ────────────────────────────────────────────────────
  const todayLeads = useMemo(() => {
    const start = todayStart();
    return leads.filter(l => l.created_at >= start).length;
  }, [leads]);

  const mobileCount = useMemo(() => leads.filter(l => l.platform === "mobile").length, [leads]);
  const desktopCount = useMemo(() => leads.filter(l => l.platform !== "mobile" && l.platform).length, [leads]);

  const professionSeg = useMemo(() => {
    const map = new Map<string, number>();
    for (const l of leads) {
      const label = l.profession ? (PROFESSION_LABELS[l.profession] || l.profession) : "Não informado";
      map.set(label, (map.get(label) || 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }, [leads]);

  const deviceSeg = useMemo(() => {
    const map = new Map<string, number>();
    for (const l of leads) {
      const label = l.platform === "mobile" ? "Mobile" : l.platform ? "Desktop" : "Não informado";
      map.set(label, (map.get(label) || 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }, [leads]);

  const stateSeg = useMemo(() => {
    const map = new Map<string, number>();
    for (const l of leads) {
      const label = l.state ? `${l.state} — ${STATE_NAMES[l.state] || l.state}` : "Não identificado";
      map.set(label, (map.get(label) || 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [leads]);

  const hourlyDist = useMemo(() => {
    const counts = Array(24).fill(0) as number[];
    for (const l of leads) {
      const h = new Date(l.created_at).getHours();
      counts[h]++;
    }
    return counts;
  }, [leads]);

  const emailDomains = useMemo(() => {
    const map = new Map<string, number>();
    for (const l of leads) {
      if (!l.email) continue;
      const domain = l.email.split("@")[1]?.toLowerCase() || "desconhecido";
      map.set(domain, (map.get(domain) || 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [leads]);

  const referrerSeg = useMemo(() => {
    const map = new Map<string, number>();
    for (const l of leads) {
      map.set(l.referrerDomain, (map.get(l.referrerDomain) || 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [leads]);

  const campaignSeg = useMemo(() => {
    const map = new Map<string, number>();
    for (const l of leads) {
      if (!l.utmSource) continue;
      const key = l.utmCampaign ? `${l.utmSource} / ${l.utmCampaign}` : l.utmSource;
      map.set(key, (map.get(key) || 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [leads]);

  const hasCampaigns = campaignSeg.length > 0;

  // ─── Leads per day (last 15 days) ──────────────────────────────────────────
  const leadsByDay = useMemo(() => {
    const map = new Map<string, number>();
    for (const l of leads) {
      const day = l.created_at.slice(0, 10);
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
  }, [leads]);
  const maxDayCount = useMemo(() => Math.max(...leadsByDay.map(d => d.count), 1), [leadsByDay]);

  // ─── All professions for filter ────────────────────────────────────────────
  const allProfessions = useMemo(() => {
    const set = new Set<string>();
    for (const l of leads) if (l.profession) set.add(l.profession);
    return Array.from(set);
  }, [leads]);

  const filteredLeads = useMemo(() => {
    let list = leads;
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      list = list.filter(l =>
        l.name?.toLowerCase().includes(q) ||
        l.email?.toLowerCase().includes(q) ||
        l.phone?.includes(q)
      );
    }
    if (profFilter) list = list.filter(l => l.profession === profFilter);
    return list;
  }, [leads, searchTerm, profFilter]);

  const drillLeads = useMemo(() => {
    if (!drillFilter) return [];
    return leads.filter(l => {
      switch (drillFilter.type) {
        case "profession":
          return (PROFESSION_LABELS[l.profession] || l.profession || "Não informado") === drillFilter.value;
        case "platform":
          return (l.platform === "mobile" ? "Mobile" : l.platform ? "Desktop" : "Não informado") === drillFilter.value;
        case "state":
          return (l.state ?? "Não identificado") === drillFilter.value;
        case "domain":
          return l.email.split("@")[1]?.toLowerCase() === drillFilter.value;
        case "referrer":
          return l.referrerDomain === drillFilter.value;
        case "campaign": {
          const key = l.utmCampaign ? `${l.utmSource} / ${l.utmCampaign}` : l.utmSource;
          return key === drillFilter.value;
        }
        case "hour":
          return new Date(l.created_at).getHours() === parseInt(drillFilter.value);
        case "day":
          return l.created_at.slice(0, 10) === drillFilter.value;
        default:
          return false;
      }
    });
  }, [leads, drillFilter]);

  const pagedLeads = filteredLeads.slice(page * LEADS_PER_PAGE, (page + 1) * LEADS_PER_PAGE);
  const totalPages = Math.ceil(filteredLeads.length / LEADS_PER_PAGE);
  const maxHour = Math.max(...hourlyDist, 1);

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-5xl mx-auto px-3 sm:px-4 py-4 sm:py-8 space-y-4 sm:space-y-6">

        {/* Header */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight bg-gradient-to-r from-white to-gray-400 bg-clip-text text-transparent">
              Leads — Experimentar
            </h1>
            <p className="text-gray-500 mt-1 text-sm">Collection · capturas do fluxo &quot;experimentar&quot; em tempo real</p>
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
              onClick={() => { setPreset(p); setPage(0); }}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                preset === p
                  ? "bg-gradient-to-r from-indigo-600 to-purple-600 text-white shadow-lg"
                  : "bg-gray-800/50 text-gray-300 hover:bg-gray-700/60 border border-gray-700/50"
              }`}
            >
              {p === "today" ? "Hoje" : p === "custom" ? "Custom" : p}
            </button>
          ))}
          {preset === "custom" && (
            <div className="flex items-center gap-2">
              <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} className="bg-gray-800/50 border border-gray-700/50 rounded-lg px-3 py-1.5 text-sm" />
              <span className="text-gray-500">até</span>
              <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} className="bg-gray-800/50 border border-gray-700/50 rounded-lg px-3 py-1.5 text-sm" />
            </div>
          )}
          <button
            onClick={fetchLeads}
            className="ml-auto px-3 py-1.5 rounded-lg text-sm bg-gray-800/50 text-gray-300 hover:bg-gray-700/60 border border-gray-700/50"
          >
            ↻
          </button>
        </div>

        {/* Metric cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-4">
          <MetricCard
            label="Total de leads"
            value={formatNumber(leads.length)}
            sub={`no período selecionado`}
            color="#6366f1"
          />
          <MetricCard
            label="Leads hoje"
            value={formatNumber(todayLeads)}
            sub="desde meia-noite"
            color="#a855f7"
          />
          <MetricCard
            label="Mobile"
            value={formatNumber(mobileCount)}
            sub={leads.length > 0 ? `${((mobileCount / leads.length) * 100).toFixed(0)}% do total` : "—"}
            color="#ec4899"
          />
          <MetricCard
            label="Desktop"
            value={formatNumber(desktopCount)}
            sub={leads.length > 0 ? `${((desktopCount / leads.length) * 100).toFixed(0)}% do total` : "—"}
            color="#f59e0b"
          />
        </div>

        {/* Leads per day chart */}
        <div className="bg-gray-900/50 backdrop-blur-sm rounded-2xl p-4 sm:p-6 border border-gray-800/50">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-5">Leads por dia (últimos 15 dias)</h2>
          <div className="flex items-end gap-0.5 h-28 overflow-x-auto pb-5">
            {leadsByDay.map(({ day, count }) => {
              const heightPct = maxDayCount > 0 ? (count / maxDayCount) * 100 : 0;
              const label = new Date(day + "T12:00:00").toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
              return (
                <div
                  key={day}
                  className={`flex-1 min-w-[18px] flex flex-col items-center gap-1 group relative ${count > 0 ? "cursor-pointer" : ""}`}
                  onClick={() => { if (count > 0) { setDrillFilter({ type: "day", value: day, label }); setView("drillList"); } }}
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
                  <span className="text-[9px] text-gray-600 rotate-45 origin-left whitespace-nowrap translate-x-1">
                    {label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Segmentation */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <SegCard
            title="Profissão"
            data={professionSeg.slice(0, 6)}
            onItemClick={(label) => { setDrillFilter({ type: "profession", value: label, label }); setView("drillList"); }}
          />
          <SegCard
            title="Dispositivo"
            data={deviceSeg}
            onItemClick={(label) => { setDrillFilter({ type: "platform", value: label, label }); setView("drillList"); }}
          />
          <SegCard
            title="Estado (DDD)"
            data={stateSeg.slice(0, 6)}
            onItemClick={(label) => {
              const code = label.split(" — ")[0];
              setDrillFilter({ type: "state", value: code, label });
              setView("drillList");
            }}
          />
        </div>

        {/* Origin & Campaigns */}
        <div className={`grid grid-cols-1 ${hasCampaigns ? "sm:grid-cols-2" : ""} gap-4`}>
          <SegCard
            title="Origem"
            data={referrerSeg}
            onItemClick={(label) => { setDrillFilter({ type: "referrer", value: label, label }); setView("drillList"); }}
          />
          {hasCampaigns && (
            <SegCard
              title="Campanhas (UTM)"
              data={campaignSeg}
              onItemClick={(label) => { setDrillFilter({ type: "campaign", value: label, label }); setView("drillList"); }}
            />
          )}
        </div>

        {/* Hourly distribution */}
        <div className="bg-gray-900/50 backdrop-blur-sm rounded-2xl p-5 sm:p-6 border border-gray-800/50">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">Distribuição por hora do dia</h2>
          {leads.length === 0 && !loading ? (
            <p className="text-xs text-gray-500">Sem dados</p>
          ) : (
            <div className="flex items-end gap-1 h-24">
              {hourlyDist.map((count, h) => {
                const heightPct = maxHour > 0 ? (count / maxHour) * 100 : 0;
                return (
                  <div
                    key={h}
                    className={`flex-1 flex flex-col items-center gap-0.5 group relative ${count > 0 ? "cursor-pointer" : ""}`}
                    onClick={() => { if (count > 0) { setDrillFilter({ type: "hour", value: String(h), label: `${h}h` }); setView("drillList"); } }}
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
                    {/* tooltip */}
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
            <span>0h</span>
            <span>6h</span>
            <span>12h</span>
            <span>18h</span>
            <span>23h</span>
          </div>
        </div>

        {/* Email domain breakdown */}
        <div className="bg-gray-900/50 backdrop-blur-sm rounded-2xl p-5 sm:p-6 border border-gray-800/50">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">Domínios de email</h2>
          {emailDomains.length === 0 ? (
            <p className="text-xs text-gray-500">Sem dados</p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {emailDomains.map(([domain, count], i) => {
                const pct = leads.length > 0 ? ((count / leads.length) * 100).toFixed(1) : "0";
                return (
                  <div
                    key={domain}
                    className="bg-gray-800/40 rounded-xl p-3 hover:bg-gray-800/60 transition-colors cursor-pointer"
                    onClick={() => { setDrillFilter({ type: "domain", value: domain, label: domain }); setView("drillList"); }}
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

        {/* Leads table */}
        <div className="bg-gray-900/50 backdrop-blur-sm rounded-2xl p-3 sm:p-6 border border-gray-800/50">
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 mb-3">
            <h2 className="text-base sm:text-lg font-semibold shrink-0">Leads ({formatNumber(filteredLeads.length)})</h2>
            <div className="flex flex-1 flex-col sm:flex-row gap-2 w-full">
              <input
                type="text"
                placeholder="Buscar por nome, email ou telefone..."
                value={searchTerm}
                onChange={e => { setSearchTerm(e.target.value); setPage(0); }}
                className="flex-1 bg-gray-800/50 border border-gray-700/50 rounded-lg px-3 py-2 text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <select
                value={profFilter}
                onChange={e => { setProfFilter(e.target.value); setPage(0); }}
                className="bg-gray-800/50 border border-gray-700/50 rounded-lg px-3 py-2 text-sm text-gray-300 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="">Todas as profissões</option>
                {allProfessions.map(p => (
                  <option key={p} value={p}>{PROFESSION_LABELS[p] || p}</option>
                ))}
              </select>
            </div>
          </div>

          {loading && leads.length === 0 ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-14 bg-gray-800/30 rounded-lg animate-pulse" />
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              {pagedLeads.length === 0 ? (
                <p className="text-sm text-gray-500 py-4 text-center">Nenhum lead encontrado</p>
              ) : (
                pagedLeads.map(l => (
                  <div
                    key={l.id}
                    className="bg-gray-800/30 rounded-lg p-3 hover:bg-gray-800/50 cursor-pointer transition-all group"
                    onClick={() => { setSelectedLead(l); setView("leadDetail"); }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-sm truncate group-hover:text-indigo-300 transition-colors">
                            {l.name || l.email || "Sem nome"}
                          </span>
                          {l.profession && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300">
                              {PROFESSION_LABELS[l.profession] || l.profession}
                            </span>
                          )}
                          {l.platform && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-500/20 text-slate-300">
                              {l.platform === "mobile" ? "Mobile" : "Desktop"}
                            </span>
                          )}
                          {l.state && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300">
                              {l.state}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-gray-400 truncate mt-0.5">{l.email || "Sem email"}</p>
                      </div>
                      <div className="text-xs text-gray-500 shrink-0 text-right">
                        <div>{formatDate(l.created_at)}</div>
                        {l.phone && <div className="text-gray-600 mt-0.5">{l.phone}</div>}
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
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={page === 0}
                className="px-3 py-1.5 rounded-lg text-xs bg-gray-800/50 text-gray-300 hover:bg-gray-700/60 border border-gray-700/50 disabled:opacity-40"
              >
                ← Anterior
              </button>
              <span className="text-xs text-gray-500">{page + 1} / {totalPages}</span>
              <button
                onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                disabled={page === totalPages - 1}
                className="px-3 py-1.5 rounded-lg text-xs bg-gray-800/50 text-gray-300 hover:bg-gray-700/60 border border-gray-700/50 disabled:opacity-40"
              >
                Próximo →
              </button>
            </div>
          )}
        </div>

        <footer className="text-center text-xs text-gray-600 py-4">Atualização automática a cada 30s</footer>
      </div>

      {/* Lead detail modal */}
      {view === "leadDetail" && selectedLead && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-0 sm:p-4 z-50"
          onClick={() => { setSelectedLead(null); setConfirmDelete(false); setView(drillFilter ? "drillList" : "dashboard"); }}
        >
          <div
            className="bg-gray-900 sm:rounded-2xl max-w-lg w-full h-full sm:h-auto sm:max-h-[85vh] overflow-hidden border-0 sm:border border-gray-700"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-gray-700">
              <div className="flex items-center gap-3 min-w-0">
                {drillFilter && (
                  <button
                    onClick={() => { setSelectedLead(null); setConfirmDelete(false); setView("drillList"); }}
                    className="shrink-0 text-gray-400 hover:text-white text-sm transition-colors flex items-center gap-1"
                  >
                    ← Voltar
                  </button>
                )}
                <div className="min-w-0">
                  <h3 className="text-lg font-semibold truncate">{selectedLead.name || selectedLead.email || "Lead"}</h3>
                  <p className="text-xs text-gray-400">{formatDate(selectedLead.created_at)}</p>
                </div>
              </div>
              <button onClick={() => { setSelectedLead(null); setConfirmDelete(false); setView(drillFilter ? "drillList" : "dashboard"); }} className="text-gray-400 hover:text-white text-xl transition-colors shrink-0">✕</button>
            </div>
            <div className="p-4 overflow-y-auto h-[calc(100vh-60px)] sm:h-auto sm:max-h-[calc(85vh-60px)] space-y-4">
              <div className="grid grid-cols-2 gap-2">
                <Meta label="Nome" value={selectedLead.name || "—"} />
                <Meta label="Email" value={selectedLead.email || "—"} />
                <Meta label="Profissão" value={PROFESSION_LABELS[selectedLead.profession] || selectedLead.profession || "—"} />
                <Meta label="Plataforma" value={selectedLead.platform === "mobile" ? "Mobile" : selectedLead.platform ? "Desktop" : "—"} />
                <Meta label="Estado" value={selectedLead.state ? `${selectedLead.state} — ${STATE_NAMES[selectedLead.state] || ""}` : "—"} />
                <Meta label="DDD" value={selectedLead.phone ? (extractDDD(selectedLead.phone) || "—") : "—"} />
              </div>

              {/* Phone + WhatsApp */}
              {selectedLead.phone && (
                <div className="bg-gray-800/40 rounded-xl p-3 flex items-center justify-between gap-2">
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-0.5">Telefone / WhatsApp</div>
                    <div className="text-sm text-gray-200 font-medium">{selectedLead.phone}</div>
                  </div>
                  <a
                    href={waLink(selectedLead.phone)}
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

              {/* All metadata */}
              {selectedLead.metadata && (
                <div>
                  <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Dados completos</p>
                  <div className="bg-gray-800/30 rounded-lg p-3 space-y-1.5">
                    {Object.entries(selectedLead.metadata).map(([k, v]) => (
                      <div key={k} className="flex items-start gap-2 text-xs">
                        <span className="text-gray-500 shrink-0 w-24 truncate">{k}</span>
                        <span className="text-gray-200 break-all">{String(v)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Delete */}
              <div className="pt-2 border-t border-gray-800">
                {confirmDelete ? (
                  <div className="bg-red-950/40 border border-red-800/50 rounded-xl p-4 space-y-3">
                    <p className="text-sm text-red-300 font-medium">Tem certeza que quer deletar este lead?</p>
                    <div className="flex gap-2">
                      <button
                        onClick={handleDeleteLead}
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
                    Deletar lead
                  </button>
                )}
              </div>
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
                <h3 className="text-base font-semibold truncate">Leads — {drillFilter.label}</h3>
                <p className="text-xs text-gray-500">{drillLeads.length} lead{drillLeads.length !== 1 ? "s" : ""}</p>
              </div>
            </div>
            <div className="overflow-y-auto flex-1 p-3 space-y-2">
              {drillLeads.length === 0 ? (
                <p className="text-sm text-gray-500 py-8 text-center">Nenhum lead encontrado</p>
              ) : (
                drillLeads.map(l => (
                  <div
                    key={l.id}
                    className="bg-gray-800/40 rounded-lg p-3 hover:bg-gray-800/70 cursor-pointer transition-all group"
                    onClick={() => { setSelectedLead(l); setView("leadDetail"); }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-sm truncate group-hover:text-indigo-300 transition-colors">
                            {l.name || l.email || "Sem nome"}
                          </span>
                          {l.state && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300">{l.state}</span>
                          )}
                        </div>
                        <p className="text-xs text-gray-400 truncate mt-0.5">{l.email || "Sem email"}</p>
                        {l.phone && (
                          <a
                            href={waLink(l.phone)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-green-500 hover:text-green-400 mt-0.5 inline-block"
                            onClick={e => e.stopPropagation()}
                          >
                            {l.phone}
                          </a>
                        )}
                      </div>
                      <div className="text-xs text-gray-500 shrink-0 text-right">
                        <div>{formatDate(l.created_at)}</div>
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

// ─── Sub-components ───────────────────────────────────────────────────────
function MetricCard({ label, value, sub, color }: {
  label: string; value: string; sub: string; color: string;
}) {
  return (
    <div className="bg-gray-900/50 backdrop-blur-sm rounded-2xl p-4 border border-gray-800/50 relative overflow-hidden">
      <div
        className="absolute inset-0 opacity-5 pointer-events-none"
        style={{ background: `radial-gradient(circle at 80% 20%, ${color}, transparent 60%)` }}
      />
      <div className="text-2xl sm:text-3xl font-bold tabular-nums">{value}</div>
      <div className="text-sm font-medium text-gray-200 mt-1">{label}</div>
      <div className="text-xs text-gray-500 mt-0.5">{sub}</div>
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
