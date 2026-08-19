import "server-only";
import { chQuery } from "@/lib/clickhouse";

/**
 * De onde vêm os assinantes — canal de aquisição cruzado com quem pagou.
 *
 * A pergunta que este arquivo responde é uma só: *por qual canal a gente
 * consegue mais assinantes?* O painel já respondia metade — a home mostra de
 * onde vieram os CADASTROS, o `/experimentos` mostra quem COMPROU — mas as duas
 * metades moram em bancos diferentes e nunca se encontraram.
 *
 * Elas se encontram aqui, no ClickHouse, porque lá os dois fatos moram no mesmo
 * servidor e a ponte entre eles é uma chave, não um e-mail:
 *
 *   events.anonymous_id --(identity_map)--> events.user_id
 *                                         = dim_identity.app_user_id  (auth uid)
 *                                         --> global_user_id --> fct_invoice
 *
 * Conferido em 25 uuids reais de `experiment_exposures`: 25/25 resolvem.
 *
 * SÓ DO SERVIDOR (`server-only`): a query carrega a régua de dinheiro inteira.
 */

/* ------------------------------------------------------------- constantes -- */

/**
 * Janela de observação, em dias — quanto tempo a conta tem para virar assinante.
 *
 * É o mesmo número do `?janela=` que o experimento usa como `attrib_days`, mas
 * OUTRO RELÓGIO: aqui o zero é o CADASTRO, lá é a exposição ao preço. Duas
 * populações, duas contagens; a nota de rodapé do bloco existe por causa disso.
 */
export const JANELA_PADRAO = 14;

/** Até onde a coorte vai para trás. */
export const COORTE_DIAS = 60;

/**
 * O chão da série, e ele é duro.
 *
 * `collection.events` começa em 20/06/2026, e o carimbo de plugin ficou ZERADO
 * de 03/06 a 16/06 (apagão de 14 dias, já documentado em `api/plugin-metrics`).
 * Uma semana de folga sobre o início garante que toda conta da coorte tenha
 * história observável ANTES do próprio cadastro — sem isso, quem apareceu antes
 * da série existir cai em "Direto" e infla justamente os canais baratos.
 */
export const PISO_DA_SERIE = "2026-06-27 00:00:00";

/**
 * Teto da atribuição: quanto antes do cadastro um toque ainda conta.
 *
 * Sem teto, "primeiro toque" vira "desde sempre" — uma regra que ninguém
 * consegue defender, e cujo custo de varredura cresce sozinho conforme a série
 * envelhece.
 */
export const LOOKBACK_DIAS = 30;

/** Quantos dias de evento a query varre para cobrir coorte + lookback. */
const EVENTOS_DIAS = COORTE_DIAS + LOOKBACK_DIAS + 5;

/**
 * Abaixo de quantas contas a taxa vira anedota.
 *
 * Mesmo número e mesmo motivo do `PISO_DA_COORTE` do experimento: com 3 contas
 * e 1 assinante, "33,3%" é um número verdadeiro e uma informação falsa.
 */
export const PISO_DO_CANAL = 20;

/** O balde que não é canal. Existe para o denominador não mentir. */
export const SEM_RASTRO = "Sem rastro";

/* ------------------------------------------------------------------ tipos -- */

/** Uma linha crua da query, no grão mais fino. ClickHouse manda número como string. */
type LinhaCrua = {
  semana: string;
  canal: string;
  campanha: string;
  no_plugin: number | string;
  dispositivo: string;
  landing: string;
  contas: string | number;
  assinantes: string | number;
  receita_cents: string | number;
  contas_todas: string | number;
  assinantes_todas: string | number;
};

export type Pedaco = { contas: number; assinantes: number; receitaCents: number };

export type LinhaDeCanal = {
  canal: string;
  /** Coorte MADURA: contas com pelo menos `janelaDias` de vida. É o denominador. */
  contas: number;
  /** Pagou fatura `saas` dentro da janela. É o numerador. */
  assinantes: number;
  receitaCents: number;
  /** Toda a coorte, inclusive quem ainda não maturou — o "já aconteceu". */
  contasTodas: number;
  assinantesTodas: number;
  /** O corte que explica o resto: chegou ao plugin x ficou só na web. */
  plugin: Pedaco;
  web: Pedaco;
};

export type LinhaDeCampanha = {
  canal: string;
  campanha: string;
  contas: number;
  assinantes: number;
  receitaCents: number;
};

export type LinhaSimples = {
  chave: string;
  contas: number;
  assinantes: number;
  receitaCents: number;
};

export type PontoSemanal = {
  semana: string;
  canal: string;
  contas: number;
  assinantes: number;
};

export type PainelDeCanais = {
  janelaDias: number;
  coorteDe: string;
  coorteAte: string;
  /** Ordenado por receita/conta desc. NÃO inclui o balde "Sem rastro". */
  canais: LinhaDeCanal[];
  /** Fora do ranking de propósito: não saber de onde veio não é um canal. */
  semRastro: LinhaDeCanal;
  /** Contas novas demais para entrar em qualquer taxa. */
  aindaMaturando: number;
  totais: {
    contas: number;
    assinantes: number;
    receitaCents: number;
    contasTodas: number;
  };
  campanhas: LinhaDeCampanha[];
  dispositivos: LinhaSimples[];
  landings: LinhaSimples[];
  semanal: PontoSemanal[];
  geradoEm: string;
};

/* ------------------------------------------------------------------- sql --- */

/**
 * A classificação do canal, em um lugar só.
 *
 * A ordem importa, e duas posições são decisão e não acaso:
 *
 * 1. "Google orgânico" vem ANTES de "Google Ads" porque `utm_source=google` com
 *    `utm_medium=organic` é orgânico marcado à mão, não anúncio.
 * 2. "Plugin SketchUp" vem ANTES de "Direto". O plugin abre o navegador sem
 *    referrer e sem utm; se o teste ficasse depois, a superfície inteira do
 *    plugin sumiria dentro de "Direto" — e é justamente o balde mais acionável
 *    do painel.
 */
const CLASSIFICACAO = `
    multiIf(p.tem_toque = 0, '${SEM_RASTRO}',
      lower(extractURLParameter(p.url0,'utm_source')) = 'google'
        AND lower(extractURLParameter(p.url0,'utm_medium')) IN ('organic','referral'), 'Google orgânico',
      extractURLParameter(p.url0,'gclid') != ''
        OR extractURLParameter(p.url0,'gbraid') != ''
        OR extractURLParameter(p.url0,'wbraid') != ''
        OR lower(extractURLParameter(p.url0,'utm_source')) = 'google', 'Google Ads',
      lower(extractURLParameter(p.url0,'utm_source')) IN ('fb','ig','meta','facebook','instagram'), 'Meta Ads',
      lower(extractURLParameter(p.url0,'utm_source')) = 'pinterest', 'Pinterest Ads',
      lower(extractURLParameter(p.url0,'utm_source')) = 'blog', 'Blog',
      lower(extractURLParameter(p.url0,'utm_source')) = 'collection_trigger', 'Gatilho interno',
      lower(extractURLParameter(p.url0,'utm_source')) != '', 'Outra campanha',
      positionCaseInsensitive(p.url0,'sketchupId') > 0, 'Plugin SketchUp',
      lower(cutWWW(domain(p.ref0))) = '', 'Direto',
      endsWith(lower(cutWWW(domain(p.ref0))),'collection.com.br'), 'Direto',
      lower(cutWWW(domain(p.ref0))) LIKE 'google.%'
        OR lower(cutWWW(domain(p.ref0))) LIKE '%.google.%', 'Google orgânico',
      lower(cutWWW(domain(p.ref0))) LIKE '%instagram%'
        OR lower(cutWWW(domain(p.ref0))) LIKE '%facebook%', 'Meta orgânico',
      lower(cutWWW(domain(p.ref0))) LIKE '%pinterest%', 'Pinterest orgânico',
      concat('Site: ', lower(cutWWW(domain(p.ref0))))
    )`;

/**
 * O universo, deduplicado.
 *
 * `collection_core.dim_identity_all` guarda um snapshot POR CARGA: 129.586
 * linhas para 58.882 identidades (fator 2,2x). Sem o `GROUP BY app_user_id` a
 * mesma conta entra várias vezes. `updated_at` desempata o `global_user_id`
 * porque essa tabela — ao contrário das irmãs — não tem `pulled_at`.
 *
 * E o universo é `dim_identity`, NÃO o evento `signup_finish`: medido, o evento
 * cobre só 53% das contas criadas, e o buraco é correlacionado com a superfície
 * de cadastro. Usá-lo como denominador perderia metade da base do lado errado.
 */
const IDENT = `
  ident AS (
    SELECT app_user_id                          AS uid,
           argMax(global_user_id, updated_at)   AS guid,
           min(created_at)                      AS criado
      FROM collection_core.dim_identity_all
     WHERE app = 'collection' AND is_deleted = 0
     GROUP BY app_user_id
    HAVING criado >= greatest(toDateTime('${PISO_DA_SERIE}'), now() - toIntervalDay(${COORTE_DIAS}))
  )`;

function sql(janela: number): string {
  return `
WITH
${IDENT},
  novos_uid AS (SELECT uid FROM ident),

  /* Anônimo -> logado. O identity_map cobre 79% das contas; a UNION com os
     próprios eventos leva a 91%. Os 9% que sobram são o balde "${SEM_RASTRO}",
     e é por isso que ele precisa existir separado em vez de virar "Direto".

     GLOBAL IN, e não IN: em tabela Distributed o IN simples roda em cada shard
     contra dado local e o resultado sai incompleto SEM ERRO NENHUM. */
  anons AS (
    SELECT user_id AS uid, anonymous_id AS anon
      FROM collection.identity_map_distributed
     WHERE user_id != '' AND anonymous_id != ''
       AND user_id GLOBAL IN (SELECT uid FROM novos_uid)
    UNION DISTINCT
    SELECT user_id AS uid, anonymous_id AS anon
      FROM collection.events_distributed
     WHERE event_date >= today() - ${EVENTOS_DIAS}
       AND user_id != '' AND anonymous_id != ''
       AND user_id GLOBAL IN (SELECT uid FROM novos_uid)
  )

SELECT toString(toMonday(criado)) AS semana,
       canal, campanha, no_plugin, dispositivo, landing,
       countIf(madura)                          AS contas,
       countIf(madura AND assinou = 1)          AS assinantes,
       sumIf(receita, madura AND assinou = 1)   AS receita_cents,
       count()                                  AS contas_todas,
       countIf(assinou = 1)                     AS assinantes_todas
  FROM (
    SELECT
      n.criado                                        AS criado,
      n.criado < now() - toIntervalDay(${janela})     AS madura,
      /* Os toUInt8/toInt64 não são preciosismo: sem eles o alias de um agregado
         da subconsulta é reconhecido como agregado aqui fora e o ClickHouse
         recusa com ILLEGAL_AGGREGATION ("agregado dentro de agregado"). */
      toUInt8(pg.na_janela > 0)                       AS assinou,
      toInt64(pg.cents_janela)                        AS receita,
      toUInt8(pl.usou_plugin)                         AS no_plugin,
      if(p.dev0 = '', 'não informado', p.dev0)        AS dispositivo,
      if(p.tem_toque = 0, '', lower(cutWWW(domain(p.url0)))) AS landing,
      /* Campanha só existe onde existe UTM. Sem a guarda, todo cadastro
         orgânico viraria um balde de campanha vazia. */
      if(lower(extractURLParameter(p.url0,'utm_source')) = '', '',
         substring(lower(extractURLParameter(p.url0,'utm_campaign')), 1, 60)) AS campanha,
      ${CLASSIFICACAO} AS canal
    FROM ident AS n

    /* Primeiro toque, em DOIS passos de propósito: primeiro por anônimo, depois
       o mínimo por pessoa. Juntar "anons" direto contra "events" monta um hash
       de 11 GiB e o servidor mata a query. */
    LEFT JOIN (
      SELECT a.uid                    AS uid,
             argMin(t.url0, t.t0)     AS url0,
             argMin(t.ref0, t.t0)     AS ref0,
             argMin(t.dev0, t.t0)     AS dev0,
             toUInt8(1)               AS tem_toque
        FROM anons AS a
       INNER JOIN (
         SELECT anonymous_id                              AS anon,
                toString(argMin(page_url, timestamp))     AS url0,
                toString(argMin(referrer, timestamp))     AS ref0,
                toString(argMin(device_type, timestamp))  AS dev0,
                toDateTime(min(timestamp))                AS t0
           FROM collection.events_distributed
          WHERE event_date >= today() - ${EVENTOS_DIAS}
            AND anonymous_id GLOBAL IN (SELECT anon FROM anons)
          GROUP BY anonymous_id
       ) AS t ON t.anon = a.anon
       GROUP BY a.uid
    ) AS p ON p.uid = n.uid

    /* Dinheiro. A FATURA, e não a assinatura, porque ela tem relógio
       (occurred_at) e separa crédito de IA de assinatura (revenue_stream) — a
       mesma regra do "credit_package_id IS NULL" que a RPC de coortes aplica.

       fct_invoice_all repete cada fatura 3x (144.155 linhas para 48.052
       faturas): é snapshot por carga, não deduplicado. Somar sem o
       "GROUP BY id + argMax(pulled_at)" dá R$ 770 mil onde há R$ 257 mil.
       Taxas passam ilesas; só o dinheiro quebra — que é o número que decide. */
    LEFT JOIN (
      SELECT nn.uid AS uid,
             countIf(f.quando >= nn.criado AND f.quando < nn.criado + toIntervalDay(${janela})) AS na_janela,
             sumIf(f.cents, f.quando >= nn.criado AND f.quando < nn.criado + toIntervalDay(${janela})) AS cents_janela
        FROM ident AS nn
        LEFT JOIN (
          SELECT argMax(global_user_id, pulled_at) AS guid,
                 argMax(occurred_at,    pulled_at) AS quando,
                 argMax(amount_cents,   pulled_at) AS cents,
                 argMax(status,         pulled_at) AS st,
                 argMax(revenue_stream, pulled_at) AS rs
            FROM collection_core.fct_invoice_all
           GROUP BY id
          HAVING st = 'paid' AND rs = 'saas'
             AND quando >= greatest(toDateTime('${PISO_DA_SERIE}'), now() - toIntervalDay(${COORTE_DIAS + janela}))
        ) AS f ON f.guid = nn.guid
       GROUP BY nn.uid
    ) AS pg ON pg.uid = n.uid

    /* Chegou ao plugin. "properties.platform", e não o sketchupId da URL: ele
       existe em TODO evento desde junho e cobre o Revit junto. */
    LEFT JOIN (
      SELECT user_id AS uid, toUInt8(1) AS usou_plugin
        FROM collection.events_distributed
       WHERE event_date >= today() - ${EVENTOS_DIAS}
         AND user_id GLOBAL IN (SELECT uid FROM novos_uid)
         AND JSONExtractString(properties,'platform') IN ('sketchup','revit')
       GROUP BY user_id
    ) AS pl ON pl.uid = n.uid
  ) AS base
 GROUP BY semana, canal, campanha, no_plugin, dispositivo, landing`;
}

/* ------------------------------------------------------------- agregação --- */

/** ClickHouse manda inteiro como string no FORMAT JSON. */
const n = (v: string | number | undefined): number => Number(v ?? 0);

const vazio = (canal: string): LinhaDeCanal => ({
  canal,
  contas: 0,
  assinantes: 0,
  receitaCents: 0,
  contasTodas: 0,
  assinantesTodas: 0,
  plugin: { contas: 0, assinantes: 0, receitaCents: 0 },
  web: { contas: 0, assinantes: 0, receitaCents: 0 },
});

/** Receita por conta madura — a régua. Zero contas devolve 0, não NaN. */
export const receitaPorConta = (l: { receitaCents: number; contas: number }): number =>
  l.contas > 0 ? l.receitaCents / l.contas : 0;

function somar(alvo: Pedaco, linha: LinhaCrua) {
  alvo.contas += n(linha.contas);
  alvo.assinantes += n(linha.assinantes);
  alvo.receitaCents += n(linha.receita_cents);
}

function acumular(mapa: Map<string, LinhaSimples>, chave: string, linha: LinhaCrua) {
  const atual = mapa.get(chave) ?? { chave, contas: 0, assinantes: 0, receitaCents: 0 };
  atual.contas += n(linha.contas);
  atual.assinantes += n(linha.assinantes);
  atual.receitaCents += n(linha.receita_cents);
  mapa.set(chave, atual);
}

const soData = (d: Date) => d.toISOString().slice(0, 10);

/* ------------------------------------------------------------------- api --- */

/**
 * Lança `ClickHouseNaoConfigurado` (env faltando) ou `ClickHouseError` (rede,
 * SQL, permissão). Nunca devolve objeto de erro: quem chama decide se o bloco
 * some ou se a rota responde 503.
 */
export async function carregarCanais(janelaDias?: number): Promise<PainelDeCanais> {
  /* O `?janela=` é querystring pública. Sem o clamp, `?janela=1000` esvazia a
     coorte madura e o bloco some SEM ERRO — o pior modo de falha que existe,
     porque é indistinguível de "ainda não implementado". */
  const janela = Math.min(30, Math.max(1, Math.floor(janelaDias || JANELA_PADRAO)));

  const linhas = await chQuery<LinhaCrua>(sql(janela));

  const porCanal = new Map<string, LinhaDeCanal>();
  const porCampanha = new Map<string, LinhaDeCampanha>();
  const porDispositivo = new Map<string, LinhaSimples>();
  const porLanding = new Map<string, LinhaSimples>();
  const porSemana = new Map<string, PontoSemanal>();

  let aindaMaturando = 0;

  for (const linha of linhas) {
    const canal = linha.canal || SEM_RASTRO;
    const alvo = porCanal.get(canal) ?? vazio(canal);

    alvo.contas += n(linha.contas);
    alvo.assinantes += n(linha.assinantes);
    alvo.receitaCents += n(linha.receita_cents);
    alvo.contasTodas += n(linha.contas_todas);
    alvo.assinantesTodas += n(linha.assinantes_todas);
    somar(n(linha.no_plugin) === 1 ? alvo.plugin : alvo.web, linha);
    porCanal.set(canal, alvo);

    aindaMaturando += n(linha.contas_todas) - n(linha.contas);

    if (linha.campanha) {
      const chave = `${canal} ${linha.campanha}`;
      const c = porCampanha.get(chave) ?? {
        canal,
        campanha: linha.campanha,
        contas: 0,
        assinantes: 0,
        receitaCents: 0,
      };
      c.contas += n(linha.contas);
      c.assinantes += n(linha.assinantes);
      c.receitaCents += n(linha.receita_cents);
      porCampanha.set(chave, c);
    }

    /* Dispositivo e landing só fazem sentido para quem deixou rastro. Sem o
       filtro, "não informado" viraria o maior balde dos dois cortes e diria
       apenas que 9% da base não tem evento — o que já está escrito na tela. */
    if (canal !== SEM_RASTRO) {
      acumular(porDispositivo, linha.dispositivo || "não informado", linha);
      acumular(porLanding, linha.landing || "não informado", linha);
    }

    const chaveSemana = `${linha.semana} ${canal}`;
    const s = porSemana.get(chaveSemana) ?? {
      semana: linha.semana,
      canal,
      contas: 0,
      assinantes: 0,
    };
    s.contas += n(linha.contas);
    s.assinantes += n(linha.assinantes);
    porSemana.set(chaveSemana, s);
  }

  const semRastro = porCanal.get(SEM_RASTRO) ?? vazio(SEM_RASTRO);
  porCanal.delete(SEM_RASTRO);

  const canais = [...porCanal.values()].sort((a, b) => {
    const d = receitaPorConta(b) - receitaPorConta(a);
    if (d !== 0) return d;
    /* Empate em zero: desempata por quem tem mais base, não pela ordem do Map. */
    return b.contas - a.contas;
  });

  const totais = [...canais, semRastro].reduce(
    (acc, c) => ({
      contas: acc.contas + c.contas,
      assinantes: acc.assinantes + c.assinantes,
      receitaCents: acc.receitaCents + c.receitaCents,
      contasTodas: acc.contasTodas + c.contasTodas,
    }),
    { contas: 0, assinantes: 0, receitaCents: 0, contasTodas: 0 },
  );

  const agora = new Date();
  const de = new Date(
    Math.max(Date.parse(`${PISO_DA_SERIE.replace(" ", "T")}Z`), agora.getTime() - COORTE_DIAS * 86400000),
  );
  const ate = new Date(agora.getTime() - janela * 86400000);

  return {
    janelaDias: janela,
    coorteDe: soData(de),
    coorteAte: soData(ate),
    canais,
    semRastro,
    aindaMaturando,
    totais,
    campanhas: [...porCampanha.values()].sort((a, b) => b.contas - a.contas),
    dispositivos: [...porDispositivo.values()].sort((a, b) => b.contas - a.contas),
    landings: [...porLanding.values()].sort((a, b) => b.contas - a.contas),
    semanal: [...porSemana.values()].sort((a, b) => a.semana.localeCompare(b.semana)),
    geradoEm: agora.toISOString(),
  };
}
