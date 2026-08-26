import {
  carregarInteresse,
  carregarOrigem,
  type LinhaDeInteresse,
  type PainelDeOrigem,
} from "@/lib/origemPainel";
import { OrigemIndisponivel, SecaoOrigem } from "./origem-ui";

/**
 * Origem dos cadastros — a tela que responde "de onde veio" com profundidade.
 *
 * O painel já respondia isso, mas com um rótulo só, e o rótulo não bastava:
 * "Site" não dizia qual site — a landing? a biblioteca? o blog? a página de
 * cadastro? — e "Plugin" dizia onde a conta nasceu sem dizer como a pessoa
 * chegou lá. Esta tela desce quatro degraus: canal, peça de mídia, porta de
 * entrada e interesse declarado.
 *
 * Server Component: a credencial do ClickHouse fica no servidor e a página
 * chega pronta. `revalidate` de 5 min porque canal de aquisição não muda em
 * segundos — nada de polling.
 */
export const revalidate = 300;

/* A leitura varre ~95 dias de eventos no ClickHouse. O banco mata a consulta em
   45 s e o fetch aborta em 55 s; sem este teto a função morreria antes dos dois
   e o erro apontaria para o lugar errado. */
export const maxDuration = 60;

type Props = { searchParams: Promise<{ janela?: string }> };

export default async function OrigemPage({ searchParams }: Props) {
  const sp = await searchParams;
  const janela = Number(sp.janela) || 14;

  let painel: PainelDeOrigem | null = null;
  let erro: string | null = null;
  let interesse: LinhaDeInteresse[] | null = null;

  /* allSettled, e não all: as duas consultas têm destinos diferentes quando
     falham. O interesse declarado é um bloco a mais — se ele cair, o ranking
     continua na tela; se o ranking cair, não há tela. */
  const [origem, decl] = await Promise.allSettled([
    carregarOrigem(janela),
    carregarInteresse(),
  ]);

  if (origem.status === "fulfilled") painel = origem.value;
  else
    erro =
      origem.reason instanceof Error
        ? origem.reason.message
        : String(origem.reason);

  /* Falha aqui só apaga o último bloco. O motivo não vai para o console e
     morrer — some junto do bloco, em silêncio, que é o modo de falha que já
     custou dois deploys neste repositório só para descobrir o porquê. */
  if (decl.status === "fulfilled") interesse = decl.value;

  return (
    <main className="max-w-5xl mx-auto px-3 sm:px-4 py-6 space-y-4">
      <header>
        <h1 className="text-lg font-semibold text-gray-100">
          Origem dos cadastros
        </h1>
        <p className="text-xs text-gray-500 mt-1 leading-relaxed">
          Canal, peça, porta de entrada e interesse declarado — o caminho
          inteiro até a conta.
          {decl.status === "rejected" && (
            <span className="block text-amber-500/80 mt-1">
              O bloco de interesse declarado não carregou:{" "}
              {decl.reason instanceof Error
                ? decl.reason.message
                : String(decl.reason)}
            </span>
          )}
        </p>
      </header>

      {painel ? (
        <SecaoOrigem painel={painel} interesse={interesse} />
      ) : (
        <OrigemIndisponivel erro={erro ?? "Motivo desconhecido."} />
      )}
    </main>
  );
}
