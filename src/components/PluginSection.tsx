"use client";

import { useEffect, useState } from "react";

/**
 * As três perguntas do plugin, em série semanal.
 *
 *   cadastrou no plugin  →  entrou no plugin  →  ativou no plugin
 *
 * Por que é uma seção separada, e não mais um card: os cards de cima seguem o
 * seletor de período, que é uma janela MÓVEL e mistura coortes — o número se
 * mexe sem nada ter mudado no produto. Aqui a série é de semanas fechadas e
 * sempre a mesma, que é a única forma de responder "está crescendo?".
 *
 * A fonte é o ClickHouse, e não o Postgres do legado, porque `platform`
 * (sketchup/revit/web) existe em todo evento desde junho enquanto o `scopeId`
 * do legado só nasceu em 31/07 — ver `api/plugin-activation`.
 */

type Semana = {
  semana: string;
  completa: boolean;
  /* `null` = NÃO MEDIDO. O `platform` só passou a carimbar valor de plugin em
     15/06; antes disso um "0" aqui se leria como "ninguém usou o plugin", numa
     semana que teve 80 mil downloads. As colunas de web não têm essa ressalva:
     `platform='web'` já era gravado antes. */
  entraramPlugin: number | null;
  entraramWeb: number;
  ativaramPlugin: number | null;
  ativaramWeb: number;
  cadastrosPlugin: number | null;
  cadastrosWeb: number | null;
  baixaramInstalador: number | null;
};

type Coorte = {
  coorte: string;
  novos: number;
  foramAoPlugin: number;
  pluginEm48h: number;
  pct: number;
};

type Resposta = {
  atualizadoEm: string;
  semanas: Semana[];
  coortes: Coorte[];
};

const nf = (n: number) => n.toLocaleString("pt-BR");

function diaMes(iso: string): string {
  const [, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}`;
}

/** Variação contra a semana anterior, para o número não ficar sem régua. */
function Delta({ atual, anterior }: { atual: number | null; anterior: number | null }) {
  if (atual === null || anterior === null || anterior === 0) return null;
  const p = (100 * (atual - anterior)) / anterior;
  if (Math.abs(p) < 0.5) return <span className="text-xs text-gray-500">estável</span>;
  const sobe = p > 0;
  return (
    <span className={`text-xs font-semibold ${sobe ? "text-emerald-400" : "text-red-400"}`}>
      {sobe ? "▲" : "▼"} {Math.abs(p).toFixed(0)}%
    </span>
  );
}

function Numero({
  label,
  valor,
  anterior,
  sub,
  cor,
}: {
  label: string;
  valor: number | null;
  anterior: number | null;
  sub: string;
  cor: string;
}) {
  return (
    <div className="bg-gray-900/50 rounded-2xl p-4 border border-gray-800/50 relative overflow-hidden">
      <div
        className="absolute inset-0 opacity-5 pointer-events-none"
        style={{ background: `radial-gradient(circle at 80% 20%, ${cor}, transparent 60%)` }}
      />
      <div className="flex items-baseline gap-2">
        <div className="text-2xl sm:text-3xl font-bold tabular-nums">
          {valor === null ? "—" : nf(valor)}
        </div>
        <Delta atual={valor} anterior={anterior} />
      </div>
      <div className="text-sm font-medium text-gray-200 mt-1">{label}</div>
      <div className="text-xs text-gray-500 mt-0.5">{sub}</div>
    </div>
  );
}

export default function PluginSection() {
  const [dados, setDados] = useState<Resposta | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
        const res = await fetch("/api/plugin-metrics");
        const corpo = await res.json();
        if (cancelado) return;
        if (!res.ok) {
          setErro(
            res.status === 503
              ? "ClickHouse não configurado — falta CLICKHOUSE_URL / USER / PASSWORD / DB nas variáveis da Vercel."
              : String(corpo?.detalhe ?? corpo?.error ?? `HTTP ${res.status}`),
          );
          return;
        }
        setDados(corpo as Resposta);
      } catch (e) {
        if (!cancelado) setErro(String(e));
      }
    })();
    return () => {
      cancelado = true;
    };
  }, []);

  if (erro) {
    return (
      <div className="bg-gray-900/50 rounded-2xl p-4 border border-amber-700/40">
        <h3 className="text-sm font-semibold text-gray-300">Plugin</h3>
        <p className="text-xs text-amber-300/90 mt-2">{erro}</p>
      </div>
    );
  }

  if (!dados) {
    return (
      <div className="bg-gray-900/50 rounded-2xl p-4 border border-gray-800/50">
        <h3 className="text-sm font-semibold text-gray-300">Plugin</h3>
        <p className="text-xs text-gray-500 mt-2">Carregando a série semanal…</p>
      </div>
    );
  }

  /* Semana em curso está sempre "perdendo" — o retrato é a última FECHADA. */
  const fechadas = dados.semanas.filter((s) => s.completa);
  const ultima = fechadas.at(-1) ?? null;
  const penultima = fechadas.at(-2) ?? null;
  const coorteUlt = dados.coortes.at(-1) ?? null;
  const coortePen = dados.coortes.at(-2) ?? null;
  const picoCoorte = Math.max(...dados.coortes.map((c) => c.pct), 1);

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <h2 className="text-sm font-semibold text-gray-300">
          Plugin — cadastrou → entrou → ativou
        </h2>
        <span className="text-[11px] text-gray-500">
          semanas fechadas, do ClickHouse · não segue o seletor de período
        </span>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <Numero
          label="Cadastrou no plugin"
          valor={ultima?.cadastrosPlugin ?? null}
          anterior={penultima?.cadastrosPlugin ?? null}
          sub={
            ultima?.cadastrosWeb != null && ultima?.cadastrosPlugin != null
              ? `${nf(ultima.cadastrosWeb)} na web`
              : "evento só existe desde 03/08"
          }
          cor="#a855f7"
        />
        <Numero
          label="Entrou no plugin"
          valor={ultima?.entraramPlugin ?? null}
          anterior={penultima?.entraramPlugin ?? null}
          sub="pessoas distintas na semana"
          cor="#6366f1"
        />
        <Numero
          label="Ativou no plugin"
          valor={ultima?.ativaramPlugin ?? null}
          anterior={penultima?.ativaramPlugin ?? null}
          sub="baixaram produto por lá"
          cor="#f59e0b"
        />
        <Numero
          label="Baixou o instalador"
          valor={ultima?.baixaramInstalador ?? null}
          anterior={penultima?.baixaramInstalador ?? null}
          sub="na web, antes de instalar"
          cor="#10b981"
        />
      </div>

      {/* A pergunta que os cards de janela móvel não conseguem responder. */}
      <div className="bg-gray-900/50 rounded-2xl p-4 border border-gray-800/50">
        <div className="flex items-baseline justify-between flex-wrap gap-2 mb-3">
          <h3 className="text-sm font-semibold text-gray-300">
            Novos usuários que chegaram ao plugin em 48h
          </h3>
          <span className="text-[11px] text-gray-500">
            coorte fechada — semana velha teve mais tempo, então a taxa é sempre em 48h
          </span>
        </div>

        {coorteUlt && (
          <div className="flex items-baseline gap-3 mb-4">
            <span className="text-3xl font-bold tabular-nums">
              {coorteUlt.pct.toFixed(1)}%
            </span>
            <Delta atual={coorteUlt.pct} anterior={coortePen?.pct ?? null} />
            <span className="text-xs text-gray-500">
              {nf(coorteUlt.pluginEm48h)} de {nf(coorteUlt.novos)} · semana de{" "}
              {diaMes(coorteUlt.coorte)}
            </span>
          </div>
        )}

        <div className="space-y-2">
          {dados.coortes.map((c) => (
            <div key={c.coorte} className="flex items-center gap-3 text-xs">
              <span className="w-12 shrink-0 text-gray-500 tabular-nums">
                {diaMes(c.coorte)}
              </span>
              <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full bg-indigo-500 transition-all duration-700"
                  style={{ width: `${(100 * c.pct) / picoCoorte}%` }}
                />
              </div>
              <span className="w-12 shrink-0 text-right font-medium text-gray-200 tabular-nums">
                {c.pct.toFixed(1)}%
              </span>
              <span className="w-28 shrink-0 text-right text-gray-500 tabular-nums">
                {nf(c.pluginEm48h)} de {nf(c.novos)}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* A tabela crua, para conferir número por número. */}
      <div className="bg-gray-900/50 rounded-2xl p-4 border border-gray-800/50 overflow-x-auto">
        <table className="w-full text-xs min-w-[540px]">
          <thead>
            <tr className="text-gray-500 text-left">
              <th className="font-medium pb-2">Semana</th>
              <th className="font-medium pb-2 text-right">Cadastros</th>
              <th className="font-medium pb-2 text-right">Entraram</th>
              <th className="font-medium pb-2 text-right">Ativaram</th>
              <th className="font-medium pb-2 text-right">Instalador</th>
              <th className="font-medium pb-2 text-right">Entraram (web)</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {dados.semanas.map((s) => (
              <tr
                key={s.semana}
                className={`border-t border-gray-800/60 ${s.completa ? "" : "text-gray-600"}`}
              >
                <td className="py-1.5">
                  {diaMes(s.semana)}
                  {!s.completa && (
                    <span className="ml-1 text-[10px] text-gray-600">em curso</span>
                  )}
                </td>
                <td className="py-1.5 text-right">
                  {s.cadastrosPlugin === null ? "—" : nf(s.cadastrosPlugin)}
                </td>
                <td className="py-1.5 text-right">
                  {s.entraramPlugin === null ? "—" : nf(s.entraramPlugin)}
                </td>
                <td className="py-1.5 text-right">
                  {s.ativaramPlugin === null ? "—" : nf(s.ativaramPlugin)}
                </td>
                <td className="py-1.5 text-right">
                  {s.baixaramInstalador === null ? "—" : nf(s.baixaramInstalador)}
                </td>
                <td className="py-1.5 text-right text-gray-500">{nf(s.entraramWeb)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-[11px] text-gray-600 mt-3">
          “—” é <strong>não medido</strong>, não zero. Cada régua tem data de
          nascimento: <code>signup_finish</code> e <code>plugin_download</code> entraram
          no pipeline em 03/08, e o <code>platform</code> só passou a carimbar valor de
          plugin em 15/06.
        </p>
      </div>
    </div>
  );
}
