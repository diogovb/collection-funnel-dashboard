import "server-only";
import { chQuery } from "@/lib/clickhouse";
import {
  COORTE_DIAS,
  EVENTOS_DIAS,
  IDENT,
  JANELA_PADRAO,
  PISO_DA_SERIE,
  PISO_DO_CANAL,
  type LinhaDeCanal,
  type Pedaco,
  canalConfiavel,
  ordemDoRanking,
} from "@/lib/canais";
import {
  CANAL,
  classificacaoSql,
  qualidadeDoSinal,
  type Qualidade,
} from "@/lib/origem";

/**
 * A origem do cadastro em quatro camadas — o que a tela `/origem` mostra.
 *
 * O painel já sabia responder "de onde veio" com um rótulo; o que faltava era
 * a profundidade. "Site" não dizia qual site, e "Plugin" não dizia como a
 * pessoa chegou até lá. Este arquivo desce quatro degraus:
 *
 *   canal  ->  peça (campanha / criativo / posicionamento)
 *          ->  porta (host + rota de aterrissagem)
 *          ->  interesse declarado
 *
 * NADA aqui é sinal novo: os quatro degraus já estavam no `page_url` do
 * primeiro toque e nos eventos de cadastro, e simplesmente nunca eram lidos.
 * `utm_content` — que é onde o Meta grava o nome do criativo e o blog grava o
 * slug do post — não era lido por nenhuma tela do repositório.
 *
 * Régua igual à do `canais.ts` de propósito: mesma coorte, mesmo primeiro
 * toque, mesma janela de maturação, mesma fatura. Duas telas com o mesmo
 * denominador podem ser comparadas; foi a falta disso que fez a home e o
 * `/experimentos` divergirem.
 *
 * SÓ DO SERVIDOR: carrega a régua de dinheiro inteira.
 */

/* ------------------------------------------------------------------ tipos -- */

/** Compatível com `LinhaDeCanal` para reusar `ordemDoRanking`/`canalConfiavel`. */
export type LinhaDeOrigem = LinhaDeCanal & { qualidade: Qualidade };

/** Uma peça de mídia: a campanha, o criativo e onde ele apareceu. */
export type LinhaDePeca = {
  canal: string;
  campanha: string;
  /** `utm_content` — nome do criativo (Meta) ou slug do post (blog). */
  criativo: string;
  /** `utm_medium` — posicionamento no Meta, `cpc` no Google, CTA no blog. */
  posicao: string;
  contas: number;
  assinantes: number;
  receitaCents: number;
  /** Inclui quem ainda não teve os `janelaDias` para assinar. */
  contasTodas: number;
};

/** Por qual porta a pessoa entrou: host + primeira rota. */
export type LinhaDePorta = {
  host: string;
  rota: string;
  dispositivo: string;
  contas: number;
  assinantes: number;
  receitaCents: number;
  /** Inclui quem ainda não teve os `janelaDias` para assinar. */
  contasTodas: number;
};

/** O que a pessoa DISSE que queria, cruzado com de onde ela veio. */
export type LinhaDeInteresse = {
  canal: string;
  interesse: string;
  metodo: string;
  contas: number;
};

export type PainelDeOrigem = {
  janelaDias: number;
  coorteDe: string;
  coorteAte: string;
  /** Ranking, já sem os baldes que não são canal. */
  canais: LinhaDeOrigem[];
  /** Fora do ranking, com o motivo — ver `FORA_DO_RANKING` em `origem.ts`. */
  foraDoRanking: LinhaDeOrigem[];
  pecas: LinhaDePeca[];
  portas: LinhaDePorta[];
  totais: { contas: number; assinantes: number; receitaCents: number; contasTodas: number };
  geradoEm: string;
};

/* -------------------------------------------------------------------- sql -- */

type LinhaCrua = {
  canal: string;
  campanha: string;
  criativo: string;
  posicao: string;
  host: string;
  rota: string;
  dispositivo: string;
  no_plugin: number | string;
  contas: string | number;
  assinantes: string | number;
  receita_cents: string | number;
  contas_todas: string | number;
  assinantes_todas: string | number;
};

/**
 * Texto de UTM legível.
 *
 * Chega duas vezes escapado: `An%C3%BAncio+Blocos+Carrossel` é
 * "Anúncio Blocos Carrossel". O `+` é espaço da era dos formulários e o
 * `decodeURLComponent` do ClickHouse não o traduz — daí o `replaceAll` antes.
 * Sem isso a tela mostra o criativo em código, que é pior do que não mostrar.
 */
const texto = (url: string, chave: string, tamanho: number) =>
  `substring(decodeURLComponent(replaceAll(extractURLParameter(${url},'${chave}'),'+',' ')),1,${tamanho})`;

/**
 * A primeira rota, e só ela.
 *
 * `/produto/mesa-de-jantar-xyz` vira `/produto` de propósito: o que decide é
 * "entrou pela busca, pela PDP ou pela landing", não qual produto. Guardar o
 * path inteiro multiplicaria as linhas por milhares sem responder nada — e o
 * grão atual cabe em ~100 linhas para 7.400 contas.
 */
const ROTA = (url: string) =>
  `concat('/', arrayElement(splitByChar('/', path(${url})), 2))`;

function sql(janela: number): string {
  const CLASSIFICACAO = classificacaoSql({
    url: "p.url0",
    ref: "p.ref0",
    semToque: "p.tem_toque = 0",
  });

  /* Campanha, criativo e posição só existem onde existe UTM. Sem a guarda,
     todo cadastro orgânico viraria uma linha de peça vazia. */
  const seTemUtm = (expr: string) =>
    `if(lower(extractURLParameter(p.url0,'utm_source')) = '', '', ${expr})`;

  return `
WITH
${IDENT},
  novos_uid AS (SELECT uid FROM ident),

  /* GLOBAL IN, e não IN: em tabela Distributed o IN simples roda em cada shard
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

SELECT canal, campanha, criativo, posicao, host, rota, dispositivo, no_plugin,
       countIf(madura)                          AS contas,
       countIf(madura AND assinou = 1)          AS assinantes,
       sumIf(receita, madura AND assinou = 1)   AS receita_cents,
       count()                                  AS contas_todas,
       countIf(assinou = 1)                     AS assinantes_todas
  FROM (
    SELECT
      n.criado < now() - toIntervalDay(${janela})     AS madura,
      /* Os toUInt8/toInt64 não são preciosismo: sem eles o alias de um agregado
         da subconsulta é reconhecido como agregado aqui fora e o ClickHouse
         recusa com ILLEGAL_AGGREGATION. */
      toUInt8(pg.na_janela > 0)                       AS assinou,
      toInt64(pg.cents_janela)                        AS receita,
      toUInt8(pl.usou_plugin)                         AS no_plugin,
      if(p.dev0 = '', 'não informado', p.dev0)        AS dispositivo,
      if(p.tem_toque = 0, '', lower(cutWWW(domain(p.url0)))) AS host,
      if(p.tem_toque = 0, '', ${ROTA("p.url0")})      AS rota,
      ${seTemUtm(texto("p.url0", "utm_campaign", 60))} AS campanha,
      ${seTemUtm(texto("p.url0", "utm_content", 60))}  AS criativo,
      ${seTemUtm(texto("p.url0", "utm_medium", 40))}   AS posicao,
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

    /* Dinheiro pela FATURA, deduplicada: fct_invoice_all é snapshot por carga e
       repete cada fatura ~3x. Somar sem o argMax(pulled_at) dá R$ 770 mil onde
       há R$ 257 mil. Taxas passam ilesas; só o dinheiro quebra. */
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
 GROUP BY canal, campanha, criativo, posicao, host, rota, dispositivo, no_plugin`;
}

/* --------------------------------------------------------------- agregação -- */

/** ClickHouse manda inteiro como string no FORMAT JSON. */
const n = (v: string | number | undefined): number => Number(v ?? 0);

const vazia = (canal: string): LinhaDeOrigem => ({
  canal,
  qualidade: qualidadeDoSinal(canal),
  contas: 0,
  assinantes: 0,
  receitaCents: 0,
  contasTodas: 0,
  assinantesTodas: 0,
  plugin: { contas: 0, assinantes: 0, receitaCents: 0 },
  web: { contas: 0, assinantes: 0, receitaCents: 0 },
});

function somar(alvo: Pedaco, linha: LinhaCrua) {
  alvo.contas += n(linha.contas);
  alvo.assinantes += n(linha.assinantes);
  alvo.receitaCents += n(linha.receita_cents);
}

const soData = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Quem não disputa o ranking.
 *
 * Os quatro têm o mesmo problema por motivos diferentes: comparar taxa de
 * assinatura entre eles e um canal de aquisição compara coisas de naturezas
 * distintas. Eles continuam no total — o denominador não perde nada.
 */
const BALDES_FORA = new Set<string>([
  CANAL.semRastro,
  CANAL.nasceuNoPlugin,
  CANAL.crmProprio,
  CANAL.utmQuebrada,
]);

/**
 * Lança `ClickHouseNaoConfigurado` (env faltando) ou `ClickHouseError` (rede,
 * SQL, permissão). Nunca devolve objeto de erro: quem chama decide se o bloco
 * some ou se a rota responde 503.
 */
export async function carregarOrigem(janelaDias?: number): Promise<PainelDeOrigem> {
  /* O `?janela=` é querystring pública. Sem o clamp, `?janela=1000` esvazia a
     coorte madura e o bloco some SEM ERRO — o pior modo de falha que existe. */
  const janela = Math.min(30, Math.max(1, Math.floor(janelaDias || JANELA_PADRAO)));

  const linhas = await chQuery<LinhaCrua>(sql(janela));

  const porCanal = new Map<string, LinhaDeOrigem>();
  const porPeca = new Map<string, LinhaDePeca>();
  const porPorta = new Map<string, LinhaDePorta>();

  for (const linha of linhas) {
    const canal = linha.canal || CANAL.semRastro;

    const alvo = porCanal.get(canal) ?? vazia(canal);
    alvo.contas += n(linha.contas);
    alvo.assinantes += n(linha.assinantes);
    alvo.receitaCents += n(linha.receita_cents);
    alvo.contasTodas += n(linha.contas_todas);
    alvo.assinantesTodas += n(linha.assinantes_todas);
    somar(n(linha.no_plugin) === 1 ? alvo.plugin : alvo.web, linha);
    porCanal.set(canal, alvo);

    /* Peça só existe onde houve campanha. Um cadastro orgânico não tem
       criativo, e inventar uma linha vazia para ele diria o oposto. */
    if (linha.campanha || linha.criativo) {
      const chave = `${canal} ${linha.campanha} ${linha.criativo} ${linha.posicao}`;
      const p = porPeca.get(chave) ?? {
        canal,
        campanha: linha.campanha,
        criativo: linha.criativo,
        posicao: linha.posicao,
        contas: 0,
        assinantes: 0,
        receitaCents: 0,
        contasTodas: 0,
      };
      p.contas += n(linha.contas);
      p.assinantes += n(linha.assinantes);
      p.receitaCents += n(linha.receita_cents);
      p.contasTodas += n(linha.contas_todas);
      porPeca.set(chave, p);
    }

    /* Porta só faz sentido para quem deixou rastro. Sem o filtro, "não
       informado" viraria o maior balde e diria apenas o que "Sem rastro" já diz. */
    if (canal !== CANAL.semRastro && linha.host) {
      const chave = `${linha.host} ${linha.rota} ${linha.dispositivo}`;
      const porta = porPorta.get(chave) ?? {
        host: linha.host,
        rota: linha.rota,
        dispositivo: linha.dispositivo,
        contas: 0,
        assinantes: 0,
        receitaCents: 0,
        contasTodas: 0,
      };
      porta.contas += n(linha.contas);
      porta.assinantes += n(linha.assinantes);
      porta.receitaCents += n(linha.receita_cents);
      porta.contasTodas += n(linha.contas_todas);
      porPorta.set(chave, porta);
    }
  }

  const todos = [...porCanal.values()];
  const canais = todos.filter((c) => !BALDES_FORA.has(c.canal)).sort(ordemDoRanking);
  const foraDoRanking = todos
    .filter((c) => BALDES_FORA.has(c.canal))
    .sort((a, b) => b.contasTodas - a.contasTodas);

  const totais = todos.reduce(
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
    Math.max(
      Date.parse(`${PISO_DA_SERIE.replace(" ", "T")}Z`),
      agora.getTime() - COORTE_DIAS * 86400000,
    ),
  );
  const ate = new Date(agora.getTime() - janela * 86400000);

  return {
    janelaDias: janela,
    coorteDe: soData(de),
    coorteAte: soData(ate),
    canais,
    foraDoRanking,
    /* Ordenado por volume, e não por taxa: a maioria das peças fica abaixo do
       piso, e ranquear por taxa poria a de 3 contas no topo.

       E por volume TOTAL, não pelo maduro: uma peça que estreou esta semana tem
       zero contas maduras por construção, e ordenar pelo maduro a jogaria para
       o fim da lista exatamente enquanto ela é a novidade que alguém quer ver. */
    pecas: [...porPeca.values()].sort((a, b) => b.contasTodas - a.contasTodas),
    portas: [...porPorta.values()].sort((a, b) => b.contasTodas - a.contasTodas),
    totais,
    geradoEm: agora.toISOString(),
  };
}

/* ------------------------------------------------- o que a pessoa declarou -- */

/**
 * O interesse que a pessoa escreveu no cadastro, cruzado com o canal.
 *
 * É o único sinal que ATRAVESSA o plugin: quem nasce dentro do SketchUp não
 * tem `gclid` nem referrer recuperável, mas respondeu "o que te trouxe aqui".
 * Não substitui atribuição — é declaração, com todo o viés que isso carrega —
 * e por isso vive num bloco à parte, nunca somado ao ranking.
 *
 * ⚠️ Cobertura parcial e enviesada: `signup_finish` sai só na porta do
 * SignupModal, e cobre pouco mais da metade das contas. A tela declara a
 * cobertura junto do número, porque um recorte de 50% sem aviso convida a
 * conclusão errada.
 */
export async function carregarInteresse(): Promise<LinhaDeInteresse[]> {
  const CLASSIFICACAO = classificacaoSql({
    url: "p.url0",
    ref: "p.ref0",
    semToque: "p.tem_toque = 0",
  });

  const linhas = await chQuery<{
    canal: string;
    interesse: string;
    metodo: string;
    contas: string | number;
  }>(`
WITH
${IDENT},
  novos_uid AS (SELECT uid FROM ident),
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
  ),
  /* argMax e não any: quem reabre o cadastro emite o evento mais de uma vez, e
     a última resposta é a que a pessoa deixou valendo. */
  declarado AS (
    SELECT user_id AS uid,
           argMax(JSONExtractString(properties,'what_brought'), timestamp) AS interesse,
           argMax(JSONExtractString(properties,'method'), timestamp)       AS metodo
      FROM collection.events_distributed
     WHERE event_date >= today() - ${EVENTOS_DIAS}
       AND event_name IN ('signup_finish','signup_completed')
       AND user_id GLOBAL IN (SELECT uid FROM novos_uid)
     GROUP BY user_id
  )
SELECT ${CLASSIFICACAO} AS canal,
       if(d.interesse = '', '(não respondeu)', d.interesse) AS interesse,
       if(d.metodo = '', '(não informado)', d.metodo)       AS metodo,
       count() AS contas
  FROM ident AS n
  LEFT JOIN (
    SELECT a.uid                AS uid,
           argMin(t.url0, t.t0) AS url0,
           argMin(t.ref0, t.t0) AS ref0,
           toUInt8(1)           AS tem_toque
      FROM anons AS a
     INNER JOIN (
       SELECT anonymous_id                          AS anon,
              toString(argMin(page_url, timestamp)) AS url0,
              toString(argMin(referrer, timestamp)) AS ref0,
              toDateTime(min(timestamp))            AS t0
         FROM collection.events_distributed
        WHERE event_date >= today() - ${EVENTOS_DIAS}
          AND anonymous_id GLOBAL IN (SELECT anon FROM anons)
        GROUP BY anonymous_id
     ) AS t ON t.anon = a.anon
     GROUP BY a.uid
  ) AS p ON p.uid = n.uid
  LEFT JOIN declarado AS d ON d.uid = n.uid
 GROUP BY canal, interesse, metodo
HAVING contas > 0`);

  return linhas
    .map((l) => ({
      canal: l.canal || CANAL.semRastro,
      interesse: l.interesse,
      metodo: l.metodo,
      contas: n(l.contas),
    }))
    .sort((a, b) => b.contas - a.contas);
}

/** Reexportado para a tela não precisar conhecer `canais.ts`. */
export { PISO_DO_CANAL, canalConfiavel };
