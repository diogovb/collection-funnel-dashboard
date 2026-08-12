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
/** O ClickHouse guarda a primeira semana com `platform` a partir daqui. */
const INICIO = "2026-06-08";

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

type LinhaCoorte = {
  coorte: string;
  novos: string;
  foram_ao_plugin: string;
  plugin_48h: string;
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
 * A série que responde "está crescendo?": dos usuários vistos pela PRIMEIRA
 * vez na semana W, quantos apareceram no plugin em 48h.
 *
 * Coorte fechada em 48h para as semanas serem comparáveis entre si — a taxa
 * "algum dia" favorece coorte velha, que teve mais tempo. Por isso também o
 * `d0 < today() - 2`: semana que ainda não completou 48h não entra.
 *
 * `minIf` sem linha que casa devolve o default do tipo (1970-01-01); o
 * `> toDate('1971-01-01')` é o teste de "nunca foi ao plugin".
 *
 * O lookback do subselect é maior que a série para que "primeira vez" não
 * confunda usuário antigo com usuário novo na borda da janela.
 */
function sqlCoortes(desde: string, lookback: string): string {
  return `
SELECT toMonday(d0)                                                AS coorte,
       count()                                                     AS novos,
       countIf(d_plug > toDate('1971-01-01'))                      AS foram_ao_plugin,
       countIf(d_plug > toDate('1971-01-01') AND d_plug <= d0 + 2) AS plugin_48h
FROM (
  SELECT user_id,
         min(event_date)                     AS d0,
         minIf(event_date, ${PLUGIN})        AS d_plug
  FROM events_distributed
  WHERE user_id != '' AND event_date >= ${chDate(lookback)}
  GROUP BY user_id
)
WHERE d0 >= ${chDate(desde)} AND d0 < today() - 2
GROUP BY coorte ORDER BY coorte`;
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
  const lookback = "2026-05-01";

  try {
    /* Em paralelo: cada uma leva ~6s no volume atual. */
    const [linhas, coortes] = await Promise.all([
      chQuery<LinhaSemana>(sqlSemanas(desde)),
      chQuery<LinhaCoorte>(sqlCoortes(desde, lookback)),
    ]);

    /**
     * `platform` também tem data de nascimento: o pipeline só passou a
     * carimbá-lo na semana de 15/06 — antes disso `entraram_plugin` é zero em
     * toda linha. A coorte daquela semana aparecia como "0% foram ao plugin",
     * que lido de cima para baixo desenha um crescimento inventado. O corte
     * sai da própria série, pela mesma régua dos 5% do pico.
     */
    const entraram = linhas.map((l) => n(l.entraram_plugin));
    const comPlatform = nuloAntesDoPrimeiro(entraram);
    const primeiraSemanaMedida =
      linhas.find((_, i) => comPlatform[i] !== null)?.semana ?? null;

    const cadastrosPlugin = nuloAntesDoPrimeiro(
      linhas.map((l) => n(l.cadastros_plugin)),
    );
    const cadastrosWeb = nuloAntesDoPrimeiro(linhas.map((l) => n(l.cadastros_web)));
    const instalador = nuloAntesDoPrimeiro(
      linhas.map((l) => n(l.baixaram_instalador)),
    );

    return NextResponse.json({
      atualizadoEm: new Date().toISOString(),
      desde,
      semanas: linhas.map((l, i) => ({
        semana: l.semana,
        completa: semanaCompleta(l.semana),
        entraramPlugin: n(l.entraram_plugin),
        entraramWeb: n(l.entraram_web),
        ativaramPlugin: n(l.ativaram_plugin),
        ativaramWeb: n(l.ativaram_web),
        cadastrosPlugin: cadastrosPlugin[i],
        cadastrosWeb: cadastrosWeb[i],
        baixaramInstalador: instalador[i],
      })),
      primeiraSemanaMedida,
      coortes: coortes
        .filter((c) => !primeiraSemanaMedida || c.coorte >= primeiraSemanaMedida)
        .map((c) => ({
          coorte: c.coorte,
          novos: n(c.novos),
          foramAoPlugin: n(c.foram_ao_plugin),
          pluginEm48h: n(c.plugin_48h),
          pct: n(c.novos) ? (100 * n(c.plugin_48h)) / n(c.novos) : 0,
        })),
    });
  } catch (error) {
    console.error("Erro em plugin-metrics:", error);
    return NextResponse.json(
      { error: "Erro ao consultar o ClickHouse", detalhe: String(error) },
      { status: 502 },
    );
  }
}
