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
  buyers: number;
  revenue_cents: number;
  sum_sq_cents: number;
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
    .select("slug, audience, plan_id, duration_months, price_full_cents")
    .in("audience", audiences)
    /* SEM filtro de `is_active`: as linhas da variante nascem desligadas de
       propósito, e a régua de break-even precisa existir ANTES do flip — é
       ela que mostra o que o teste vai ter que provar. */
    .eq("visible_for_purchase", true);
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
