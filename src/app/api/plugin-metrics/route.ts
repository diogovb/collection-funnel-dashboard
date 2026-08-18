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

/**
 * O começo da série, ancorado na SEGUNDA-FEIRA.
 *
 * ⚠️ Sem o recuo até segunda, o corte cai num dia qualquer da semana e a
 * PRIMEIRA linha nasce curta: as duas pontas agrupam por segunda
 * (`toMonday` no ClickHouse, `date_trunc('week')` no Postgres), então uma data
 * de terça joga os cadastros no balde da segunda anterior — sem a segunda em
 * si. Medido: a linha 08/06 mostrava 693 contas onde a semana inteira tem 801.
 * Uma linha 13% menor abre a série parecendo um vale que não existiu.
 */
function inicioDaSerie(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - SEMANAS * 7);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
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
 * A coorte do plugin, inteira, numa RPC do MESMO banco.
 *
 * Antes o denominador vinha de `profiles` (Supabase) e o numerador de
 * `events_distributed` (ClickHouse), juntados em memória por
 * `profiles.id === events.user_id`. Essa igualdade nunca foi verificada — e se
 * falhasse, o numerador desabava sem erro nenhum, só com percentual baixo.
 *
 * `user_platform_sessions` mede a mesma coisa no mesmo banco: 119.010 sessões,
 * ZERO órfãs. O cruzamento deixou de ser premissa e virou JOIN, e o piso das
 * 48h e a separação web/plugin passaram a viver em SQL, onde dá para testar.
 * Ver `20260818150000_coorte_do_plugin.sql`.
 */
type CoorteDoPlugin = {
  semana: string;
  novos: number;
  webNovos: number;
  webAtivou: number;
  pluginNovos: number;
  pluginAtivou: number;
  semSessao: number;
  tocouAlgumDia: number;
  madura: boolean;
};

async function buscarCoortes(desde: string): Promise<CoorteDoPlugin[]> {
  const { data, error } = await getSubsClient().rpc("admin_plugin_cohorts", {
    p_desde: desde,
    p_horas: 48,
  });
  if (error) throw new Error(`admin_plugin_cohorts: ${error.message}`);
  return ((data as { coortes?: CoorteDoPlugin[] } | null)?.coortes ?? []).map(
    (c) => ({ ...c, semana: String(c.semana).slice(0, 10) }),
  );
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

/** Semana que ainda não fechou some da comparação — está sempre "perdendo". */
function semanaCompleta(segunda: string): boolean {
  const fim = new Date(`${segunda}T00:00:00.000Z`);
  fim.setUTCDate(fim.getUTCDate() + 7);
  return fim.getTime() <= Date.now();
}

export async function GET() {
  const desde = inicioDaSerie();

  /**
   * A COORTE não depende mais do ClickHouse — vive inteira no Supabase.
   *
   * Enquanto ela era montada em memória com os toques do ClickHouse, um 503
   * aqui derrubava a seção toda com razão. Agora derrubaria à toa: sem
   * ClickHouse ficam faltando os quatro cards e a tabela crua, e a coorte
   * continua medível. Então a rota degrada em vez de sumir.
   */
  if (!clickhouseConfigurado()) {
    try {
      const coortes = await buscarCoortes(desde);
      return NextResponse.json({
        atualizadoEm: new Date().toISOString(),
        desde,
        semanas: [],
        primeiraSemanaMedida: null,
        coortes,
        avisoClickhouse: new ClickHouseNaoConfigurado().message,
      });
    } catch (error) {
      return NextResponse.json(
        { error: "ClickHouse não configurado e a coorte falhou", detalhe: String(error) },
        { status: 503 },
      );
    }
  }

  try {
    /* Em paralelo: cada consulta leva ~6s no volume atual. */
    const [linhas, dias, coortes] = await Promise.all([
      chQuery<LinhaSemana>(sqlSemanas(desde)),
      chQuery<{ dia: string; plugin: string; eventos: string }>(sqlDiasVivos(desde)),
      buscarCoortes(desde),
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
      coortes,
    });
  } catch (error) {
    console.error("Erro em plugin-metrics:", error);
    return NextResponse.json(
      { error: "Erro ao consultar o ClickHouse", detalhe: String(error) },
      { status: 502 },
    );
  }
}
