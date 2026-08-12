import { carregarRetencao, type CaminhoDeResgate, type PessoaEmRisco } from "@/lib/retencao";
import { brl } from "@/lib/stats";

/**
 * Retenção — a tela que faltava.
 *
 * O dashboard media aquisição em três lugares e churn em nenhum. Em 12/08/2026
 * a base perdeu **196 assinaturas em 30 dias contra ~90 novas**, e a maior
 * parte não foi decisão do cliente: foi cartão recusado que nunca se recuperou.
 * Isso é da mesma ordem de grandeza que a aquisição inteira, e muito mais
 * barato de reverter — essa gente já decidiu pagar uma vez.
 *
 * A tela é ordenada por AÇÃO, não por valor. Quem ainda está dentro do período
 * pago vem primeiro, porque é a única parte da lista onde ainda dá para
 * resolver antes de o cliente perceber que tem um problema.
 *
 * Server Component: a credencial do banco de assinaturas fica no servidor.
 */
export const revalidate = 300;
export const maxDuration = 60;

const CARD = "bg-gray-900/50 backdrop-blur-sm rounded-2xl p-4 border border-gray-800/50";

const CAMINHOS: Record<CaminhoDeResgate, { rotulo: string; comoAgir: string; cor: string }> = {
  atualizar_cartao: {
    rotulo: "Atualizar cartão",
    comoAgir: "Tem assinatura viva no gateway — a pessoa troca o cartão e a cobrança volta sozinha.",
    cor: "text-emerald-300",
  },
  refazer_cobranca: {
    rotulo: "Refazer cobrança",
    comoAgir: "Tem cliente no gateway, mas nada vai recobrar sozinho. Precisa de uma ação nossa.",
    cor: "text-amber-300",
  },
  recomprar: {
    rotulo: "Precisa recomprar",
    comoAgir: "Sem vínculo no gateway. Só volta refazendo a compra — é conversa, não cobrança.",
    cor: "text-rose-300",
  },
};

export default async function RetencaoPage() {
  let dados;
  try {
    dados = await carregarRetencao(30);
  } catch (erro) {
    /* Erro nunca pode virar zero: um painel de churn zerado é indistinguível
       de um mês sem churn, e essa é a leitura mais cara possível aqui. */
    return (
      <main className="max-w-5xl mx-auto px-3 sm:px-4 py-6">
        <h1 className="text-xl font-semibold">Retenção</h1>
        <div className={`${CARD} mt-4 border-rose-900/60`}>
          <p className="text-rose-300 text-sm font-medium">Não consegui consultar o banco.</p>
          <p className="text-gray-400 text-xs mt-1 font-mono break-all">
            {erro instanceof Error ? erro.message : String(erro)}
          </p>
          <p className="text-gray-500 text-xs mt-2">
            Os números abaixo estariam errados, então não mostro nenhum.
          </p>
        </div>
      </main>
    );
  }

  const { emRisco, serie, vencemEm7, vencemEm30, perderamAcesso30d } = dados;
  const comAcesso = emRisco.filter((p) => p.temAcesso);
  const semAcesso = emRisco.filter((p) => !p.temAcesso);
  const soma = (lista: PessoaEmRisco[]) => lista.reduce((s, p) => s + p.valorCentavos, 0);

  const porCaminho = (["atualizar_cartao", "refazer_cobranca", "recomprar"] as CaminhoDeResgate[])
    .map((caminho) => {
      const lista = emRisco.filter((p) => p.caminho === caminho);
      return { caminho, lista, comAcesso: lista.filter((p) => p.temAcesso).length, valor: soma(lista) };
    })
    .filter((g) => g.lista.length > 0);

  const picoDaSerie = Math.max(1, ...serie.map((d) => Math.max(d.falharam, d.recuperaram)));

  return (
    <main className="max-w-5xl mx-auto px-3 sm:px-4 py-6 space-y-4">
      <header>
        <h1 className="text-xl font-semibold">Retenção</h1>
        <p className="text-sm text-gray-400 mt-1">
          Cobranças recusadas nos últimos 30 dias que <strong>não foram recuperadas</strong>. A régua é
          a fatura, não o estado do dunning — que fica em <code className="text-gray-500">none</code>{" "}
          justamente em quem não tem assinatura viva no gateway.
        </p>
      </header>

      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className={CARD}>
          <p className="text-xs text-gray-400">Em risco agora</p>
          <p className="text-2xl font-semibold mt-1">{emRisco.length}</p>
          <p className="text-xs text-gray-500 mt-1">{brl(soma(emRisco))} em assinaturas</p>
        </div>
        {/* O número que manda na semana: aqui a janela ainda está aberta. */}
        <div className={`${CARD} border-emerald-800/50`}>
          <p className="text-xs text-emerald-300">Dá para salvar hoje</p>
          <p className="text-2xl font-semibold mt-1 text-emerald-300">{comAcesso.length}</p>
          <p className="text-xs text-gray-500 mt-1">ainda dentro do período pago</p>
        </div>
        <div className={CARD}>
          <p className="text-xs text-gray-400">Já perderam acesso</p>
          <p className="text-2xl font-semibold mt-1 text-rose-300">{semAcesso.length}</p>
          <p className="text-xs text-gray-500 mt-1">{brl(soma(semAcesso))}</p>
        </div>
        <div className={CARD}>
          <p className="text-xs text-gray-400">Vencem em 30 dias</p>
          <p className="text-2xl font-semibold mt-1">{vencemEm30}</p>
          <p className="text-xs text-gray-500 mt-1">{vencemEm7} nos próximos 7</p>
        </div>
      </section>

      <section className={CARD}>
        <h2 className="text-sm font-medium">O que fazer com cada um</h2>
        <p className="text-xs text-gray-500 mt-0.5">
          Nem toda recusa tem o mesmo conserto — pedir &quot;atualize seu cartão&quot; para quem não tem
          assinatura no gateway não resolve nada.
        </p>
        <div className="grid sm:grid-cols-3 gap-3 mt-3">
          {porCaminho.map(({ caminho, lista, comAcesso: aindaDaTempo, valor }) => (
            <div key={caminho} className="rounded-xl bg-gray-950/60 p-3 border border-gray-800/40">
              <p className={`text-sm font-medium ${CAMINHOS[caminho].cor}`}>{CAMINHOS[caminho].rotulo}</p>
              <p className="text-xl font-semibold mt-1">{lista.length}</p>
              <p className="text-xs text-gray-500">
                {brl(valor)} · {aindaDaTempo} com acesso
              </p>
              <p className="text-xs text-gray-400 mt-2 leading-snug">{CAMINHOS[caminho].comoAgir}</p>
            </div>
          ))}
        </div>
      </section>

      <section className={CARD}>
        <h2 className="text-sm font-medium">Recusas e recuperações por dia</h2>
        <p className="text-xs text-gray-500 mt-0.5">
          Se a régua de cobrança recusada estiver funcionando, a barra clara cresce.
        </p>
        <div className="flex items-end gap-[3px] mt-3 h-24">
          {serie.map((d) => (
            <div key={d.dia} className="flex-1 flex flex-col justify-end gap-[2px] group relative">
              <div
                className="w-full bg-emerald-500/70 rounded-sm"
                style={{ height: `${(d.recuperaram / picoDaSerie) * 100}%` }}
              />
              <div
                className="w-full bg-rose-500/60 rounded-sm"
                style={{ height: `${(d.falharam / picoDaSerie) * 100}%` }}
              />
              <span className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 hidden group-hover:block whitespace-nowrap text-[10px] bg-gray-950 border border-gray-800 rounded px-1.5 py-0.5 z-10">
                {d.dia.slice(5)} · {d.falharam} recusa{d.falharam === 1 ? "" : "s"} ·{" "}
                {d.recuperaram} recuperada{d.recuperaram === 1 ? "" : "s"}
              </span>
            </div>
          ))}
        </div>
        <div className="flex gap-4 mt-2 text-[11px] text-gray-500">
          <span className="flex items-center gap-1.5">
            <i className="w-2.5 h-2.5 rounded-sm bg-rose-500/60 inline-block" /> recusaram
          </span>
          <span className="flex items-center gap-1.5">
            <i className="w-2.5 h-2.5 rounded-sm bg-emerald-500/70 inline-block" /> recuperaram
          </span>
        </div>
      </section>

      <section className={CARD}>
        <h2 className="text-sm font-medium">
          Casos abertos <span className="text-gray-500 font-normal">({emRisco.length})</span>
        </h2>
        <p className="text-xs text-gray-500 mt-0.5">
          Ordenado por urgência: quem ainda tem acesso primeiro, do que vence antes para o que vence
          depois. Sem e-mail nesta tela de propósito — para agir, use o CSV de resgate.
        </p>
        <div className="overflow-x-auto mt-3">
          <table className="w-full text-sm min-w-[560px]">
            <thead className="text-xs text-gray-500 border-b border-gray-800">
              <tr>
                <th className="text-left font-normal py-1.5">Situação</th>
                <th className="text-left font-normal">Plano</th>
                <th className="text-right font-normal">Valor</th>
                <th className="text-right font-normal">Tentativas</th>
                <th className="text-left font-normal pl-3">Caminho</th>
                <th className="text-right font-normal">Última recusa</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/60">
              {emRisco.slice(0, 60).map((p) => (
                <tr key={p.userId}>
                  <td className="py-1.5">
                    {p.temAcesso ? (
                      <span className="text-emerald-300">
                        vence em {p.diasAteVencer}d
                      </span>
                    ) : (
                      <span className="text-rose-300">sem acesso</span>
                    )}
                  </td>
                  <td className="text-gray-400">{p.plano || "—"}</td>
                  <td className="text-right tabular-nums">{brl(p.valorCentavos)}</td>
                  <td className="text-right tabular-nums text-gray-400">{p.tentativas}</td>
                  <td className={`pl-3 ${CAMINHOS[p.caminho].cor}`}>{CAMINHOS[p.caminho].rotulo}</td>
                  <td className="text-right text-gray-500 tabular-nums">{p.ultimaFalha.slice(5, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {emRisco.length > 60 && (
          <p className="text-xs text-gray-500 mt-2">
            Mostrando 60 de {emRisco.length} — o resto está no CSV de resgate.
          </p>
        )}
      </section>

      <p className="text-xs text-gray-600">
        Perderam acesso nos últimos 30 dias: <strong>{perderamAcesso30d}</strong>. Compare com os
        assinantes novos do mesmo período — se este número for maior, a base está encolhendo.
      </p>
    </main>
  );
}
