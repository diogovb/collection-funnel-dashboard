import {
  COHORT_AXES,
  COHORT_AXIS_LABELS,
  fetchExperimentCatalog,
  fetchExperimentCohorts,
  fetchExperimentFunnel,
  fetchExperimentReport,
  FUNNEL_LABELS,
  FUNNEL_STEPS,
  type CatalogPeriod,
  type CohortAxis,
  type ExperimentArm,
  type ExperimentCohorts,
  type ExperimentFunnel,
  type ExperimentReport,
  type FunnelStep,
  fetchExposicoes,
  type Exposicoes,
} from "@/lib/supabase-subs";
import {
  bootstrapRatio,
  brl,
  confidenceSequenceRadius,
  detectableDifference,
  pct,
  sampleSizePerArm,
  srmPValue,
  statsFromHistogram,
  wilson,
} from "@/lib/stats";
import {
  canaisPorUsuario,
  carregarCanais,
  type PainelDeCanais,
} from "@/lib/canais";
import { CanaisIndisponiveis, SecaoCanais } from "./canais-ui";

/**
 * Acompanhamento de testes A/B, desenhado para uma pergunta só: **já dá para
 * decidir?**
 *
 * A tela inteira é organizada contra o erro mais caro de um experimento com
 * pouco volume — declarar vencedor cedo demais. Daí três escolhas:
 *
 *  - o veredito vem PRIMEIRO, e o estado padrão dele é "ainda não dá";
 *  - nenhuma razão aparece sem faixa de incerteza, e a faixa é cinza enquanto
 *    cruzar o empate;
 *  - a régua da decisão é RECEITA por exposto, não conversão. Um preço menor
 *    quase sempre converte mais; a pergunta é se converte o bastante.
 *
 * Server Component: a credencial do banco de assinaturas fica no servidor e a
 * página chega pronta. `revalidate` de 5 min porque experimento não muda em
 * segundos — nada de polling.
 */
export const revalidate = 300;
/* A leitura por canal varre ~60 dias de eventos no ClickHouse. O banco mata a
   consulta em 45 s e o fetch aborta em 55 s; sem este teto a função morreria
   antes dos dois e o erro apontaria para o lugar errado. */
export const maxDuration = 60;

const CARD =
  "bg-gray-900/50 backdrop-blur-sm rounded-2xl p-4 border border-gray-800/50";

type Props = { searchParams: Promise<{ exp?: string; janela?: string }> };

export default async function ExperimentosPage({ searchParams }: Props) {
  const sp = await searchParams;
  const key = sp.exp || "preco_2026_08";
  const attribDays = Number(sp.janela) || 14;

  let report: ExperimentReport | null = null;
  let erro: string | null = null;
  try {
    report = await fetchExperimentReport(key, attribDays);
  } catch (e) {
    erro = e instanceof Error ? e.message : String(e);
  }

  if (erro || !report || report.error) {
    return (
      <main className="max-w-5xl mx-auto px-3 sm:px-4 py-6">
        <div className={CARD}>
          <p className="text-sm text-gray-300">
            Não foi possível carregar o experimento{" "}
            <span className="font-mono text-gray-100">{key}</span>.
          </p>
          <p className="text-xs text-gray-500 mt-2 font-mono">
            {erro ?? report?.error}
          </p>
        </div>
      </main>
    );
  }

  const exp = report.experiment;
  const catalogo = await fetchExperimentCatalog(
    [exp.control_audience, exp.variant_audience],
    exp.variant_audience,
  );

  const controle = report.arms.find((a) => a.arm === exp.control_audience);
  const variante = report.arms.find((a) => a.arm === exp.variant_audience);

  /* O funil não pode derrubar a página: ele é diagnóstico, o placar é o
     produto. Se a RPC falhar, o resto continua de pé. */
  let funil: ExperimentFunnel | null = null;
  try {
    funil = await fetchExperimentFunnel(key);
  } catch {
    funil = null;
  }

  /* Mesma postura do funil: as coortes são leitura, não placar. A RPC sobe no
     Supabase e a página na Vercel, separadas — se uma chegar antes da outra, o
     bloco some e o resto da tela continua. */
  let coortes: ExperimentCohorts | null = null;
  try {
    coortes = await fetchExperimentCohorts(key, attribDays);
  } catch {
    coortes = null;
  }

  /* Aquisição por canal. Ao contrário do funil e das coortes, o ERRO aqui não
     some em silêncio: este bloco responde à pergunta principal da tela, e um
     bloco ausente se leria como "não tem dado". Mas ele também não pode
     derrubar a página — por isso vira card vermelho, e não throw. */
  let canais: PainelDeCanais | null = null;
  let canaisErro: string | null = null;
  let canalDoUsuario: Map<string, string> | null = null;
  let exposicoes: Exposicoes | null = null;
  {
    /* As três em paralelo, e não em sequência: as duas do ClickHouse varrem
       a MESMA janela de eventos, então enfileirá-las dobraria o tempo de
       parede sem economizar leitura nenhuma. `allSettled` porque cada uma
       tem um destino diferente quando falha. */
    const [agregado, mapa, expo] = await Promise.allSettled([
      carregarCanais(attribDays),
      canaisPorUsuario(),
      fetchExposicoes(key, attribDays),
    ]);

    if (agregado.status === "fulfilled") canais = agregado.value;
    else
      canaisErro =
        agregado.reason instanceof Error
          ? agregado.reason.message
          : String(agregado.reason);

    /* Estas duas só alimentam o cruzamento com o braço. Se falharem, aquele
       bloco some e o resto da seção continua de pé — ele é leitura extra,
       não o produto da tela. */
    if (mapa.status === "fulfilled") canalDoUsuario = mapa.value;
    if (expo.status === "fulfilled") exposicoes = expo.value;
  }

  return (
    <main className="max-w-5xl mx-auto px-3 sm:px-4 py-6 space-y-4">
      <Cabecalho report={report} />
      <Veredito report={report} controle={controle} variante={variante} />
      {!!controle && !!variante && (
        <>
          <ReguaArpeu controle={controle} variante={variante} />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <CartaoBraco titulo="A · Controle" arm={controle} />
            <CartaoBraco titulo="B · Variante" arm={variante} destaque />
          </div>
          {!!coortes && (
            <Coortes
              coortes={coortes}
              controlAudience={exp.control_audience}
              variantAudience={exp.variant_audience}
            />
          )}
          <BreakEven
            controle={controle}
            variante={variante}
            catalogo={catalogo}
            controlAudience={exp.control_audience}
            variantAudience={exp.variant_audience}
          />
          <Mix controle={controle} variante={variante} />
          {!!funil && (
            <Funil
              funil={funil}
              controlAudience={exp.control_audience}
              variantAudience={exp.variant_audience}
            />
          )}
          <Retencao report={report} />
        </>
      )}
      <Saude report={report} controle={controle} variante={variante} />
      {canais ? (
        <SecaoCanais
          painel={canais}
          exposicoes={exposicoes}
          canalDoUsuario={canalDoUsuario}
          controlAudience={exp.control_audience}
          variantAudience={exp.variant_audience}
        />
      ) : (
        <CanaisIndisponiveis motivo={canaisErro ?? "origem desconhecida"} />
      )}
      <Metodologia attribDays={report.experiment.attrib_days} />
    </main>
  );
}

/* ------------------------------------------------------------ cabeçalho -- */

function Cabecalho({ report }: { report: ExperimentReport }) {
  const exp = report.experiment;
  const desde = report.health.first_exposure_at
    ? new Date(report.health.first_exposure_at)
    : null;
  const dias = desde
    ? Math.max(0, Math.floor((Date.now() - desde.getTime()) / 86400000))
    : 0;

  return (
    <div className="flex items-start justify-between gap-4 flex-wrap">
      <div>
        <h1 className="text-xl font-semibold text-gray-100">{exp.label}</h1>
        <p className="text-xs text-gray-500 mt-1">
          <span className="font-mono">{exp.key}</span> · split {exp.split_pct}/
          {100 - exp.split_pct} · janela de atribuição {exp.attrib_days} dias
          {desde ? ` · ${dias} ${dias === 1 ? "dia" : "dias"} rodando` : ""}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {/* A seção de aquisição mora no fim da página de propósito — ela mede
            outro universo. A âncora existe para quem entra aqui procurando por
            ela não precisar rolar a tela inteira para descobrir que existe. */}
        <a
          href="#aquisicao"
          className="px-2.5 py-1 rounded-lg text-xs font-medium bg-gray-800 text-gray-400 border border-gray-700 hover:text-gray-200 hover:border-gray-600 transition-colors"
        >
          Aquisição por canal ↓
        </a>
        <span
          className={
            exp.is_active
              ? "px-2.5 py-1 rounded-lg text-xs font-medium bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
              : "px-2.5 py-1 rounded-lg text-xs font-medium bg-gray-800 text-gray-400 border border-gray-700"
          }
        >
          {exp.is_active ? "No ar" : "Desligado"}
        </span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- veredito -- */

type Julgamento = {
  tom: "neutro" | "atencao" | "bom" | "ruim";
  titulo: string;
  detalhe: string;
};

function julgar(
  report: ExperimentReport,
  controle?: ExperimentArm,
  variante?: ExperimentArm,
): Julgamento {
  if (!report.health.total_exposed) {
    return {
      tom: "neutro",
      titulo: "O teste ainda não começou",
      detalhe:
        "Nenhuma pessoa foi exposta a um preço. Assim que o experimento for ligado no banco, os números aparecem aqui sozinhos.",
    };
  }
  if (!controle || !variante) {
    return {
      tom: "neutro",
      titulo: "Aguardando os dois braços",
      detalhe: "Só um dos lados registrou exposição até agora.",
    };
  }

  const sV = statsFromHistogram(variante.value_histogram, variante.mature);
  const sC = statsFromHistogram(controle.value_histogram, controle.mature);
  const razao = bootstrapRatio(
    { hist: variante.value_histogram, n: variante.mature },
    { hist: controle.value_histogram, n: controle.mature },
  );

  const semanas = report.health.first_exposure_at
    ? (Date.now() - new Date(report.health.first_exposure_at).getTime()) /
      (7 * 86400000)
    : 0;
  const minSemanas = report.experiment.config?.min_weeks ?? 4;

  if (!razao || sV.mean === 0 || sC.mean === 0) {
    /* Duas razões diferentes levam aqui, e confundi-las faz o painel mentir:
       ou ninguém cumpriu a janela de atribuição ainda (normal nas duas
       primeiras semanas — as compras EXISTEM, só não entram na taxa), ou já
       cumpriu e o volume é que é pequeno. */
    const compras = variante.buyers_all + controle.buyers_all;
    const semMaduros = variante.mature + controle.mature === 0;
    return {
      tom: "neutro",
      titulo: "Ainda não dá para concluir",
      detalhe: semMaduros
        ? `${compras} compra(s) já registrada(s) — ${variante.buyers_all} na variante, ${controle.buyers_all} no controle. ` +
          `Elas ainda não entram na conta da taxa: ninguém completou os ${report.experiment.attrib_days} dias de janela de atribuição, e medir conversão de quem viu o preço hoje afundaria o número de mentira.`
        : `Poucas compras maduras até agora (${variante.buyers} na variante, ${controle.buyers} no controle). A faixa de incerteza cobriria praticamente qualquer resultado.`,
    };
  }

  const cruzaEmpate = razao.low <= 1 && razao.high >= 1;
  const cedo = semanas < minSemanas;

  if (cruzaEmpate) {
    const apertado = razao.low > 0.95 && razao.high < 1.05;
    return apertado
      ? {
          tom: "neutro",
          titulo: "Empate de receita",
          detalhe:
            "A faixa inteira está a menos de 5% do empate: o preço menor não mudou a receita por pessoa exposta. A decisão passa a ser por critério secundário — volume de base, retenção ou posicionamento.",
        }
      : {
          tom: "neutro",
          titulo: "Ainda não dá para concluir",
          detalhe: `A faixa de incerteza (${razao.low.toFixed(2)}× a ${razao.high.toFixed(2)}×) ainda cruza o empate. Continue coletando.`,
        };
  }

  const venceVariante = razao.low > 1;
  if (cedo) {
    return {
      tom: "atencao",
      titulo: venceVariante
        ? "Variante à frente — preliminar"
        : "Controle à frente — preliminar",
      detalhe: `A faixa já não cruza o empate, mas o teste tem menos de ${minSemanas} semanas corridas. Ciclos semanais incompletos enganam: espere fechar as ${minSemanas} semanas antes de decidir.`,
    };
  }
  return venceVariante
    ? {
        tom: "bom",
        titulo: "Decisão: a variante vence",
        detalhe: `O preço menor gera ${razao.ratio.toFixed(2)}× a receita por pessoa exposta (faixa de ${razao.low.toFixed(2)}× a ${razao.high.toFixed(2)}×). Converteu o bastante para compensar o desconto.`,
      }
    : {
        tom: "ruim",
        titulo: "Decisão: o controle vence",
        detalhe: `O preço menor rende ${razao.ratio.toFixed(2)}× a receita por pessoa exposta (faixa de ${razao.low.toFixed(2)}× a ${razao.high.toFixed(2)}×). Converteu mais, mas não o bastante para pagar o desconto.`,
      };
}

function Veredito({
  report,
  controle,
  variante,
}: {
  report: ExperimentReport;
  controle?: ExperimentArm;
  variante?: ExperimentArm;
}) {
  const j = julgar(report, controle, variante);
  const cor = {
    neutro: "border-gray-800/50",
    atencao: "border-amber-500/40",
    bom: "border-emerald-500/40",
    ruim: "border-red-500/40",
  }[j.tom];
  const ponto = {
    neutro: "bg-gray-500",
    atencao: "bg-amber-400",
    bom: "bg-emerald-400",
    ruim: "bg-red-400",
  }[j.tom];

  /* Progresso até a amostra: com o desvio observado, quantas pessoas por braço
     para enxergar o MDE alvo — e quanto falta no ritmo atual. */
  let progresso: React.ReactNode = null;
  if (controle && variante && controle.mature > 10) {
    const sC = statsFromHistogram(controle.value_histogram, controle.mature);
    const mdePct = (report.experiment.config?.mde_pct ?? 20) / 100;
    const mde = sC.mean * mdePct;
    const alvo = sampleSizePerArm(sC.sd, mde);
    const atual = Math.min(controle.mature, variante.mature);
    const detectavel = detectableDifference(sC.sd, atual);
    const pctBarra = Math.min(100, (atual / alvo) * 100);
    progresso = (
      <div className="mt-4">
        <div className="flex justify-between text-xs text-gray-400 mb-1.5">
          <span>
            {atual.toLocaleString("pt-BR")} de ~{alvo.toLocaleString("pt-BR")}{" "}
            por braço
          </span>
          <span>
            hoje só enxergo diferenças acima de{" "}
            <span className="text-gray-200">
              {sC.mean > 0 ? pct(detectavel / sC.mean, 0) : "—"}
            </span>
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-gray-800 overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-indigo-500 to-purple-500"
            style={{ width: `${pctBarra}%` }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className={`${CARD} ${cor}`}>
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${ponto}`} />
        <h2 className="text-lg font-semibold text-gray-100">{j.titulo}</h2>
      </div>
      <p className="text-sm text-gray-400 mt-2 leading-relaxed">{j.detalhe}</p>
      {progresso}
    </div>
  );
}

/* --------------------------------------------------------- régua ARPEU ---- */

/**
 * A razão de receita por exposto, em escala log, com a linha do empate em 1,00.
 *
 * Escala log porque dobrar e cair pela metade têm que ocupar a mesma distância
 * visual — em escala linear, "perder metade" parece menos grave do que é.
 */
function ReguaArpeu({
  controle,
  variante,
}: {
  controle: ExperimentArm;
  variante: ExperimentArm;
}) {
  const sC = statsFromHistogram(controle.value_histogram, controle.mature);
  const sV = statsFromHistogram(variante.value_histogram, variante.mature);
  const razao = bootstrapRatio(
    { hist: variante.value_histogram, n: variante.mature },
    { hist: controle.value_histogram, n: controle.mature },
  );

  const MIN = 0.4;
  const MAX = 2.5;
  const x = (v: number) => {
    const c = Math.min(MAX, Math.max(MIN, v));
    return ((Math.log(c) - Math.log(MIN)) / (Math.log(MAX) - Math.log(MIN))) * 100;
  };

  const cruza = !razao || (razao.low <= 1 && razao.high >= 1);
  const corBarra = cruza
    ? "#525252"
    : razao!.low > 1
      ? "#34d399"
      : "#f87171";

  return (
    <div className={CARD}>
      <div className="flex items-baseline justify-between mb-1">
        <h3 className="text-sm font-medium text-gray-200">
          Receita por pessoa exposta — variante ÷ controle
        </h3>
        <span className="text-xs text-gray-500">
          {brl(Math.round(sV.mean))} vs {brl(Math.round(sC.mean))}
        </span>
      </div>
      <p className="text-xs text-gray-500 mb-5">
        É a régua da decisão: o preço já está dentro do número, então{" "}
        <span className="text-gray-300">1,00× é o empate</span>.
      </p>

      {razao ? (
        <>
          <div className="relative h-16">
            {/* trilho */}
            <div className="absolute left-0 right-0 top-7 h-px bg-gray-800" />
            {/* marcas */}
            {[0.5, 0.75, 1, 1.5, 2].map((m) => (
              <div
                key={m}
                className="absolute top-0 bottom-0"
                style={{ left: `${x(m)}%` }}
              >
                <div
                  className={
                    m === 1
                      ? "absolute top-2 bottom-5 w-px bg-gray-300"
                      : "absolute top-5 bottom-6 w-px bg-gray-800"
                  }
                />
                <span
                  className={`absolute bottom-0 -translate-x-1/2 text-[10px] ${
                    m === 1 ? "text-gray-300 font-medium" : "text-gray-600"
                  }`}
                >
                  {m === 1 ? "empate" : `${m}×`}
                </span>
              </div>
            ))}
            {/* faixa de incerteza */}
            <div
              className="absolute top-[22px] h-3 rounded-full opacity-40"
              style={{
                left: `${x(razao.low)}%`,
                width: `${Math.max(0.6, x(razao.high) - x(razao.low))}%`,
                background: corBarra,
              }}
            />
            {/* estimativa */}
            <div
              className="absolute top-[19px] w-1.5 h-[18px] rounded-sm -translate-x-1/2"
              style={{ left: `${x(razao.ratio)}%`, background: corBarra }}
            />
          </div>
          <p className="text-xs text-gray-400 mt-1">
            <span className="text-gray-100 font-medium">
              {razao.ratio.toFixed(2)}×
            </span>{" "}
            (faixa de {razao.low.toFixed(2)}× a {razao.high.toFixed(2)}×
            {cruza ? " — ainda cruza o empate" : ""})
          </p>
        </>
      ) : (
        <p className="text-sm text-gray-500">
          Ainda sem compras suficientes para estimar a razão.
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------- cartão do braço -- */

function CartaoBraco({
  titulo,
  arm,
  destaque,
}: {
  titulo: string;
  arm: ExperimentArm;
  destaque?: boolean;
}) {
  const s = statsFromHistogram(arm.value_histogram, arm.mature);
  const conv = wilson(arm.buyers, arm.mature);
  const raio = confidenceSequenceRadius(s.sd, arm.mature);

  /* DOIS RECORTES no mesmo cartão, e a distinção é o ponto:
     · Compradores e Receita são o que JÁ ACONTECEU, sobre todos os expostos —
       aparecem desde a primeira venda.
     · Receita/exposto e Conversão são TAXAS, e taxa só faz sentido sobre quem
       teve tempo de comprar: quem viu o preço hoje ainda vai comprar amanhã, e
       contá-lo no denominador afunda o número de mentira.
     Enquanto ninguém for maduro, as duas taxas dizem isso em vez de exibir um
     zero — foi o que fez o painel parecer vazio na primeira hora do teste. */
  const semMaduros = arm.mature === 0;
  /* Tolerante de propósito: a RPC vive no Supabase e esta página na Vercel, e
     elas sobem separadas. Campo novo faltando vira zero, não tela branca. */
  const descartes = arm.discarded ?? [];
  const compradores = arm.buyers_all ?? 0;
  const receita = arm.revenue_all_cents ?? 0;
  const descartadas = descartes.reduce((n, d) => n + d.attempts, 0);

  return (
    <div className={`${CARD} ${destaque ? "border-indigo-500/30" : ""}`}>
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-medium text-gray-200">{titulo}</h3>
        <span className="text-[11px] text-gray-500">
          {arm.exposed.toLocaleString("pt-BR")} expostos ·{" "}
          {arm.mature.toLocaleString("pt-BR")} maduros
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 mt-3">
        <Numero
          rotulo="Compradores"
          valor={compradores.toLocaleString("pt-BR")}
          sub="desde o início"
        />
        <Numero
          rotulo="Receita"
          valor={brl(receita)}
          sub={
            compradores > 0
              ? `ticket ${brl(Math.round(receita / compradores))}`
              : undefined
          }
        />
        <Numero
          rotulo="Receita / exposto"
          valor={semMaduros ? "—" : brl(Math.round(s.mean))}
          sub={
            semMaduros
              ? "aguardando a janela"
              : Number.isFinite(raio)
                ? `± ${brl(Math.round(raio))}`
                : "sem faixa ainda"
          }
        />
        <Numero
          rotulo="Conversão"
          valor={semMaduros ? "—" : pct(conv.p)}
          sub={
            semMaduros
              ? "aguardando a janela"
              : `${pct(conv.low)} – ${pct(conv.high)}`
          }
        />
      </div>

      {descartadas > 0 && (
        /* Tentativa que não virou receita fica VISÍVEL: sem esta linha, uma
           compra recusada ou reembolsada simplesmente some da tela e parece
           que o teste não registrou nada. */
        <p className="mt-3 text-[11px] text-gray-500 border-t border-white/5 pt-2">
          Fora da conta:{" "}
          {descartes
            .map((d) => `${d.attempts} ${ROTULO_DESCARTE[d.status] ?? d.status}`)
            .join(" · ")}
        </p>
      )}
    </div>
  );
}

/** Status cru da fatura → o que a pessoa que lê o painel entende. */
const ROTULO_DESCARTE: Record<string, string> = {
  failed: "recusada",
  pending: "aguardando pagamento",
  refunded: "reembolsada",
  canceled: "cancelada",
};

function Numero({
  rotulo,
  valor,
  sub,
}: {
  rotulo: string;
  valor: string;
  sub?: string;
}) {
  return (
    <div>
      <p className="text-[11px] text-gray-500">{rotulo}</p>
      <p className="text-lg font-semibold text-gray-100 leading-tight">
        {valor}
      </p>
      {!!sub && <p className="text-[11px] text-gray-500">{sub}</p>}
    </div>
  );
}

/* ---------------------------------------------------------- break-even ---- */

/**
 * Quanto a variante precisa converter A MAIS, por produto, só para empatar.
 *
 * É a conta que desfaz a ilusão mais comum de teste de preço: converter mais
 * não é vencer. A régua sai dos PREÇOS do banco, então serve qualquer
 * experimento futuro sem tocar no código.
 */
function BreakEven({
  controle,
  variante,
  catalogo,
  controlAudience,
  variantAudience,
}: {
  controle: ExperimentArm;
  variante: ExperimentArm;
  /* O tipo do catálogo, e não uma cópia estrutural: a cópia já deixou passar
     `price_cash_cents` em silêncio, e é justamente o campo que faz a régua
     virar faixa. */
  catalogo: CatalogPeriod[];
  controlAudience: string;
  variantAudience: string;
}) {
  const duracoes = [
    { meses: 12, nome: "Anual" },
    { meses: 1, nome: "Mensal" },
  ];

  type Linha = {
    nome: string;
    /** Menor e maior queda de preço, conforme o caminho de pagamento. */
    fatorMin: number;
    fatorMax: number;
    precoC: number;
    /** Tabela/parcelado da variante. */
    precoV: number;
    /** À vista da variante; igual a `precoV` quando o SKU tem um preço só. */
    precoVaVista: number;
    convC: number;
    convV: number;
    meta: number;
    faltam: number;
  };

  const compradoresDe = (arm: ExperimentArm, meses: number) =>
    arm.by_period
      .filter((b) => b.duration_months === meses)
      .reduce((s, b) => s + b.buyers, 0);

  const linhas: Linha[] = [];
  for (const { meses, nome } of duracoes) {
    const pC = catalogo.find(
      (c) => c.audience === controlAudience && c.duration_months === meses,
    );
    const pV = catalogo.find(
      (c) => c.audience === variantAudience && c.duration_months === meses,
    );
    if (!pC || !pV || pV.price_full_cents <= 0) continue;

    /* Denominador é TODO exposto, não só o maduro.
       `by_period` conta todos os compradores, então dividir por `mature`
       misturava numerador e denominador de recortes diferentes — com o teste
       recém-ligado, `mature` é zero e a barra da variante mostrava 0,0%
       enquanto o cartão logo acima já dizia 3 compradores. Duas leituras
       contraditórias na mesma tela.
       A taxa sai SUBESTIMADA enquanto a janela de atribuição não fecha (parte
       da gente ainda vai comprar), mas subestima os dois braços igual — então
       a comparação, que é o assunto deste bloco, continua de pé. O aviso logo
       abaixo do título diz isso. */
    const convC =
      controle.exposed > 0
        ? compradoresDe(controle, meses) / controle.exposed
        : 0;
    const convV =
      variante.exposed > 0
        ? compradoresDe(variante, meses) / variante.exposed
        : 0;
    /* O fator: quanto o preço encolheu é quanto a conversão precisa crescer.
       Com DOIS preços na variante ele deixa de ser um número. Dizer só
       697/588 = 1,19× seria propaganda: quem paga à vista paga 468, e a queda
       real vai a 1,49×. A meta desenhada é a do extremo CONSERVADOR — este
       bloco existe para impedir vitória declarada cedo, então na dúvida ele
       puxa para o lado que exige mais. */
    const aVistaV = pV.price_cash_cents ?? pV.price_full_cents;
    const fatorMin = pC.price_full_cents / pV.price_full_cents;
    const fatorMax = pC.price_full_cents / aVistaV;
    const meta = convC * Math.max(fatorMin, fatorMax);
    const faltam = Math.max(
      0,
      Math.ceil(meta * variante.exposed) - compradoresDe(variante, meses),
    );
    linhas.push({
      nome,
      fatorMin,
      fatorMax,
      precoVaVista: aVistaV,
      precoC: pC.price_full_cents,
      precoV: pV.price_full_cents,
      convC,
      convV,
      meta,
      faltam,
    });
  }

  if (!linhas.length) return null;

  /* Alguém ainda não cumpriu a janela de atribuição nos dois braços. */
  const janelaAberta =
    controle.mature < controle.exposed || variante.mature < variante.exposed;

  return (
    <div className={CARD}>
      <h3 className="text-sm font-medium text-gray-200">
        Conversão contra o empate, por produto
      </h3>
      <p className="text-xs text-gray-500 mt-1">
        Converter mais não é vencer: com preço menor, a variante precisa de mais
        compradores só para chegar à mesma receita.
      </p>
      {janelaAberta && (
        /* Sem este aviso, as porcentagens parecem baixas "de verdade" — e são
           baixas só porque parte de quem viu o preço ainda vai comprar. */
        <p className="text-[11px] text-amber-300/70 mt-1">
          Parcial: parte de quem viu o preço ainda está dentro da janela de
          atribuição, então as duas taxas estão subestimadas. Como estão
          subestimadas igual nos dois lados, a comparação já vale.
        </p>
      )}
      <div className="mb-4" />
      <div className="space-y-5">
        {linhas.map((l) => (
          <LinhaBreakEven key={l.nome} l={l} />
        ))}
      </div>
    </div>
  );
}

function LinhaBreakEven({
  l,
}: {
  l: {
    nome: string;
    fatorMin: number;
    fatorMax: number;
    precoC: number;
    precoV: number;
    precoVaVista: number;
    convC: number;
    convV: number;
    meta: number;
    faltam: number;
  };
}) {
  /* O SKU publica dois preços? Então preço e fator viram faixa. */
  const doisPrecos = l.precoVaVista !== l.precoV;
  /* Escala comum às duas barras e à meta, senão a comparação visual mente. */
  const escala = Math.max(l.meta, l.convC, l.convV, 0.0001) * 1.2;
  const largura = (v: number) => `${Math.min(100, (v / escala) * 100)}%`;
  const bateu = l.convV >= l.meta && l.meta > 0;

  return (
    <div>
      <div className="flex justify-between text-xs mb-2 gap-3">
        <span className="text-gray-300">
          {l.nome}{" "}
          <span className="text-gray-600">
            {brl(l.precoC)} →{" "}
            {doisPrecos
              ? `${brl(l.precoVaVista)}–${brl(l.precoV)}`
              : brl(l.precoV)}
          </span>
        </span>
        <span className="text-gray-500 whitespace-nowrap">
          precisa de{" "}
          <span className="text-gray-300">
            {doisPrecos
              ? `${l.fatorMin.toFixed(2)}×–${l.fatorMax.toFixed(2)}×`
              : `${l.fatorMin.toFixed(2)}×`}
          </span>{" "}
          a conversão
        </span>
      </div>

      <div className="relative rounded-lg bg-gray-950/60 border border-gray-800/50 px-2 py-2 space-y-1.5">
        <BarraConv rotulo="A" valor={l.convC} largura={largura(l.convC)} cor="bg-gray-600" />
        <BarraConv
          rotulo="B"
          valor={l.convV}
          largura={largura(l.convV)}
          cor={bateu ? "bg-emerald-500" : "bg-indigo-500"}
        />
        {/* A meta: onde a variante precisa chegar para empatar a receita. */}
        <div
          className="absolute top-1 bottom-1 border-l border-dashed border-amber-300/80"
          style={{ left: `calc(0.5rem + ${largura(l.meta)})` }}
        />
      </div>

      <p className="text-[11px] text-gray-500 mt-1.5">
        {l.meta <= 0
          ? "sem compras no controle ainda — a meta aparece quando houver"
          : l.faltam > 0
            ? `faltam +${l.faltam} ${l.faltam === 1 ? "comprador" : "compradores"} na variante para empatar a receita`
            : "a variante já passou do empate neste produto"}
      </p>
    </div>
  );
}

function BarraConv({
  rotulo,
  valor,
  largura,
  cor,
}: {
  rotulo: string;
  valor: number;
  largura: string;
  cor: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-gray-600 w-3">{rotulo}</span>
      <div className="flex-1 h-3 rounded-sm bg-gray-900/80 overflow-hidden">
        <div className={`h-full ${cor}`} style={{ width: largura }} />
      </div>
      <span className="text-[10px] text-gray-500 w-12 text-right">
        {pct(valor, 1)}
      </span>
    </div>
  );
}

/* ---------------------------------------------------------------- mix ---- */

/**
 * Onde as pessoas param entre ver o preço e pagar.
 *
 * A pergunta que este bloco existe para responder é uma só: quando um braço
 * converte menos, ele perde ONDE? Perder na vitrine (não abre o checkout) e
 * perder no pagamento (abre, escolhe, e some) têm causas opostas — preço alto
 * demais contra fricção de cobrança — e correções opostas.
 *
 * Duas leituras, de propósito:
 *
 *  - **% dos expostos** é a acumulada, e é ela que termina na conversão;
 *  - **passagem** é o degrau anterior → este. O vazamento é uma propriedade do
 *    DEGRAU, e some na acumulada: uma queda de 90% para 45% no meio parece
 *    suave quando lida como "45% do topo".
 *
 * Desistência não é linha própria: é o que falta para 100% na passagem
 * seguinte. Não existe evento de abandono aqui, e é assim de propósito — ele
 * não dispararia justamente para quem fecha a aba.
 */
function Funil({
  funil,
  controlAudience,
  variantAudience,
}: {
  funil: ExperimentFunnel;
  controlAudience: string;
  variantAudience: string;
}) {
  const contar = (arm: string, step: FunnelStep): number => {
    if (step === "viu_preco") return funil.exposed?.[arm] ?? 0;
    return funil.steps.find((s) => s.arm === arm && s.step === step)?.users ?? 0;
  };

  const expostos = (arm: string) => funil.exposed?.[arm] ?? 0;
  const totalDegraus = funil.steps.reduce((s, d) => s + d.users, 0);

  const linhas = FUNNEL_STEPS.map((step, i) => {
    const a = contar(controlAudience, step);
    const b = contar(variantAudience, step);
    const antA = i === 0 ? a : contar(controlAudience, FUNNEL_STEPS[i - 1]);
    const antB = i === 0 ? b : contar(variantAudience, FUNNEL_STEPS[i - 1]);
    return {
      step,
      a,
      b,
      antA,
      antB,
      acumA: expostos(controlAudience) ? a / expostos(controlAudience) : 0,
      acumB: expostos(variantAudience) ? b / expostos(variantAudience) : 0,
      passA: i === 0 ? 1 : antA ? a / antA : 0,
      passB: i === 0 ? 1 : antB ? b / antB : 0,
    };
  });

  /* O maior vazamento de cada braço: o degrau de pior passagem. É o único
     número desta tela que vira tarefa.
     Só entram degraus cujo ANTERIOR teve gente: sem base, a passagem é 0/0 e
     apontar "0%" ali seria acusar de vazamento um degrau onde ninguém chegou. */
  const pior = (lado: "A" | "B") => {
    const comBase = linhas
      .slice(1)
      .filter((l) => (lado === "A" ? l.antA : l.antB) > 0);
    if (!comBase.length) return null;
    return comBase.reduce((w, l) =>
      (lado === "A" ? l.passA : l.passB) < (lado === "A" ? w.passA : w.passB) ? l : w,
    );
  };

  const piorA = pior("A");
  const piorB = pior("B");

  const metodo = (arm: string, step: FunnelStep, m: string) =>
    funil.by_method.find((x) => x.arm === arm && x.step === step && x.method === m)
      ?.users ?? 0;

  /* Os métodos que a RPC devolver, na ordem de volume — a lista fixa
     pix/cartão engolia boleto e carteiras (apple_pay entrou em 14/08): o
     degrau existia na tabela e sumia da tela. */
  const NOME_DO_METODO: Record<string, string> = {
    pix: "Pix",
    credit_card: "cartão",
    boleto: "boleto",
    apple_pay: "Apple Pay",
    google_pay: "Google Pay",
  };
  const metodosVistos = Array.from(
    new Set(
      funil.by_method
        .filter((x) => x.step === "escolheu_metodo")
        .map((x) => x.method),
    ),
  ).sort(
    (a, b) =>
      metodo(controlAudience, "escolheu_metodo", b) +
      metodo(variantAudience, "escolheu_metodo", b) -
      (metodo(controlAudience, "escolheu_metodo", a) +
        metodo(variantAudience, "escolheu_metodo", a)),
  );
  const mixDoBraco = (arm: string) =>
    metodosVistos
      .map(
        (m) =>
          `${metodo(arm, "escolheu_metodo", m)} ${NOME_DO_METODO[m] ?? m}`,
      )
      .join(" · ");

  return (
    <div className={CARD}>
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h2 className="text-sm font-semibold text-gray-100">
          Onde as pessoas param
        </h2>
        <span className="text-[11px] text-gray-500">
          passagem = degrau anterior → este
        </span>
      </div>

      {totalDegraus === 0 ? (
        <p className="text-xs text-gray-500 mt-3 leading-relaxed">
          Nenhum degrau registrado ainda. Os degraus passam a ser gravados a
          partir da versão do app com a instrumentação do funil — quem viu o
          preço antes disso aparece só no topo. Não é erro: é o funil começando
          a encher.
        </p>
      ) : (
        <>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-xs min-w-[440px]">
              <thead>
                <tr className="text-gray-500 text-[11px]">
                  <th className="text-left font-normal pb-2">Degrau</th>
                  <th className="text-right font-normal pb-2">A · controle</th>
                  <th className="text-right font-normal pb-2 w-20">passagem</th>
                  <th className="text-right font-normal pb-2">B · variante</th>
                  <th className="text-right font-normal pb-2 w-20">passagem</th>
                </tr>
              </thead>
              <tbody>
                {linhas.map((l, i) => (
                  <tr key={l.step} className="border-t border-gray-800/50">
                    <td className="py-1.5 text-gray-300">
                      {FUNNEL_LABELS[l.step]}
                    </td>
                    <td className="py-1.5 text-right text-gray-100 tabular-nums">
                      {l.a}
                      <span className="text-gray-600 ml-1.5">
                        {pct(l.acumA)}
                      </span>
                    </td>
                    <td
                      className={`py-1.5 text-right tabular-nums ${
                        i > 0 && piorA?.step === l.step
                          ? "text-amber-400"
                          : "text-gray-500"
                      }`}
                    >
                      {i === 0 ? "—" : pct(l.passA)}
                    </td>
                    <td className="py-1.5 text-right text-gray-100 tabular-nums">
                      {l.b}
                      <span className="text-gray-600 ml-1.5">
                        {pct(l.acumB)}
                      </span>
                    </td>
                    <td
                      className={`py-1.5 text-right tabular-nums ${
                        i > 0 && piorB?.step === l.step
                          ? "text-amber-400"
                          : "text-gray-500"
                      }`}
                    >
                      {i === 0 ? "—" : pct(l.passB)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {(!!piorA || !!piorB) && (
            <p className="text-[11px] text-gray-500 mt-3 leading-relaxed">
              Maior vazamento —{" "}
              <span className="text-gray-400">
                A: {piorA ? FUNNEL_LABELS[piorA.step] : "—"}
              </span>
              {" · "}
              <span className="text-gray-400">
                B: {piorB ? FUNNEL_LABELS[piorB.step] : "—"}
              </span>
              . Se os dois braços vazam no mesmo degrau, o problema é do
              checkout, não do preço.
            </p>
          )}

          {metodosVistos.length > 0 && (
            <div className="mt-3 pt-3 border-t border-gray-800/50 text-[11px] text-gray-500">
              Quem escolheu cada meio —{" "}
              <span className="text-gray-400">A: {mixDoBraco(controlAudience)}</span>
              {" · "}
              <span className="text-gray-400">B: {mixDoBraco(variantAudience)}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Mix({
  controle,
  variante,
}: {
  controle: ExperimentArm;
  variante: ExperimentArm;
}) {
  const linhas = (arm: ExperimentArm) => {
    const anual = arm.by_period
      .filter((b) => b.duration_months === 12)
      .reduce((s, b) => s + b.buyers, 0);
    const mensal = arm.by_period
      .filter((b) => b.duration_months === 1)
      .reduce((s, b) => s + b.buyers, 0);
    const pix = arm.by_method
      .filter((m) => m.method === "pix")
      .reduce((s, m) => s + m.buyers, 0);
    const cartao = arm.by_method
      .filter((m) => m.method !== "pix")
      .reduce((s, m) => s + m.buyers, 0);
    /* À vista × parcelado, e em RECEITA, não em gente: é aqui que os dois
       preços do mesmo SKU aparecem. Duas vendas anuais podem valer R$ 936 ou
       R$ 1.176 dependendo desta quebra, e a contagem de compradores não
       distingue as duas coisas. Tolerante ao campo ausente para a página
       sobreviver a uma RPC mais velha. */
    const faixa = (nome: string) =>
      (arm.by_installments ?? [])
        .filter((i) => i.faixa === nome)
        .reduce((s, i) => s + i.revenue_cents, 0);
    return {
      anual,
      mensal,
      pix,
      cartao,
      aVistaCents: faixa("a_vista"),
      parceladoCents: faixa("parcelado"),
    };
  };
  const c = linhas(controle);
  const v = linhas(variante);

  const Barra = ({ a, b, ra, rb }: { a: number; b: number; ra: string; rb: string }) => {
    const t = a + b || 1;
    return (
      <div>
        <div className="flex justify-between text-[11px] text-gray-500 mb-1">
          <span>
            {ra} <span className="text-gray-300">{a}</span>
          </span>
          <span>
            {rb} <span className="text-gray-300">{b}</span>
          </span>
        </div>
        <div className="flex h-2 rounded-full overflow-hidden bg-gray-800">
          <div className="bg-indigo-500" style={{ width: `${(a / t) * 100}%` }} />
          <div className="bg-teal-500" style={{ width: `${(b / t) * 100}%` }} />
        </div>
      </div>
    );
  };

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div className={CARD}>
        <h3 className="text-sm font-medium text-gray-200 mb-3">
          Anual × Mensal
        </h3>
        <p className="text-[11px] text-gray-500 mb-2">Controle</p>
        <Barra a={c.anual} b={c.mensal} ra="anual" rb="mensal" />
        <p className="text-[11px] text-gray-500 mt-3 mb-2">Variante</p>
        <Barra a={v.anual} b={v.mensal} ra="anual" rb="mensal" />
      </div>
      <div className={CARD}>
        <h3 className="text-sm font-medium text-gray-200 mb-3">
          Pix × Cartão
        </h3>
        <p className="text-[11px] text-gray-500 mb-2">Controle</p>
        <Barra a={c.pix} b={c.cartao} ra="pix" rb="cartão" />
        <p className="text-[11px] text-gray-500 mt-3 mb-2">Variante</p>
        <Barra a={v.pix} b={v.cartao} ra="pix" rb="cartão" />
      </div>
      {(c.aVistaCents + c.parceladoCents + v.aVistaCents + v.parceladoCents) >
        0 && (
        <div className={`${CARD} sm:col-span-2`}>
          <h3 className="text-sm font-medium text-gray-200 mb-1">
            À vista × parcelado, em receita
          </h3>
          <p className="text-[11px] text-gray-500 mb-3">
            Quando um período publica dois preços, é esta quebra que explica a
            receita: à vista paga o menor, parcelado paga a tabela.
          </p>
          <p className="text-[11px] text-gray-500 mb-2">Controle</p>
          <BarraReceita a={c.aVistaCents} b={c.parceladoCents} />
          <p className="text-[11px] text-gray-500 mt-3 mb-2">Variante</p>
          <BarraReceita a={v.aVistaCents} b={v.parceladoCents} />
        </div>
      )}
    </div>
  );
}

/** Mesma barra do mix, mas rotulada em dinheiro. */
function BarraReceita({ a, b }: { a: number; b: number }) {
  const t = a + b || 1;
  return (
    <div>
      <div className="flex justify-between text-[11px] text-gray-500 mb-1">
        <span>
          à vista <span className="text-gray-300">{brl(a)}</span>
        </span>
        <span>
          parcelado <span className="text-gray-300">{brl(b)}</span>
        </span>
      </div>
      <div className="flex h-2 rounded-full overflow-hidden bg-gray-800">
        <div className="bg-emerald-500" style={{ width: `${(a / t) * 100}%` }} />
        <div className="bg-amber-500" style={{ width: `${(b / t) * 100}%` }} />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- coortes ------ */

/**
 * Abaixo de quantos expostos a taxa vira anedota.
 *
 * Com 3 expostos e 1 comprador, "33,3%" é um número verdadeiro e uma
 * informação falsa — a próxima pessoa move a taxa em 25 pontos. É a mesma
 * decisão do `bootstrapRatio`, que devolve `null` abaixo de 10 maduros: melhor
 * um traço honesto que um decimal que convida a decidir.
 */
const PISO_DA_COORTE = 20;

type QuebraPorProduto = { anual: number; mensal: number; outro: number };

type LinhaDeCoorte = {
  bucket: string;
  aExp: number;
  aComp: number;
  aProd: QuebraPorProduto;
  bExp: number;
  bComp: number;
  bProd: QuebraPorProduto;
};

/**
 * Quem comprou em cada braço — o "para quem" logo depois do "quanto".
 *
 * ## A leitura é a TAXA, não a fatia
 *
 * É tentador ler "58% dos compradores do B nunca tinham assinado" e concluir
 * algo. Não dá: se o B vende mais, a composição dos compradores se move
 * sozinha. A pergunta "o preço menor traz gente nova ou reativa quem já
 * pagou?" só é respondida por conversão DENTRO da coorte — quantos dos
 * expostos daquele grupo compraram. Por isso cada célula mostra
 * `compradores/expostos` antes da porcentagem: o denominador fica à vista.
 *
 * ## Dois eixos, não uma lista
 *
 * "Nunca assinou" e "conta de 2 anos" não são alternativas — são respostas a
 * perguntas diferentes, e a mesma pessoa tem as duas. Numa lista só, ela seria
 * contada duas vezes.
 */
function Coortes({
  coortes,
  controlAudience,
  variantAudience,
}: {
  coortes: ExperimentCohorts;
  controlAudience: string;
  variantAudience: string;
}) {
  const todas = coortes.cohorts ?? [];
  if (!todas.length) return null;

  const porEixo = (axis: CohortAxis): LinhaDeCoorte[] => {
    const doEixo = todas.filter((c) => c.axis === axis);
    const ordem = [...new Set(doEixo.map((c) => c.ord))].sort((x, y) => x - y);
    return ordem
      .map((ord) => {
        const a = doEixo.find((c) => c.ord === ord && c.arm === controlAudience);
        const b = doEixo.find((c) => c.ord === ord && c.arm === variantAudience);
        /* `?? 0` em cada campo: a RPC sobe no Supabase e a página na Vercel,
           separadas. Campo novo que ainda não chegou vira zero, não NaN. */
        const produto = (c?: (typeof doEixo)[number]): QuebraPorProduto => ({
          anual: c?.buyers_anual ?? 0,
          mensal: c?.buyers_mensal ?? 0,
          outro: c?.buyers_outro ?? 0,
        });
        return {
          bucket: a?.bucket ?? b?.bucket ?? "",
          aExp: a?.exposed ?? 0,
          aComp: a?.buyers ?? 0,
          aProd: produto(a),
          bExp: b?.exposed ?? 0,
          bComp: b?.buyers ?? 0,
          bProd: produto(b),
        };
      })
      /* Balde sem ninguém em nenhum dos dois braços não vira linha vazia. */
      .filter((l) => l.aExp + l.bExp > 0);
  };

  return (
    <div className={CARD}>
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h2 className="text-sm font-medium text-gray-200">
          Quem comprou em cada braço
        </h2>
        <span className="text-[11px] text-gray-500">
          taxa = compradores ÷ expostos <strong>da coorte</strong>
        </span>
      </div>

      {COHORT_AXES.map((axis) => {
        const linhas = porEixo(axis);
        if (!linhas.length) return null;
        return (
          <div key={axis} className="mt-4">
            <p className="text-[11px] text-gray-400 mb-1">
              {COHORT_AXIS_LABELS[axis]}
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs min-w-[420px]">
                <thead>
                  <tr className="text-gray-500 text-[11px]">
                    <th className="text-left font-normal pb-2">Coorte</th>
                    <th className="text-right font-normal pb-2">A · controle</th>
                    <th className="text-right font-normal pb-2">B · variante</th>
                    <th className="text-right font-normal pb-2 w-16">B ÷ A</th>
                  </tr>
                </thead>
                <tbody>
                  {linhas.map((l) => (
                    <LinhaCoorte key={`${axis}-${l.bucket}`} linha={l} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}

      <MatrizCoortes
        cohorts={todas}
        controlAudience={controlAudience}
        variantAudience={variantAudience}
      />

      <p className="text-[11px] text-gray-500 mt-3 leading-relaxed">
        A taxa só aparece com pelo menos {PISO_DA_COORTE} expostos na célula —
        abaixo disso um comprador a mais move a conta em dezenas de pontos. A
        linha menor quebra os <strong>compradores</strong> por produto; os
        expostos não se dividem, porque quem viu o preço ainda não escolheu
        período. &ldquo;Outro&rdquo; é assinatura cuja fatura não aponta para um
        período — fica visível para anual + mensal sempre fechar com o total.
        Compra de <strong>crédito de IA</strong> não entra em lugar nenhum desta
        tela: é outro produto, e contá-la inflava o placar dos dois braços.
        &ldquo;Já renovou&rdquo; conta faturas
        anteriores à exposição, então é piso e não retrato: quem renovou no
        sistema antigo não deixou fatura aqui e aparece em &ldquo;assinou uma
        vez&rdquo;.
      </p>
    </div>
  );
}

function LinhaCoorte({ linha }: { linha: LinhaDeCoorte }) {
  const taxa = (comp: number, exp: number) =>
    exp >= PISO_DA_COORTE ? comp / exp : null;
  const ta = taxa(linha.aComp, linha.aExp);
  const tb = taxa(linha.bComp, linha.bExp);
  /* A razão só existe com as DUAS taxas de pé — comparar contra uma célula que
     nem taxa tem seria inventar a metade que falta. */
  const razao = ta !== null && tb !== null && ta > 0 ? tb / ta : null;

  return (
    <tr className="border-t border-gray-800/50">
      <td className="py-1.5 text-gray-300 align-top">{linha.bucket}</td>
      <Celula
        compradores={linha.aComp}
        expostos={linha.aExp}
        taxa={ta}
        produto={linha.aProd}
      />
      <Celula
        compradores={linha.bComp}
        expostos={linha.bExp}
        taxa={tb}
        produto={linha.bProd}
      />
      {/* Cinza sempre: sem faixa de incerteza, colorir a razão convidaria a
          decidir por um número que ainda é ruído. */}
      <td className="py-1.5 text-right text-gray-500 tabular-nums align-top">
        {razao === null ? "—" : `${razao.toFixed(1).replace(".", ",")}×`}
      </td>
    </tr>
  );
}

function Celula({
  compradores,
  expostos,
  taxa,
  produto,
}: {
  compradores: number;
  expostos: number;
  taxa: number | null;
  produto: QuebraPorProduto;
}) {
  /* Só as parcelas que existem. "0 mensal" ocuparia uma linha inteira para
     dizer nada, e numa tabela com muitas células o vazio é o que deixa o
     preenchido visível. */
  const partes = [
    produto.anual > 0 ? `${produto.anual} anual` : null,
    produto.mensal > 0 ? `${produto.mensal} mensal` : null,
    produto.outro > 0 ? `${produto.outro} outro` : null,
  ].filter(Boolean);

  return (
    <td className="py-1.5 text-right text-gray-100 tabular-nums align-top">
      <span className="whitespace-nowrap">
        {compradores}
        <span className="text-gray-600">/{expostos}</span>
        {/* `pct` já multiplica por 100 — recebe fração, não porcentagem. */}
        <span className="text-gray-500 ml-1.5">
          {taxa === null ? "—" : pct(taxa)}
        </span>
      </span>
      {partes.length > 0 && (
        <span className="block text-[10px] text-gray-600 mt-0.5 whitespace-nowrap">
          {partes.join(" · ")}
        </span>
      )}
    </td>
  );
}

/* --------------------------------------------- coortes: o cruzamento ----- */

type CelulaDaMatriz = { exposed: number; buyers: number };

/**
 * A matriz histórico × idade da conta, um heatmap por braço.
 *
 * ## Por que ela existe
 *
 * As duas listas acima mostram MARGENS: "nunca assinou converte 4,9% no B" é a
 * média de seis células que vão de 1,9% (conta nova) a 7,5% (6–12 meses). A
 * média esconde ONDE o preço funciona — e foi exatamente a pergunta que
 * apareceu: "as 14 do B que nunca assinaram têm conta há quanto tempo?". Só o
 * cruzamento responde.
 *
 * ## Três escolhas que definem a leitura
 *
 * — A cor é a TAXA, não a quantidade. Cor pela quantidade faria 3/166 parecer
 *   mais escura que 2/13, e a segunda é a que converte melhor.
 * — A escala é COMPARTILHADA entre A e B: `taxaMax` sai das células dos dois
 *   braços juntos. Se cada um tivesse a própria escala, o A "empatado"
 *   pareceria tão escuro quanto o B, e comparar viraria ilusão.
 * — Célula abaixo do piso fica SEM cor: só o número, em cinza. É a mesma trava
 *   das listas — com 2 expostos e 1 comprador, pintar 50% seria pintar ruído.
 *
 * As colunas são as MESMAS nos dois heatmaps, mesmo quando vazias: alinhamento
 * é o que permite olhar para cima e para baixo e comparar.
 */
function MatrizCoortes({
  cohorts,
  controlAudience,
  variantAudience,
}: {
  cohorts: ExperimentCohorts["cohorts"];
  controlAudience: string;
  variantAudience: string;
}) {
  const cruz = cohorts.filter(
    (c) => c.axis === "cruzamento" && c.hist_ord != null && c.idade_ord != null,
  );
  /* RPC antiga (sem o cruzamento) → o bloco simplesmente não aparece. As duas
     pontas sobem separadas, e um campo que ainda não chegou não pode virar
     tela quebrada. */
  if (!cruz.length) return null;

  /* Rótulos vêm dos EIXOS já presentes na resposta — um lugar só de nomes; a
     matriz nunca chama de um nome o que a lista chama de outro. Filtra os
     baldes sem ninguém em nenhum braço (ex.: "sem cadastro"), mas mantém as
     colunas iguais nos dois heatmaps. */
  const rotulos = (axis: CohortAxis) => {
    const m = new Map<number, string>();
    cohorts
      .filter((c) => c.axis === axis && (c.exposed ?? 0) > 0)
      .forEach((c) => m.set(c.ord, c.bucket));
    return [...m.entries()].sort((x, y) => x[0] - y[0]);
  };
  const linhas = rotulos("historico");
  const colunas = rotulos("idade_conta");
  if (!linhas.length || !colunas.length) return null;

  const indice = new Map<string, CelulaDaMatriz>();
  cruz.forEach((c) =>
    indice.set(`${c.arm}|${c.hist_ord}|${c.idade_ord}`, {
      exposed: c.exposed ?? 0,
      buyers: c.buyers ?? 0,
    }),
  );
  const celula = (arm: string, h: number, i: number): CelulaDaMatriz =>
    indice.get(`${arm}|${h}|${i}`) ?? { exposed: 0, buyers: 0 };

  /* Escala compartilhada: a maior taxa entre as células COM base, dos dois
     braços. Uma célula fora do piso não puxa a escala nem ganha cor. */
  let taxaMax = 0;
  for (const arm of [controlAudience, variantAudience]) {
    for (const [h] of linhas) {
      for (const [i] of colunas) {
        const c = celula(arm, h, i);
        if (c.exposed >= PISO_DA_COORTE) {
          taxaMax = Math.max(taxaMax, c.buyers / c.exposed);
        }
      }
    }
  }

  const bracos: [string, string][] = [
    ["A · controle", controlAudience],
    ["B · variante", variantAudience],
  ];

  return (
    <div className="mt-5">
      <div className="flex items-baseline justify-between gap-2 flex-wrap mb-1">
        <p className="text-[11px] text-gray-400">
          Onde estão os compradores — já tinha assinado? × há quanto tempo tem
          conta
        </p>
        <span className="text-[10px] text-gray-600">
          mais escuro = converte mais · sem cor = menos de {PISO_DA_COORTE}{" "}
          expostos
        </span>
      </div>

      {bracos.map(([titulo, arm]) => (
        <div key={arm} className="mt-2 overflow-x-auto">
          <table className="text-xs min-w-[560px] w-full">
            <thead>
              <tr className="text-gray-500 text-[10px]">
                <th className="text-left font-normal pb-1 pr-2 whitespace-nowrap">
                  {titulo}
                </th>
                {colunas.map(([i, nome]) => (
                  <th key={i} className="font-normal pb-1 px-1 text-center">
                    {nome}
                  </th>
                ))}
                {/* A margem que reproduz a lista de cima. Se não bater, o
                    leitor vê — é a verificação do método, visível na tela. */}
                <th className="font-normal pb-1 pl-2 text-right text-gray-600">
                  total
                </th>
              </tr>
            </thead>
            <tbody>
              {linhas.map(([h, nome]) => {
                let expLinha = 0;
                let compLinha = 0;
                return (
                  <tr key={h} className="border-t border-gray-800/50">
                    <td className="py-0.5 pr-2 text-gray-300 whitespace-nowrap">
                      {nome}
                    </td>
                    {colunas.map(([i]) => {
                      const c = celula(arm, h, i);
                      expLinha += c.exposed;
                      compLinha += c.buyers;
                      const comBase = c.exposed >= PISO_DA_COORTE;
                      const p =
                        comBase && taxaMax > 0
                          ? c.buyers / c.exposed / taxaMax
                          : 0;
                      return (
                        <td key={i} className="px-1 py-0.5">
                          <div
                            className={`rounded px-1.5 py-1 text-center tabular-nums whitespace-nowrap ${
                              c.exposed === 0
                                ? "text-gray-700"
                                : comBase
                                ? "text-gray-100"
                                : "text-gray-500"
                            }`}
                            style={{
                              /* Mesmo idioma do heatmap de retenção. */
                              background: comBase
                                ? `rgba(99,102,241,${0.12 + p * 0.6})`
                                : "transparent",
                            }}
                            title={
                              c.exposed === 0
                                ? "ninguém exposto"
                                : comBase
                                ? `${pct(c.buyers / c.exposed)} de conversão`
                                : `poucos expostos para taxa`
                            }
                          >
                            {c.exposed === 0 ? "—" : `${c.buyers}/${c.exposed}`}
                          </div>
                        </td>
                      );
                    })}
                    <td className="py-0.5 pl-2 text-right tabular-nums text-gray-500 whitespace-nowrap">
                      {compLinha}/{expLinha}
                    </td>
                  </tr>
                );
              })}
              {/* A outra margem: soma de cada coluna reproduz a lista "há
                  quanto tempo tem conta". */}
              <tr className="border-t border-gray-800/50 text-gray-600">
                <td className="py-0.5 pr-2 text-[10px]">total</td>
                {colunas.map(([i]) => {
                  let e = 0;
                  let b = 0;
                  for (const [h] of linhas) {
                    const c = celula(arm, h, i);
                    e += c.exposed;
                    b += c.buyers;
                  }
                  return (
                    <td
                      key={i}
                      className="px-1 py-0.5 text-center tabular-nums text-[10px] whitespace-nowrap"
                    >
                      {e === 0 ? "—" : `${b}/${e}`}
                    </td>
                  );
                })}
                <td className="py-0.5 pl-2 text-right tabular-nums text-[10px] whitespace-nowrap">
                  {(() => {
                    let e = 0;
                    let b = 0;
                    for (const [h] of linhas)
                      for (const [i] of colunas) {
                        const c = celula(arm, h, i);
                        e += c.exposed;
                        b += c.buyers;
                      }
                    return `${b}/${e}`;
                  })()}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------- retenção ----- */

function Retencao({ report }: { report: ExperimentReport }) {
  if (!report.retention.length) {
    return (
      <div className={CARD}>
        <h3 className="text-sm font-medium text-gray-200">Retenção</h3>
        <p className="text-xs text-gray-500 mt-1">
          Ainda não há nenhum mês fechado. O veredito do{" "}
          <span className="text-gray-300">mensal</span> depende daqui: a R$ 49
          ele só empata se a pessoa ficar cerca do dobro do tempo.
        </p>
      </div>
    );
  }
  const meses = [...new Set(report.retention.map((r) => r.offset_month))].sort(
    (a, b) => a - b,
  );
  const bracos = [...new Set(report.retention.map((r) => r.arm))];

  return (
    <div className={CARD}>
      <h3 className="text-sm font-medium text-gray-200 mb-3">
        Retenção por braço
      </h3>
      <div className="overflow-x-auto">
        <table className="text-xs w-full">
          <thead>
            <tr className="text-gray-500">
              <th className="text-left font-normal pb-1">braço</th>
              {meses.map((m) => (
                <th key={m} className="font-normal pb-1 px-2">
                  M{m}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bracos.map((b) => (
              <tr key={b}>
                <td className="text-gray-300 pr-3 font-mono text-[11px]">{b}</td>
                {meses.map((m) => {
                  const cel = report.retention.find(
                    (r) => r.arm === b && r.offset_month === m,
                  );
                  const p = cel && cel.cohort ? cel.retained / cel.cohort : null;
                  return (
                    <td key={m} className="px-1 py-0.5">
                      <div
                        className="rounded px-2 py-1 text-center text-gray-100"
                        style={{
                          background:
                            p == null
                              ? "transparent"
                              : `rgba(99,102,241,${0.12 + p * 0.6})`,
                        }}
                      >
                        {p == null ? "—" : pct(p, 0)}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- saúde ----- */

function Saude({
  report,
  controle,
  variante,
}: {
  report: ExperimentReport;
  controle?: ExperimentArm;
  variante?: ExperimentArm;
}) {
  const exp = report.experiment;
  const srm =
    controle && variante
      ? srmPValue(
          [controle.exposed, variante.exposed],
          [100 - exp.split_pct, exp.split_pct],
        )
      : null;

  const ultima = report.health.last_exposure_at
    ? new Date(report.health.last_exposure_at)
    : null;
  const minutos = ultima
    ? Math.floor((Date.now() - ultima.getTime()) / 60000)
    : null;

  return (
    <div className={`${CARD} ${srm?.suspeito ? "border-red-500/50" : ""}`}>
      <h3 className="text-sm font-medium text-gray-200">Sanidade</h3>
      {srm?.suspeito && (
        <p className="text-xs text-red-300 mt-2">
          ⚠️ O split observado não bate com o esperado (χ² ={" "}
          {srm.chi2.toFixed(1)}). Enquanto isso não for explicado, os números
          acima não valem — um sorteio torto significa que os dois grupos não
          são comparáveis.
        </p>
      )}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3 text-xs">
        <Numero
          rotulo="Expostos"
          valor={report.health.total_exposed.toLocaleString("pt-BR")}
        />
        <Numero
          rotulo="Split observado"
          valor={
            controle && variante && controle.exposed + variante.exposed > 0
              ? `${Math.round(
                  (variante.exposed /
                    (controle.exposed + variante.exposed)) *
                    100,
                )}/${Math.round(
                  (controle.exposed /
                    (controle.exposed + variante.exposed)) *
                    100,
                )}`
              : "—"
          }
          sub={`esperado ${exp.split_pct}/${100 - exp.split_pct}`}
        />
        <Numero
          rotulo="Compras fora do teste"
          valor={String(report.health.purchases_outside_experiment)}
          sub="sem exposição"
        />
        <Numero
          rotulo="Última exposição"
          valor={
            minutos == null
              ? "—"
              : minutos < 60
                ? `há ${minutos} min`
                : `há ${Math.floor(minutos / 60)} h`
          }
        />
      </div>
      {report.health.unknown_arms > 0 && (
        <p className="text-xs text-red-300 mt-3">
          ⚠️ {report.health.unknown_arms} exposição(ões) com braço fora dos dois
          esperados.
        </p>
      )}
      {report.health.purchases_outside_experiment > 0 && (
        /* A pergunta que este número responde: "vendi X hoje, por que o painel
           mostra menos?". Quem compra sem ter passado por uma tela de preço
           não tem braço sorteado, então fica fora do numerador E do
           denominador — é o certo para a comparação, e seria uma armadilha se
           ficasse invisível. */
        <p className="text-xs text-gray-500 mt-3 leading-relaxed">
          {report.health.purchases_outside_experiment} compra(s) paga(s) desde o
          início do teste vieram de gente que nunca foi exposta a uma tela de
          preço da biblioteca — checkout do Studio, link direto ou bundle antigo
          em cache. Ficam fora do teste de propósito: sem exposição não há braço
          sorteado, e entrar só de um lado enviesaria a comparação.
        </p>
      )}
    </div>
  );
}

/* -------------------------------------------------------- metodologia ---- */

function Metodologia({ attribDays }: { attribDays: number }) {
  return (
    <details className={CARD}>
      <summary className="text-sm font-medium text-gray-300 cursor-pointer">
        Como ler esta tela
      </summary>
      <div className="text-xs text-gray-400 mt-3 space-y-2 leading-relaxed">
        <p>
          <strong className="text-gray-300">Receita por pessoa exposta</strong>{" "}
          é a métrica de decisão. Ela já embute o preço, então 1,00× é o empate:
          uma variante que converte mais mas rende menos aparece abaixo de 1.
        </p>
        <p>
          <strong className="text-gray-300">Maduros</strong> são os expostos há
          mais de {attribDays} dias — quem viu o preço ontem ainda não teve
          chance de comprar, e contá-lo derrubaria a média artificialmente.
        </p>
        <p>
          <strong className="text-gray-300">A faixa de incerteza</strong> é uma
          sequência de confiança, não um intervalo de 95% comum: ela continua
          válida mesmo com a tela sendo aberta todo dia. Um intervalo comum,
          espiado repetidamente, cruza a fronteira por acaso muito mais que 5%
          das vezes — é assim que se "descobre" vencedor que não existe.
        </p>
        <p>
          <strong className="text-gray-300">A razão</strong> vem de bootstrap
          sobre a distribuição real de gasto (quase todo mundo em zero, alguns
          poucos na cauda). Fórmula normal não serve para esse formato nesse
          tamanho de amostra.
        </p>
        <p>
          <strong className="text-gray-300">As coortes</strong> mostram taxa
          sobre os expostos <em>daquele grupo</em>, nunca a fatia que o grupo
          ocupa entre os compradores. A fatia se move sozinha quando um braço
          vende mais — ler &ldquo;a maioria dos compradores do B nunca tinha
          assinado&rdquo; como efeito do preço é o erro que essa escolha de
          denominador evita.
        </p>
        <p>
          <strong className="text-gray-300">A matriz</strong> cruza os dois
          eixos: as listas mostram a margem, a matriz mostra <em>onde</em>. A cor
          é a taxa dentro da célula, na mesma escala para A e B; célula com
          pouca base fica sem cor, e as margens à direita e embaixo têm de bater
          com as listas de cima — se não baterem, algo está contando gente
          diferente.
        </p>
      </div>
    </details>
  );
}
