import "server-only";
import { getSubsClient } from "@/lib/supabase-subs";

/**
 * Os dados da tela de retenção.
 *
 * Esta tela nasceu de um número que ninguém estava olhando: em 12/08/2026 a
 * base perdeu **196 assinaturas em 30 dias contra ~90 novas**, e a maior parte
 * não foi decisão do cliente — foi cartão recusado que nunca se recuperou. O
 * dashboard media aquisição em três telas e churn em nenhuma.
 *
 * ⚠️ A régua é a FATURA, nunca `subscriptions.dunning_state`. O estado do
 * dunning só é escrito quando o webhook do gateway chega, e quem não tem
 * assinatura viva lá nunca gera webhook — havia 12 assinaturas com fatura
 * recusada e `dunning_state` ainda em `'none'`, entre elas as de maior ticket.
 */

/** O PostgREST corta em 1.000 linhas e não avisa. */
const PAGINA = 1000;

async function todasAsPaginas<T>(
  monta: (de: number, ate: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const todas: T[] = [];
  for (let inicio = 0; ; inicio += PAGINA) {
    const { data, error } = await monta(inicio, inicio + PAGINA - 1);
    if (error) throw new Error(error.message);
    const pagina = data ?? [];
    todas.push(...pagina);
    if (pagina.length < PAGINA) return todas;
    /* Trava: filtro errado não pode virar laço infinito no build. */
    if (inicio > 50_000) return todas;
  }
}

type FaturaCrua = {
  user_id: string;
  created_at: string;
  status: string;
  amount: number | null;
  payment_gateway: string | null;
  failure_reason: string | null;
};

type AssinaturaCrua = {
  user_id: string;
  status: string | null;
  dunning_state: string | null;
  amount_cents: number | null;
  plan_name: string | null;
  current_period_end: string | null;
  grace_period_ends_at: string | null;
  stripe_subscription_id: string | null;
  pagarme_subscription_id: string | null;
};

/**
 * O que fazer com cada pessoa — e a diferença entre um pedido que resolve e um
 * que não resolve. Com assinatura viva no gateway basta trocar o cartão e a
 * régua do próprio gateway recobra; sem ela, ninguém vai cobrar de novo.
 */
export type CaminhoDeResgate = "atualizar_cartao" | "refazer_cobranca" | "recomprar";

export type PessoaEmRisco = {
  userId: string;
  valorCentavos: number;
  plano: string;
  ultimaFalha: string;
  tentativas: number;
  caminho: CaminhoDeResgate;
  /** Ainda dentro do período pago: dá para resolver antes de o cliente sentir. */
  temAcesso: boolean;
  diasAteVencer: number | null;
  dunning: string;
  gateway: string;
};

export type PainelRetencao = {
  emRisco: PessoaEmRisco[];
  /** Falhas e recuperações por dia — a curva que diz se a régua está pegando. */
  serie: { dia: string; falharam: number; recuperaram: number }[];
  vencemEm7: number;
  vencemEm30: number;
  perderamAcesso30d: number;
  geradoEm: string;
};

const DIA = 24 * 60 * 60 * 1000;

export async function carregarRetencao(diasDeJanela = 30): Promise<PainelRetencao> {
  const supabase = getSubsClient();
  const agora = Date.now();
  const desde = new Date(agora - diasDeJanela * DIA).toISOString();

  /* Pacote de crédito não é assinatura: uma recusa ali não é churn. */
  const faturas = await todasAsPaginas<FaturaCrua>((de, ate) =>
    supabase
      .from("subscription_invoices")
      .select("user_id, created_at, status, amount, payment_gateway, failure_reason")
      .in("status", ["failed", "paid"])
      .is("credit_package_id", null)
      .gte("created_at", desde)
      .order("created_at", { ascending: true })
      .range(de, ate),
  );

  const falhasPorPessoa = new Map<string, { ultima: string; tentativas: number; gateway: string }>();
  const ultimoPagamento = new Map<string, string>();
  const porDia = new Map<string, { falharam: Set<string>; recuperaram: Set<string> }>();

  for (const fatura of faturas) {
    const dia = fatura.created_at.slice(0, 10);
    if (!porDia.has(dia)) porDia.set(dia, { falharam: new Set(), recuperaram: new Set() });

    if (fatura.status === "failed") {
      porDia.get(dia)!.falharam.add(fatura.user_id);
      const atual = falhasPorPessoa.get(fatura.user_id);
      falhasPorPessoa.set(fatura.user_id, {
        /* A ordem é crescente, então a última vista é a mais recente. */
        ultima: fatura.created_at,
        tentativas: (atual?.tentativas ?? 0) + 1,
        gateway: fatura.payment_gateway ?? "",
      });
    } else {
      ultimoPagamento.set(fatura.user_id, fatura.created_at);
      /* Só conta como recuperação quem tinha falhado ANTES neste mesmo dia ou
         antes — pagamento de quem nunca falhou é assinatura nova, não resgate. */
      if (falhasPorPessoa.has(fatura.user_id)) porDia.get(dia)!.recuperaram.add(fatura.user_id);
    }
  }

  /* Quem pagou DEPOIS da última recusa resolveu sozinho e sai da lista. */
  const emAberto = [...falhasPorPessoa.entries()].filter(([userId, falha]) => {
    const pagou = ultimoPagamento.get(userId);
    return !pagou || pagou <= falha.ultima;
  });

  const assinaturas = new Map<string, AssinaturaCrua>();
  const ids = emAberto.map(([userId]) => userId);
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await supabase
      .from("subscriptions")
      .select(
        "user_id, status, dunning_state, amount_cents, plan_name, current_period_end, grace_period_ends_at, stripe_subscription_id, pagarme_subscription_id",
      )
      .in("user_id", ids.slice(i, i + 100));
    if (error) throw new Error(error.message);
    for (const linha of (data ?? []) as AssinaturaCrua[]) assinaturas.set(linha.user_id, linha);
  }

  const emRisco: PessoaEmRisco[] = [];
  for (const [userId, falha] of emAberto) {
    const assinatura = assinaturas.get(userId);
    if (!assinatura) continue;

    const fim = assinatura.current_period_end ? Date.parse(assinatura.current_period_end) : 0;
    const temAcesso = fim > agora;

    emRisco.push({
      userId,
      valorCentavos: assinatura.amount_cents ?? 0,
      plano: assinatura.plan_name ?? "",
      ultimaFalha: falha.ultima,
      tentativas: falha.tentativas,
      caminho: assinatura.stripe_subscription_id
        ? "atualizar_cartao"
        : assinatura.pagarme_subscription_id
          ? "refazer_cobranca"
          : "recomprar",
      temAcesso,
      diasAteVencer: temAcesso ? Math.ceil((fim - agora) / DIA) : null,
      dunning: assinatura.dunning_state ?? "none",
      gateway: falha.gateway,
    });
  }

  /* Ordem de trabalho, não de valor: quem ainda tem acesso primeiro, porque a
     janela dessa gente fecha e a dos outros já fechou. */
  emRisco.sort((a, b) => {
    if (a.temAcesso !== b.temAcesso) return a.temAcesso ? -1 : 1;
    if (a.temAcesso) return (a.diasAteVencer ?? 0) - (b.diasAteVencer ?? 0);
    return b.valorCentavos - a.valorCentavos;
  });

  const emIso = (dias: number) => new Date(agora + dias * DIA).toISOString();
  const contar = async (monta: (q: ReturnType<typeof supabase.from>) => unknown) => {
    const query = monta(supabase.from("subscriptions")) as PromiseLike<{
      count: number | null;
      error: { message: string } | null;
    }>;
    const { count, error } = await query;
    if (error) throw new Error(error.message);
    return count ?? 0;
  };

  const [vencemEm7, vencemEm30, perderamAcesso30d] = await Promise.all([
    contar((q) =>
      q
        .select("user_id", { count: "exact", head: true })
        .in("status", ["active", "trialing"])
        .gte("current_period_end", new Date(agora).toISOString())
        .lt("current_period_end", emIso(7)),
    ),
    contar((q) =>
      q
        .select("user_id", { count: "exact", head: true })
        .in("status", ["active", "trialing"])
        .gte("current_period_end", new Date(agora).toISOString())
        .lt("current_period_end", emIso(30)),
    ),
    contar((q) =>
      q
        .select("user_id", { count: "exact", head: true })
        .not("status", "in", "(active,trialing)")
        .gte("current_period_end", desde)
        .lt("current_period_end", new Date(agora).toISOString()),
    ),
  ]);

  const serie = [...porDia.entries()]
    .map(([dia, v]) => ({ dia, falharam: v.falharam.size, recuperaram: v.recuperaram.size }))
    .sort((a, b) => a.dia.localeCompare(b.dia));

  return {
    emRisco,
    serie,
    vencemEm7,
    vencemEm30,
    perderamAcesso30d,
    geradoEm: new Date(agora).toISOString(),
  };
}
