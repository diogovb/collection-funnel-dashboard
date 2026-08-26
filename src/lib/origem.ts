/**
 * De onde veio a pessoa — a classificação canônica, em UM lugar.
 *
 * Antes deste arquivo o painel tinha TRÊS classificações que não se falavam:
 * `formatOrigin` na home (lê o funil do Supabase), o `multiIf` do `canais.ts`
 * (lê `page_url` do ClickHouse) e o `multiIf` da ponte por IP. Elas discordavam
 * no nome e no conceito — o caso mais grave era a palavra "Site", que na home
 * significava *não sei nada* e no `/experimentos` significava *veio de um
 * referrer nomeado*. Dois opostos com o mesmo rótulo.
 *
 * Aqui os NOMES são únicos e a ORDEM é única. O que continua duplicado é a
 * implementação, e de propósito: a home recebe campos soltos (o funil não
 * guarda URL) e o ClickHouse recebe a URL inteira. São dois motores lendo a
 * mesma partitura — `classificacaoSql()` e `normalizarCanal()`.
 *
 * Regra que atravessa o arquivo: **ausência com endereço é informação; ausência
 * sem endereço não é.** "Site" não dizia nada. "Direto — biblioteca" diz onde a
 * pessoa apareceu, que é o começo de uma decisão.
 */

/* ---------------------------------------------------------------- nomes --- */

export const CANAL = {
  googleAds: "Google Ads",
  googleOrganico: "Google orgânico",
  metaAds: "Meta Ads",
  metaOrganico: "Meta orgânico",
  pinterestAds: "Pinterest Ads",
  pinterestOrganico: "Pinterest orgânico",
  blog: "Blog",
  outraCampanha: "Outra campanha",
  /** Nossos próprios disparos de WhatsApp/e-mail. Reativação, não aquisição. */
  crmProprio: "CRM próprio",
  /** Superfície, não origem — ver a nota longa em `canais.ts`. */
  nasceuNoPlugin: "Nasceu dentro do plugin",
  semRastro: "Sem rastro",
  /** UTM que chegou quebrada. Não é canal: é bug de link, e some se for engolida. */
  utmQuebrada: "UTM quebrada",
} as const;

/**
 * Os baldes que NÃO disputam o ranking, e o motivo de cada um.
 *
 * A tela mostra os quatro — sumir seria pior — mas fora da comparação: dois
 * têm denominador de natureza diferente, um é tráfego que já era nosso e o
 * último é defeito de link.
 */
export const FORA_DO_RANKING: Record<string, string> = {
  [CANAL.semRastro]:
    "Conta sem nenhum evento ligado. Não é um canal: é o que não conseguimos ver.",
  [CANAL.nasceuNoPlugin]:
    "Aterrissou no plugin, não veio dele. O clique aconteceu no navegador de fora, que é outro contexto — medido, menos de 4% têm toque pago recuperável.",
  [CANAL.crmProprio]:
    "Nossos próprios disparos de WhatsApp e e-mail. É reativação de quem já era nosso; somar com aquisição infla o canal e esconde o custo do pago.",
  [CANAL.utmQuebrada]:
    "Link com macro não substituída ou parâmetro malformado. Vira conserto, não leitura — e some se for tratado como campanha.",
};

/** O que o sinal permite afirmar. A tela não soma naturezas diferentes. */
export type Qualidade = "pago" | "organico" | "direto" | "interno" | "cego";

export function qualidadeDoSinal(canal: string): Qualidade {
  if (canal === CANAL.semRastro || canal === CANAL.utmQuebrada) return "cego";
  if (canal === CANAL.nasceuNoPlugin || canal === CANAL.crmProprio) return "interno";
  if (canal.endsWith(" Ads") || canal === CANAL.outraCampanha) return "pago";
  if (canal.startsWith("Direto")) return "direto";
  return "organico";
}

/* ------------------------------------------------------- taxonomia suja --- */

/**
 * As quatro grafias do mesmo canal.
 *
 * Medido em 30 dias: `ig` (8.653 pessoas), `fb` (4.917), `Meta` (225) e `meta`
 * (2) são todos Meta. Colapsar aqui é defensivo — o conserto de verdade é no
 * painel de anúncios. Enquanto não acontece, quatro grafias não podem parecer
 * quatro canais.
 */
const FONTES_META = ["fb", "ig", "meta", "facebook", "instagram"] as const;
const FONTES_PINTEREST = ["pinterest"] as const;

const META = new Set<string>(FONTES_META);
const PINTEREST = new Set<string>(FONTES_PINTEREST);

/**
 * A UTM chegou quebrada?
 *
 * Dois casos reais, os dois vistos em produção:
 * - `%7B%7Bsite_source_name%7D%7D` — macro do Meta que não foi substituída;
 * - `3Dcollection_trigger` — sobra de um `%3D` decodificado uma vez a menos,
 *   sintoma de link montado com escape a mais em algum disparo.
 *
 * Os dois são bug de link, não canal. Precisam aparecer nomeados para serem
 * consertados, e não diluídos em "Outra campanha".
 */
export function utmQuebrada(valor: string): boolean {
  if (!valor) return false;
  const v = valor.toLowerCase();
  return (
    v.includes("{{") ||
    v.includes("}}") ||
    v.includes("%7b") ||
    v.includes("%7d") ||
    v.startsWith("3d") ||
    v === "--sanitized--"
  );
}

/* ------------------------------------------------------ ausência com CEP --- */

/**
 * O rótulo de quem chegou sem UTM e sem referrer externo.
 *
 * O host é o que salva a linha de ser inútil: "Direto — landing page" e
 * "Direto — biblioteca" são populações com comportamento diferente (medido em
 * 30 dias: 7,7% contra 18,9% de vínculo com conta), e até hoje as duas viviam
 * dentro da mesma palavra.
 *
 * Sem host — o caso da home, porque o funil do Supabase não guarda URL —
 * devolve "Direto" seco. É menos do que gostaríamos e ainda assim mais honesto
 * que "Site", porque não finge saber de qual site se trata.
 */
export function rotularAusencia(host?: string): string {
  const h = (host || "").toLowerCase().replace(/^www\./, "");
  if (!h) return "Direto";
  if (h.startsWith("library.") || h.startsWith("library-beta.")) {
    return "Direto — biblioteca";
  }
  if (h.startsWith("blog.")) return "Direto — blog";
  if (h.startsWith("cadastro.")) return "Direto — página de cadastro";
  if (h.startsWith("app.")) return "Direto — app";
  if (h === "collection.com.br" || h === "collection.archi") {
    return "Direto — landing page";
  }
  return `Direto — ${h}`;
}

/* -------------------------------------------------- classificação (SQL) --- */

/**
 * O mesmo julgamento, em SQL, para rodar dentro do ClickHouse.
 *
 * Recebe as expressões porque quem chama tem aliases diferentes (`p.url0` na
 * query agregada, `d.url0` na ponte por IP) — e a divergência entre as telas
 * nasceu exatamente de cada uma reescrever o `multiIf` à mão.
 *
 * A ORDEM é a mesma da versão TypeScript, e três posições são decisão:
 * 1. UTM quebrada vem primeiro: `utm_source` corrompido não pode ser lido como
 *    campanha legítima só por ser não-vazio.
 * 2. "Google orgânico" antes de "Google Ads", porque `utm_source=google` com
 *    `utm_medium=organic` é orgânico marcado à mão, não anúncio.
 * 3. O teste do plugin antes de "Direto": o plugin abre sem referrer e sem
 *    utm, e se ficasse depois a superfície inteira sumiria dentro de "Direto".
 */
export function classificacaoSql(opts: {
  /** Expressão SQL da URL do primeiro toque. Ex.: `p.url0`. */
  url: string;
  /** Expressão SQL do referrer do primeiro toque. Ex.: `p.ref0`. */
  ref: string;
  /** Condição SQL de "não tem toque nenhum". Ex.: `p.tem_toque = 0`. */
  semToque?: string;
}): string {
  const { url, ref } = opts;
  const src = `lower(extractURLParameter(${url},'utm_source'))`;
  const med = `lower(extractURLParameter(${url},'utm_medium'))`;
  const dom = `lower(cutWWW(domain(${ref})))`;
  const host = `lower(cutWWW(domain(${url})))`;
  const lista = (fontes: readonly string[]) =>
    fontes.map((f) => `'${f}'`).join(",");

  return `
    multiIf(${opts.semToque ? `\n      ${opts.semToque}, '${CANAL.semRastro}',` : ""}
      ${src} != '' AND (
        position(${src},'{{') > 0 OR position(${src},'%7b') > 0
        OR startsWith(${src},'3d') OR ${src} = '--sanitized--'
      ), '${CANAL.utmQuebrada}',
      ${src} = 'google' AND ${med} IN ('organic','referral'), '${CANAL.googleOrganico}',
      extractURLParameter(${url},'gclid') != ''
        OR extractURLParameter(${url},'gbraid') != ''
        OR extractURLParameter(${url},'wbraid') != ''
        OR ${src} = 'google', '${CANAL.googleAds}',
      ${src} IN (${lista(FONTES_META)}), '${CANAL.metaAds}',
      ${src} IN (${lista(FONTES_PINTEREST)}), '${CANAL.pinterestAds}',
      ${src} = 'blog', '${CANAL.blog}',
      ${src} = 'collection_trigger', '${CANAL.crmProprio}',
      ${src} != '', '${CANAL.outraCampanha}',
      positionCaseInsensitive(${url},'sketchupId') > 0, '${CANAL.nasceuNoPlugin}',
      ${dom} LIKE 'google.%' OR ${dom} LIKE '%.google.%', '${CANAL.googleOrganico}',
      ${dom} LIKE '%instagram%' OR ${dom} LIKE '%facebook%', '${CANAL.metaOrganico}',
      ${dom} LIKE '%pinterest%', '${CANAL.pinterestOrganico}',
      ${dom} = '' OR endsWith(${dom},'collection.com.br')
        OR endsWith(${dom},'collection.archi'),
        multiIf(
          startsWith(${host},'library.') OR startsWith(${host},'library-beta.'),
            'Direto — biblioteca',
          startsWith(${host},'blog.'),     'Direto — blog',
          startsWith(${host},'cadastro.'), 'Direto — página de cadastro',
          startsWith(${host},'app.'),      'Direto — app',
          ${host} IN ('collection.com.br','collection.archi'), 'Direto — landing page',
          ${host} = '', 'Direto',
          concat('Direto — ', ${host})
        ),
      concat('Orgânico: ', ${dom})
    )`;
}

/* -------------------------------------------- classificação (TypeScript) -- */

/** Os sinais que a home tem em mãos. Nem todos existem em toda fonte. */
export type SinaisDeOrigem = {
  utmSource?: string;
  utmMedium?: string;
  gclid?: string;
  gbraid?: string;
  wbraid?: string;
  fbclid?: string;
  /** Referrer externo. O do próprio domínio já vem filtrado pelo front. */
  referrer?: string;
  /** `plugin_sketchup` | `plugin_revit` | `web`. */
  surface?: string;
  /** Host de entrada, quando a fonte tiver. O funil do Supabase não tem. */
  host?: string;
  /** Existe algum rastro desta conta? `false` vira "Sem rastro". */
  temRastro?: boolean;
};

/** Só o domínio, sem `www.` e sem protocolo. Aceita domínio cru ou URL. */
export function dominioDe(valor: string): string {
  if (!valor) return "";
  try {
    const comEsquema = /^https?:\/\//i.test(valor) ? valor : `https://${valor}`;
    return new URL(comEsquema).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return valor.toLowerCase().replace(/^www\./, "").split("/")[0];
  }
}

const ehNosso = (dom: string): boolean =>
  dom.endsWith("collection.com.br") || dom.endsWith("collection.archi");

/**
 * A mesma cascata de `classificacaoSql`, para quem lê campos soltos.
 *
 * Usada pela home, que recebe o metadata do `signup_completed` do funil. Não
 * tem `page_url`, então a régua de ausência opera sem host e o resultado é
 * "Direto" seco em vez de "Direto — biblioteca". A diferença está declarada na
 * tela; o que não pode acontecer é o NOME divergir, e não diverge.
 */
export function normalizarCanal(s: SinaisDeOrigem): string {
  if (s.temRastro === false) return CANAL.semRastro;

  const src = (s.utmSource || "").toLowerCase().trim();
  const med = (s.utmMedium || "").toLowerCase().trim();

  if (src && utmQuebrada(src)) return CANAL.utmQuebrada;

  if (src === "google" && (med === "organic" || med === "referral")) {
    return CANAL.googleOrganico;
  }
  if (s.gclid || s.gbraid || s.wbraid || src === "google") return CANAL.googleAds;
  if (META.has(src)) return CANAL.metaAds;
  if (PINTEREST.has(src)) return CANAL.pinterestAds;
  if (src === "blog") return CANAL.blog;
  if (src === "collection_trigger") return CANAL.crmProprio;
  if (src) return CANAL.outraCampanha;

  /* `fbclid` fica DEPOIS do utm_source de propósito: ele sobrevive a
     compartilhamento (alguém copia o link e manda no zap), então sozinho é
     sinal mais fraco que uma UTM declarada. */
  if (s.fbclid) return CANAL.metaAds;

  if (s.surface?.startsWith("plugin")) return CANAL.nasceuNoPlugin;

  const dom = dominioDe(s.referrer || "");
  if (dom && !ehNosso(dom)) {
    if (/(^|\.)google\./.test(dom)) return CANAL.googleOrganico;
    if (dom.includes("instagram") || dom.includes("facebook")) {
      return CANAL.metaOrganico;
    }
    if (dom.includes("pinterest")) return CANAL.pinterestOrganico;
    return `Orgânico: ${dom}`;
  }

  return rotularAusencia(s.host);
}
