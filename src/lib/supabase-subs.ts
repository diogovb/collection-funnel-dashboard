import "server-only";
import { createClient } from "@supabase/supabase-js";

/**
 * Cliente do Supabase de ASSINATURAS — outro projeto do que o resto deste
 * dashboard usa. O `supabase.ts` daqui aponta para o banco do FUNIL de
 * cadastro; faturas, assinaturas e os experimentos vivem em outro lugar.
 *
 * `server-only` no topo: um import acidental deste módulo por um componente de
 * cliente vira erro de BUILD, não vazamento de service-role no bundle.
 *
 * E sem fallback embutido, de propósito. Os outros dois clientes deste repo
 * carregam URL e chave no próprio fonte — se a env faltar aqui, isto explode
 * na cara de quem fez o deploy em vez de funcionar com credencial commitada.
 */
function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `[supabase-subs] Falta a variável de ambiente ${name}. ` +
        `Cadastre-a na Vercel — este módulo não tem fallback no código.`,
    );
  }
  return value;
}

export function getSubsClient() {
  return createClient(
    requiredEnv("SUBS_SUPABASE_URL"),
    requiredEnv("SUBS_SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } },
  );
}

/* ---------------------------------------------------------------- tipos --- */

export type ExperimentArm = {
  arm: string;
  exposed: number;
  /** Expostos há mais tempo que a janela de atribuição — a base das TAXAS. */
  mature: number;
  /** Compradores MADUROS. Base da taxa, do bootstrap e do veredito. */
  buyers: number;
  revenue_cents: number;
  sum_sq_cents: number;
  /**
   * Compradores entre TODOS os expostos — o que já aconteceu, sem esperar a
   * janela de atribuição fechar. É o que a tela mostra no dia a dia: nas duas
   * primeiras semanas os campos maduros são zero por construção, e zero na
   * tela é indistinguível de "não está medindo".
   */
  buyers_all: number;
  revenue_all_cents: number;
  /** Tentativa de compra que não virou receita, por status. */
  discarded: { status: string; attempts: number; cents: number }[];
  /**
   * À vista (1×) × parcelado (2×+).
   *
   * Nasce com o anual de dois preços: 1× paga o à vista e 12× paga a tabela, e
   * a diferença é de R$ 120 por venda. Sem esta quebra, "converteu X%" não diz
   * quanta receita entrou.
   */
  by_installments: { faixa: string; buyers: number; revenue_cents: number }[];
  /** Receita por pessoa, agrupada. Permite bootstrap exato sem baixar linhas. */
  value_histogram: { cents: number; users: number }[];
  by_period: {
    slug: string;
    duration_months: number | null;
    price_full_cents: number;
    buyers: number;
    revenue_cents: number;
  }[];
  by_method: { method: string; buyers: number; revenue_cents: number }[];
};

export type ExperimentReport = {
  error?: string;
  experiment: {
    key: string;
    label: string;
    control_audience: string;
    variant_audience: string;
    split_pct: number;
    is_active: boolean;
    started_at: string | null;
    config: { attrib_days?: number; min_weeks?: number; mde_pct?: number };
    attrib_days: number;
  };
  arms: ExperimentArm[];
  daily: {
    day: string;
    arm: string;
    exposed: number;
    buyers: number;
    revenue_cents: number;
  }[];
  retention: {
    arm: string;
    offset_month: number;
    cohort: number;
    retained: number;
  }[];
  health: {
    total_exposed: number;
    last_exposure_at: string | null;
    first_exposure_at: string | null;
    exposed_with_access: number;
    unknown_arms: number;
    /**
     * Compra paga depois do início do teste, de quem NUNCA foi exposto. Não é
     * erro — sem exposição não há braço, então a pessoa fica fora do numerador
     * e do denominador. É o número que explica a diferença entre este painel e
     * o extrato do gateway.
     */
    purchases_outside_experiment: number;
  };
  generated_at: string;
};

/** Os períodos de cada braço, para a régua de break-even sair do BANCO e não
 *  de constante no código — um experimento futuro funciona sem tocar aqui. */
export type CatalogPeriod = {
  slug: string;
  audience: string;
  plan_id: string;
  duration_months: number | null;
  price_full_cents: number;
  /**
   * Preço FINAL à vista (Pix ou cartão 1×). `null` = o período tem um preço só.
   * Quando existe, `price_full_cents` passa a ser o preço de TABELA/parcelado,
   * e a régua de break-even vira uma FAIXA em vez de um número.
   */
  price_cash_cents: number | null;
};

/**
 * Os períodos comparáveis dos dois braços.
 *
 * ⚠️ Restrito ao PLANO da variante. Sem isso o "anual do controle" caía no
 * `gratis` do Studio (R$ 0, 12 meses, público) e a régua de break-even saía
 * como "R$ 0 → R$ 468" — bug visto na tela renderizada, não no tipo.
 */
export async function fetchExperimentCatalog(
  audiences: string[],
  variantAudience: string,
): Promise<CatalogPeriod[]> {
  const { data, error } = await getSubsClient()
    .from("billing_periods")
    .select(
      "slug, audience, plan_id, duration_months, price_full_cents, price_cash_cents",
    )
    .in("audience", audiences)
    /* SEM filtro de `is_active`: as linhas da variante nascem desligadas de
       propósito, e a régua de break-even precisa existir ANTES do flip — é
       ela que mostra o que o teste vai ter que provar. */
    .eq("visible_for_purchase", true)
    /* Ordenação EXPLÍCITA: quem consome faz `.find()` por duração, e sem
       `order` o Postgres não promete ordem nenhuma. Hoje há uma linha por
       duração e por braço, então não muda nada — mas no dia em que houver
       duas, a régua mudaria de valor entre dois refreshes, sem erro nenhum.
       Uma linha apaga a categoria inteira do bug. */
    .order("display_order", { ascending: true })
    .order("slug", { ascending: true });
  if (error) return [];
  const todos = (data ?? []) as CatalogPeriod[];
  const planosDaVariante = new Set(
    todos.filter((p) => p.audience === variantAudience).map((p) => p.plan_id),
  );
  if (!planosDaVariante.size) return todos;
  return todos.filter((p) => planosDaVariante.has(p.plan_id));
}

/** Uma chamada, uma query, tudo agregado no banco. */
export async function fetchExperimentReport(
  experimentKey: string,
  attribDays = 14,
): Promise<ExperimentReport> {
  const { data, error } = await getSubsClient().rpc("admin_experiment_report", {
    p_experiment_key: experimentKey,
    p_attrib_days: attribDays,
  });
  if (error) throw new Error(`admin_experiment_report: ${error.message}`);
  return data as ExperimentReport;
}

/* ------------------------------------------------------------------ funil -- */

/** Os degraus do checkout, na ordem. O 1º não é gravado: é a própria exposição. */
export const FUNNEL_STEPS = [
  "viu_preco",
  "abriu_checkout",
  "escolheu_metodo",
  "comecou_pagamento",
  "clicou_pagar",
  "pagou",
] as const;

export type FunnelStep = (typeof FUNNEL_STEPS)[number];

export const FUNNEL_LABELS: Record<FunnelStep, string> = {
  viu_preco: "Viu o preço",
  abriu_checkout: "Abriu o checkout",
  escolheu_metodo: "Escolheu como pagar",
  comecou_pagamento: "Começou a pagar",
  clicou_pagar: "Mandou cobrar",
  pagou: "Pagou",
};

export type ExperimentFunnel = {
  experiment_key: string;
  started_at: string | null;
  is_active: boolean;
  exposed: Record<string, number>;
  steps: { arm: string; step: string; users: number }[];
  by_method: { arm: string; step: string; method: string; users: number }[];
  last_step: { arm: string; step: string; users: number }[];
  error?: string;
};

/**
 * Onde as pessoas param entre ver o preço e pagar, por braço.
 *
 * Mesma base do relatório (só depois do `started_at`, sem conta interna) —
 * garantido no SQL, porque duas bases diferentes dariam dois denominadores e
 * ninguém perceberia.
 */
export async function fetchExperimentFunnel(
  experimentKey: string,
): Promise<ExperimentFunnel> {
  const { data, error } = await getSubsClient().rpc("admin_experiment_funnel", {
    p_experiment_key: experimentKey,
  });
  if (error) throw new Error(`admin_experiment_funnel: ${error.message}`);
  return data as ExperimentFunnel;
}

/* --------------------------------------------------------------- coortes -- */

/**
 * Os eixos, e o que cada um responde.
 *
 * São INDEPENDENTES: a mesma pessoa aparece uma vez em cada. Alguém pode ser
 * conta de dois anos que nunca assinou. Empilhar os dois numa lista só faria a
 * mesma pessoa ser contada duas vezes.
 */
export const COHORT_AXES = ["historico", "idade_conta"] as const;
export type CohortAxis = (typeof COHORT_AXES)[number];

export const COHORT_AXIS_LABELS: Record<CohortAxis, string> = {
  historico: "Já tinha assinado?",
  idade_conta: "Há quanto tempo tem conta",
};

export type ExperimentCohorts = {
  experiment_key: string;
  started_at: string | null;
  is_active: boolean;
  attrib_days: number;
  cohorts: {
    axis: string;
    ord: number;
    bucket: string;
    arm: string;
    exposed: number;
    mature: number;
    buyers: number;
    revenue_cents: number;
    /**
     * A quebra por produto — só os COMPRADORES se dividem.
     *
     * Quem foi exposto ainda não escolheu período, então `exposed` não tem
     * anual nem mensal: inventar essa divisão daria uma taxa por produto com
     * denominador imaginário.
     *
     * `buyers_outro` é assinatura cuja fatura não aponta para um período.
     * Existe para a soma FECHAR: sem ele, anual + mensal não bateria com
     * `buyers` e a divergência passaria batida.
     *
     * ⚠️ Compra de CRÉDITO de IA não entra em nada disto — nem aqui, nem no
     * placar. Ela contava como conversão do teste de preço até 14/08 e inflava
     * os dois braços de forma assimétrica; a RPC agora filtra por
     * `credit_package_id IS NULL` nos cinco pontos que leem fatura.
     */
    buyers_anual?: number;
    buyers_mensal?: number;
    buyers_outro?: number;
  }[];
  generated_at?: string;
  error?: string;
};

/**
 * Quem comprou em cada braço, por coorte.
 *
 * O placar diz QUANTO cada braço vendeu; isto diz PARA QUEM. Cada linha traz
 * `exposed` e `buyers` juntos de propósito: a leitura que responde à pergunta é
 * a conversão DENTRO da coorte, não a fatia que a coorte ocupa entre os
 * compradores — essa se move sozinha quando um braço vende mais.
 *
 * Mesma base do relatório e do funil (só depois do `started_at`, sem conta
 * interna), garantida no SQL.
 */
export async function fetchExperimentCohorts(
  experimentKey: string,
  attribDays = 14,
): Promise<ExperimentCohorts> {
  const { data, error } = await getSubsClient().rpc(
    "admin_experiment_cohorts",
    { p_experiment_key: experimentKey, p_attrib_days: attribDays },
  );
  if (error) throw new Error(`admin_experiment_cohorts: ${error.message}`);
  return data as ExperimentCohorts;
}
