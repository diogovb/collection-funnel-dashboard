/**
 * Estatística do painel de experimentos. Sem dependência: são poucas fórmulas,
 * e cada uma existe por um motivo específico do problema.
 *
 * O contexto que manda no desenho: o volume é BAIXO (~237 pessoas por braço por
 * semana) e a métrica de decisão é receita por exposto — zero-inflada, ~88% de
 * zeros e cauda em R$ 697. Isso proíbe as duas saídas fáceis: normal simples e
 * intervalo de 95% fixo olhado todo dia.
 */

/** Distribuição de receita por pessoa, como o banco devolve. */
export type Histogram = { cents: number; users: number }[];

const Z95 = 1.959964;

/* ------------------------------------------------------- conversão ------- */

/**
 * Intervalo de Wilson para uma proporção. Melhor que o normal simples justamente
 * onde estamos: n pequeno e p longe de 0,5. Nunca sai do [0,1].
 */
export function wilson(
  successes: number,
  n: number,
  z = Z95,
): { p: number; low: number; high: number } {
  if (n <= 0) return { p: 0, low: 0, high: 0 };
  const p = successes / n;
  const d = 1 + (z * z) / n;
  const centro = (p + (z * z) / (2 * n)) / d;
  const raio =
    (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return {
    p,
    low: Math.max(0, centro - raio),
    high: Math.min(1, centro + raio),
  };
}

/* ------------------------------------------------------------ ARPEU ------ */

export type ArmStats = {
  n: number;
  mean: number;
  /** Desvio-padrão amostral. */
  sd: number;
  /** Erro-padrão da média. */
  se: number;
};

/** Média e dispersão a partir do histograma (equivale a ter as linhas). */
export function statsFromHistogram(hist: Histogram, n: number): ArmStats {
  if (n <= 0) return { n: 0, mean: 0, sd: 0, se: 0 };
  let soma = 0;
  let somaQuad = 0;
  let contados = 0;
  for (const b of hist) {
    soma += b.cents * b.users;
    somaQuad += b.cents * b.cents * b.users;
    contados += b.users;
  }
  /* Quem não aparece no histograma é quem gastou zero — soma e soma de
     quadrados não mudam, mas o n sim. */
  const total = Math.max(n, contados);
  const mean = soma / total;
  const varianca =
    total > 1 ? (somaQuad - total * mean * mean) / (total - 1) : 0;
  const sd = Math.sqrt(Math.max(0, varianca));
  return { n: total, mean, sd, se: sd / Math.sqrt(total) };
}

/** Amostra uma média de `n` sorteios do histograma (bootstrap de uma réplica). */
function bootstrapMean(
  cdf: { cents: number; acum: number }[],
  total: number,
  n: number,
  rnd: () => number,
): number {
  let soma = 0;
  for (let i = 0; i < n; i += 1) {
    const alvo = rnd() * total;
    let lo = 0;
    let hi = cdf.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid].acum < alvo) lo = mid + 1;
      else hi = mid;
    }
    soma += cdf[lo].cents;
  }
  return soma / n;
}

function buildCdf(hist: Histogram, n: number) {
  const contados = hist.reduce((s, b) => s + b.users, 0);
  const zeros = Math.max(0, n - contados);
  const buckets = zeros > 0 ? [{ cents: 0, users: zeros }, ...hist] : [...hist];
  const cdf: { cents: number; acum: number }[] = [];
  let acum = 0;
  for (const b of buckets) {
    acum += b.users;
    cdf.push({ cents: b.cents, acum });
  }
  return { cdf, total: acum };
}

/** Gerador determinístico (mulberry32): o mesmo dado dá o mesmo intervalo —
 *  um número que dança sozinho a cada refresh destrói a confiança na tela. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Intervalo da RAZÃO de ARPEU (variante ÷ controle) por bootstrap.
 *
 * Bootstrap e não fórmula: com ~88% de zeros e uma cauda em R$ 697, a média não
 * é nem de longe normal nesse tamanho de amostra, e o intervalo analítico sai
 * otimista — diria "decidido" antes da hora.
 */
export function bootstrapRatio(
  variante: { hist: Histogram; n: number },
  controle: { hist: Histogram; n: number },
  replicas = 4000,
): { ratio: number; low: number; high: number } | null {
  if (variante.n < 10 || controle.n < 10) return null;
  const v = buildCdf(variante.hist, variante.n);
  const c = buildCdf(controle.hist, controle.n);
  const mediaV = statsFromHistogram(variante.hist, variante.n).mean;
  const mediaC = statsFromHistogram(controle.hist, controle.n).mean;
  if (mediaC <= 0) return null;

  const rnd = seeded(variante.n * 7919 + controle.n * 104729);
  const razoes: number[] = [];
  for (let i = 0; i < replicas; i += 1) {
    const mv = bootstrapMean(v.cdf, v.total, variante.n, rnd);
    const mc = bootstrapMean(c.cdf, c.total, controle.n, rnd);
    if (mc > 0) razoes.push(mv / mc);
  }
  if (razoes.length < replicas * 0.5) return null;
  razoes.sort((a, b) => a - b);
  const pct = (q: number) => razoes[Math.floor(q * (razoes.length - 1))];
  return { ratio: mediaV / mediaC, low: pct(0.025), high: pct(0.975) };
}

/**
 * Raio de uma SEQUÊNCIA de confiança (anytime-valid) para a média.
 *
 * Por que não o intervalo de 95% de sempre: este painel vai ser aberto todo
 * dia. Um intervalo fixo espiado repetidamente cruza a fronteira por acaso
 * muito mais que 5% das vezes — é assim que times "descobrem" vencedores que
 * não existem. A sequência de confiança vale em QUALQUER instante de parada, e
 * é o preço honesto por poder olhar quando quiser.
 *
 * (Howard et al., 2021 — forma normal-mistura.)
 */
export function confidenceSequenceRadius(
  sd: number,
  n: number,
  alpha = 0.05,
  rho = 1,
): number {
  if (n <= 1 || sd <= 0) return Infinity;
  const t = n * rho * rho + 1;
  return (
    sd * Math.sqrt(((2 * t) / (n * n * rho * rho)) * Math.log(Math.sqrt(t) / alpha))
  );
}

/* ----------------------------------------------------------- amostra ----- */

/**
 * Quantas pessoas por braço para enxergar uma diferença de `mde` (em unidades
 * da métrica), com 80% de poder e 5% de significância.
 */
export function sampleSizePerArm(sd: number, mde: number): number {
  if (mde <= 0 || sd <= 0) return Infinity;
  return Math.ceil((16 * sd * sd) / (mde * mde));
}

/** A menor diferença que o n de HOJE consegue distinguir. O número mais
 *  honesto da tela no começo do teste. */
export function detectableDifference(sd: number, n: number): number {
  if (n <= 0 || sd <= 0) return Infinity;
  return 4 * sd * Math.sqrt(1 / n);
}

/* --------------------------------------------------------------- SRM ----- */

/**
 * Sample Ratio Mismatch: o split observado bate com o esperado?
 *
 * Se não bate, a comparação inteira é lixo — alguém está sendo excluído de um
 * lado por um motivo que também afeta a chance de comprar. Por isso ele
 * invalida a tela em vez de virar mais um número.
 */
export function srmPValue(
  observado: number[],
  esperadoPct: number[],
): { chi2: number; suspeito: boolean } {
  const total = observado.reduce((s, o) => s + o, 0);
  if (total < 30) return { chi2: 0, suspeito: false };
  let chi2 = 0;
  observado.forEach((o, i) => {
    const e = (total * esperadoPct[i]) / 100;
    if (e > 0) chi2 += ((o - e) * (o - e)) / e;
  });
  /* 1 grau de liberdade: 6,63 ≈ p 0,01. Abaixo disso, silêncio — alarme falso
     de SRM faz o time ignorar o alarme de verdade. */
  return { chi2, suspeito: chi2 > 6.63 };
}

/* ------------------------------------------------------------ formato ---- */

export const brl = (cents: number): string =>
  (cents / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  });

export const pct = (v: number, casas = 1): string =>
  `${(v * 100).toFixed(casas)}%`;
