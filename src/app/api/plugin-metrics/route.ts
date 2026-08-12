import { NextResponse } from "next/server";
import {
  chQuery,
  chDate,
  clickhouseConfigurado,
  ClickHouseNaoConfigurado,
  PLUGIN,
  WEB,
  prop,
} from "@/lib/clickhouse";
import { getSubsClient } from "@/lib/supabase-subs";

/**
 * As três perguntas do plugin, em série semanal comparável.
 *
 *   cadastrou no plugin  →  entrou no plugin  →  ativou no plugin
 *
 * Vem do ClickHouse, e não do legado, porque `properties.platform` existe em
 * todo evento desde junho — o `scopeId` do Postgres só nasceu em 31/07 e não
 * permite comparar com o passado (ver `api/plugin-activation`).
 *
 * Só agregados: nenhuma pessoa, nenhum e-mail. Por isso a rota não precisa
 * cruzar com o Supabase do funil nem com o legado — e não expõe dado pessoal
 * num painel que hoje não tem autenticação.
 *
 * Série FIXA (semanas cheias), de propósito: ela não segue o seletor de
 * período do dashboard. Uma janela móvel de 7/30/90 dias mistura coortes e é
 * exatamente o que fazia o card antigo se mexer sem nada ter mudado.
 */

export const revalidate = 300;
export const maxDuration = 60;

/** Quantas semanas a série cobre. */
const SEMANAS = 10;
/**
 * Piso da série. O `platform` de plugin começou a ser gravado em 28/05, mas
 * **ficou zerado de 03/06 a 16/06** — um apagão de 14 dias descoberto em 12/08.
 * A guarda de dia cego (ver `sqlDiasVivos`) trata o buraco onde quer que ele
 * esteja; este piso só evita puxar dado anterior ao carimbo existir.
 */
const INICIO = "2026-05-28";

type LinhaSemana = {
  semana: string;
  entraram_plugin: string;
  entraram_web: string;
  ativaram_plugin: string;
  ativaram_web: string;
  cadastros_plugin: string;
  cadastros_web: string;
  baixaram_instalador: string;
};

function inicioDaSerie(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - SEMANAS * 7);
  const iso = d.toISOString().slice(0, 10);
  return iso < INICIO ? INICIO : iso;
}

/**
 * Quem esteve na superfície, quem baixou produto por lá, quantos cadastros
 * terminaram em cada uma e quantos baixaram o instalador.
 *
 * `user_id != ''` porque anônimo é uma string vazia só — sem o filtro ele
 * entra como "uma pessoa" em toda semana.
 */
function sqlSemanas(desde: string): string {
  return `
SELECT toMonday(event_date)                                              AS semana,
       uniqIf(user_id, ${PLUGIN})                                        AS entraram_plugin,
       uniqIf(user_id, ${WEB})                                           AS entraram_web,
       uniqIf(user_id, event_name = 'product_download' AND ${PLUGIN})    AS ativaram_plugin,
       uniqIf(user_id, event_name = 'product_download' AND ${WEB})       AS ativaram_web,
       countIf(event_name = 'signup_finish' AND ${PLUGIN})               AS cadastros_plugin,
       countIf(event_name = 'signup_finish' AND ${WEB})                  AS cadastros_web,
       uniqIf(user_id, event_name = 'plugin_download')                   AS baixaram_instalador
FROM events_distributed
WHERE event_date >= ${chDate(desde)} AND user_id != ''
GROUP BY semana ORDER BY semana`;
}

/**
 * O instante do PRIMEIRO toque de cada pessoa no plugin.
 *
 * Uma linha por pessoa (~8 mil na janela de 10 semanas). Quem cruza com a data
 * de cadastro é o Node, porque as duas pontas moram em bancos diferentes: o
 * evento no ClickHouse, a conta no Supabase de assinaturas.
 *
 * ⚠️ Este cruzamento existe por causa de um erro real que esta rota cometia.
 * A versão anterior definia a coorte como "primeira vez que a pessoa aparece
 * nos eventos", e isso NÃO é cadastro: quem já tinha conta e só voltou a logar
 * entrava como "usuário novo" — e essa gente abre o plugin muito mais que um
 * recém-cadastrado. O número saía inflado (33% onde a verdade era 8,5%) e,
 * pior, inflado de forma DESIGUAL entre as semanas, desenhando uma queda que
 * não existia. Só a data de criação da conta responde "de quem se cadastrou".
 */
function sqlPrimeiroToqueNoPlugin(desde: string): string {
  return `
SELECT user_id,
       toUnixTimestamp64Milli(min(timestamp)) AS ms
FROM events_distributed
WHERE user_id != '' AND event_date >= ${chDate(desde)} AND ${PLUGIN}
GROUP BY user_id`;
}

/**
 * Em que dias a telemetria de plugin esteve VIVA.
 *
 * Não é preciosismo: entre **03/06 e 16/06 de 2026 o carimbo de plugin ficou
 * zerado por 14 dias** enquanto a web continuou sendo gravada normalmente. Uma
 * coorte cuja janela de 48h cai nesse buraco mede 0% e parece comportamento.
 *
 * A regra é auto-corretiva: dia com evento no ar e ZERO pessoa no plugin é dia
 * cego. Se o apagão se repetir, a série se protege sozinha.
 */
function sqlDiasVivos(desde: string): string {
  return `
SELECT toString(event_date)          AS dia,
       uniqIf(user_id, ${PLUGIN})    AS plugin,
       count()                       AS eventos
FROM events_distributed
WHERE event_date >= ${chDate(desde)}
GROUP BY dia ORDER BY dia`;
}

const n = (v: string | number | undefined) => Number(v ?? 0);

/**
 * Zero antes do evento existir não é zero: é "não medido".
 *
 * `signup_finish` e `plugin_download` só entraram no pipeline em 03/08, e
 * mostrá-los como 0 nas semanas anteriores desenharia uma subida que não
 * aconteceu — o mesmo erro que o `scopeId` já produziu no card antigo.
 *
 * O corte sai dos dados e não de uma constante: se o evento for mais antigo do
 * que eu penso, nada fica escondido. Mas "primeira semana com valor > 0" não
 * serve — `plugin_download` tem UM evento solto em 20/07, quinze dias antes de
 * existir de verdade, e ele sozinho anulava a proteção. O começo é a primeira
 * semana que chega a 5% do pico da série; um evento perdido não passa disso.
 */
function nuloAntesDoPrimeiro(valores: number[]): (number | null)[] {
  const pico = Math.max(...valores, 0);
  if (pico === 0) return valores;
  const primeiro = valores.findIndex((v) => v >= pico * 0.05);
  if (primeiro <= 0) return valores;
  return valores.map((v, i) => (i < primeiro ? null : v));
}

const H48 = 48 * 3600 * 1000;

/** Segunda-feira (UTC) da semana em que a data cai. */
function segundaDaSemana(iso: string): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/**
 * Os cadastros de verdade: uma linha por conta criada, com a data.
 *
 * Vem do Supabase de ASSINATURAS (o mesmo cliente que a aba de experimentos já
 * usa), e não do funil — o `funnel_events` guarda o id do LEGADO, que não casa
 * com o `user_id` do ClickHouse. O que casa é o id do Supabase.
 */
async function buscarCadastros(
  desde: string,
): Promise<{ id: string; created_at: string }[]> {
  const sb = getSubsClient();
  const PAGINA = 1000; /* teto do PostgREST; passar disso é cortado em silêncio */
  const todos: { id: string; created_at: string }[] = [];
  for (let p = 0; p < 60; p += 1) {
    const { data, error } = await sb
      .from("profiles")
      .select("id, created_at")
      .gte("created_at", `${desde}T00:00:00Z`)
      .order("created_at", { ascending: true })
      .range(p * PAGINA, (p + 1) * PAGINA - 1);
    if (error) throw new Error(`profiles: ${error.message}`);
    const lote = data ?? [];
    todos.push(...(lote as { id: string; created_at: string }[]));
    if (lote.length < PAGINA) break;
  }
  return todos;
}

/**
 * A partir da segunda-feira, algum dos próximos `dias` ficou sem telemetria?
 *
 * `dias = 7` para a tabela semanal (a semana em si). `dias = 9` para a coorte:
 * são os 7 da semana MAIS os 2 de janela de quem se cadastrou no último dia.
 */
function temDiaCego(segunda: string, cegos: Set<string>, dias: number): boolean {
  const base = new Date(`${segunda}T00:00:00.000Z`);
  for (let i = 0; i < dias; i += 1) {
    const d = new Date(base);
    d.setUTCDate(base.getUTCDate() + i);
    if (cegos.has(d.toISOString().slice(0, 10))) return true;
  }
  return false;
}

/** Os dias em que houve evento no ar e ZERO pessoa carimbada como plugin. */
function diasCegos(dias: { dia: string; plugin: string; eventos: string }[]) {
  return new Set(
    dias.filter((d) => n(d.eventos) > 0 && n(d.plugin) === 0).map((d) => d.dia),
  );
}

/**
 * De cada turma de cadastro, quantos abriram o plugin em até 48h.
 *
 * As 48h fecham a janela no mesmo tamanho para todas as semanas — sem isso, a
 * semana mais velha ganha só por ter tido mais tempo de eventualmente instalar.
 */
function montarCoortes(
  cadastros: { id: string; created_at: string }[],
  toques: { user_id: string; ms: string }[],
  dias: { dia: string; plugin: string; eventos: string }[],
) {
  const primeiroToque = new Map(toques.map((t) => [t.user_id, Number(t.ms)]));
  const cegos = diasCegos(dias);

  const agora = Date.now();
  const acc = new Map<string, { novos: number; em48h: number; algumDia: number }>();
  for (const c of cadastros) {
    const nasceu = Date.parse(c.created_at);
    if (!Number.isFinite(nasceu)) continue;
    /* Quem se cadastrou há menos de 48h ainda pode chegar: fora da conta. */
    if (agora - nasceu < H48) continue;
    const k = segundaDaSemana(c.created_at);
    const s = acc.get(k) ?? { novos: 0, em48h: 0, algumDia: 0 };
    s.novos += 1;
    const t = primeiroToque.get(c.id);
    if (t !== undefined) {
      s.algumDia += 1;
      if (t - nasceu <= H48) s.em48h += 1;
    }
    acc.set(k, s);
  }

  return [...acc.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([coorte, s]) => {
      const medivel = !temDiaCego(coorte, cegos, 9);
      return {
        coorte,
        /* Semana do cadastro ainda em curso: a turma não está completa e o
           denominador cresce até domingo. Serve para olhar, não para comparar. */
        completa: semanaCompleta(coorte),
        novos: s.novos,
        foramAoPlugin: medivel ? s.algumDia : null,
        pluginEm48h: medivel ? s.em48h : null,
        pct: medivel && s.novos ? (100 * s.em48h) / s.novos : null,
      };
    });
}

/** Semana que ainda não fechou some da comparação — está sempre "perdendo". */
function semanaCompleta(segunda: string): boolean {
  const fim = new Date(`${segunda}T00:00:00.000Z`);
  fim.setUTCDate(fim.getUTCDate() + 7);
  return fim.getTime() <= Date.now();
}

export async function GET() {
  if (!clickhouseConfigurado()) {
    return NextResponse.json(
      {
        error: "ClickHouse não configurado",
        detalhe: new ClickHouseNaoConfigurado().message,
      },
      { status: 503 },
    );
  }

  const desde = inicioDaSerie();

  try {
    /* Em paralelo: cada consulta leva ~6s no volume atual. */
    const [linhas, toques, dias, cadastros] = await Promise.all([
      chQuery<LinhaSemana>(sqlSemanas(desde)),
      chQuery<{ user_id: string; ms: string }>(sqlPrimeiroToqueNoPlugin(desde)),
      chQuery<{ dia: string; plugin: string; eventos: string }>(sqlDiasVivos(desde)),
      buscarCadastros(desde),
    ]);

    /**
     * `platform` também tem data de nascimento: o pipeline só passou a
     * carimbá-lo na semana de 15/06 — antes disso `entraram_plugin` é zero em
     * toda linha. A coorte daquela semana aparecia como "0% foram ao plugin",
     * que lido de cima para baixo desenha um crescimento inventado. O corte
     * sai da própria série, pela mesma régua dos 5% do pico.
     */
    /* A MESMA guarda de dia cego da coorte, aplicada à tabela: a semana de
       15/06 tinha 5 dos 7 dias com telemetria e mostrava 3.125 contra ~4.000
       das vizinhas — parecia queda de uso e era buraco de medição. Aqui bastam
       os 7 dias da própria semana. */
    const cegos = diasCegos(dias);
    const semanaMedivel = (s: string) => !temDiaCego(s, cegos, 7);
    const soMedivel = (valores: number[]) =>
      valores.map((v, i) => (semanaMedivel(linhas[i].semana) ? v : null));

    const comPlatform = soMedivel(linhas.map((l) => n(l.entraram_plugin)));
    const primeiraSemanaMedida =
      linhas.find((_, i) => comPlatform[i] !== null)?.semana ?? null;

    const cadastrosPlugin = nuloAntesDoPrimeiro(
      linhas.map((l) => n(l.cadastros_plugin)),
    );
    const cadastrosWeb = nuloAntesDoPrimeiro(linhas.map((l) => n(l.cadastros_web)));
    const instalador = nuloAntesDoPrimeiro(
      linhas.map((l) => n(l.baixaram_instalador)),
    );
    /* As colunas de PLUGIN também. Faltava: a semana de 08/06 aparecia na tabela
       com "0" em Entraram e Ativaram, o que se lê como "ninguém usou o plugin" —
       e naquela semana havia 80 mil downloads acontecendo. O que não existia era
       o carimbo `platform` com valor de plugin. É exatamente o "zero que não é
       zero" que esta rota inteira existe para não cometer.

       As colunas de WEB ficam cruas de propósito: `platform='web'` já era
       gravado desde antes (2.415 pessoas na mesma semana de 08/06), então
       aquele número é medição de verdade. */
    const ativaramPlugin = soMedivel(linhas.map((l) => n(l.ativaram_plugin)));

    return NextResponse.json({
      atualizadoEm: new Date().toISOString(),
      desde,
      semanas: linhas.map((l, i) => ({
        semana: l.semana,
        completa: semanaCompleta(l.semana),
        entraramPlugin: comPlatform[i],
        entraramWeb: n(l.entraram_web),
        ativaramPlugin: ativaramPlugin[i],
        ativaramWeb: n(l.ativaram_web),
        cadastrosPlugin: cadastrosPlugin[i],
        cadastrosWeb: cadastrosWeb[i],
        baixaramInstalador: instalador[i],
      })),
      primeiraSemanaMedida,
      coortes: montarCoortes(cadastros, toques, dias),
    });
  } catch (error) {
    console.error("Erro em plugin-metrics:", error);
    return NextResponse.json(
      { error: "Erro ao consultar o ClickHouse", detalhe: String(error) },
      { status: 502 },
    );
  }
}
