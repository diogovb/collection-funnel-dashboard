import { brl, pct, wilson } from "@/lib/stats";
import { FORA_DO_RANKING, type Qualidade } from "@/lib/origem";
import { PISO_DO_CANAL, receitaPorConta } from "@/lib/canais";
import type {
  LinhaDeInteresse,
  LinhaDeOrigem,
  LinhaDePeca,
  LinhaDePorta,
  PainelDeOrigem,
} from "@/lib/origemPainel";

/**
 * De onde vêm os cadastros — a tela, em quatro degraus.
 *
 * Existe porque o painel respondia essa pergunta com uma palavra só, e a
 * palavra não bastava: "Site" não dizia qual site e "Plugin" não dizia como a
 * pessoa chegou lá. Aqui cada degrau abre o seguinte — canal, peça de mídia,
 * porta de entrada, interesse declarado — e nenhum deles é dado novo: tudo já
 * vinha no `page_url` do primeiro toque e nos eventos de cadastro.
 *
 * Duas regras atravessam a tela:
 *
 *  - **naturezas diferentes não se somam.** Anúncio, orgânico e tráfego
 *    direto disputam o ranking; disparo nosso, superfície de plugin, balde
 *    cego e link quebrado ficam de fora, com o motivo escrito. Misturá-los
 *    faria o painel comparar aquisição com reativação e chamar as duas de
 *    canal.
 *  - **volume aparece sempre; taxa só quando sustenta.** Abaixo do piso de
 *    contas a linha continua na tela com o número de cadastros e um traço no
 *    lugar da taxa. Filtrar a linha inteira — que é o que a tabela de
 *    campanhas do /experimentos faz — esconde justamente a campanha nova, que
 *    é a que alguém está esperando ver crescer.
 */

const CARD =
  "bg-gray-900/50 backdrop-blur-sm rounded-2xl p-4 border border-gray-800/50";

/**
 * Taxa com casas suficientes para o argumento sobreviver ao arredondamento.
 *
 * Mesma régua do `/experimentos`: abaixo de 10% vão duas casas, porque a
 * diferença entre 0,14% e 4,7% — que é o achado desta tela — some no décimo.
 */
const taxa = (v: number): string => pct(v, v < 0.1 ? 2 : 1);
const num = (v: number): string => v.toLocaleString("pt-BR");

/* ---------------------------------------------------------- qualidade ----- */

const CHIP: Record<Qualidade, { rotulo: string; classe: string }> = {
  pago: { rotulo: "pago", classe: "bg-amber-500/15 text-amber-300 border-amber-500/30" },
  organico: { rotulo: "orgânico", classe: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" },
  direto: { rotulo: "direto", classe: "bg-sky-500/15 text-sky-300 border-sky-500/30" },
  interno: { rotulo: "interno", classe: "bg-violet-500/15 text-violet-300 border-violet-500/30" },
  cego: { rotulo: "sem sinal", classe: "bg-gray-600/20 text-gray-400 border-gray-600/40" },
};

function Chip({ qualidade }: { qualidade: Qualidade }) {
  const c = CHIP[qualidade];
  return (
    <span
      className={`inline-block px-1.5 py-0.5 rounded text-[10px] border ${c.classe} whitespace-nowrap`}
    >
      {c.rotulo}
    </span>
  );
}

/* --------------------------------------------------------------- taxa ----- */

/**
 * Taxa com faixa de incerteza, ou o traço honesto.
 *
 * A linha nunca some por ser pequena — some a AFIRMAÇÃO sobre ela. Com 3
 * contas e 1 assinante, "33,3%" é um número verdadeiro e uma informação falsa.
 */
function Taxa({ acertos, base }: { acertos: number; base: number }) {
  if (base < PISO_DO_CANAL)
    return (
      <>
        <span className="text-gray-500">—</span>
        <span className="block text-[10px] text-gray-700 mt-0.5">
          menos de {PISO_DO_CANAL}
        </span>
      </>
    );
  const w = wilson(acertos, base);
  const fraco = w.high - w.low > w.p;
  return (
    <>
      <span className={fraco ? "text-gray-500" : "text-gray-100"}>{taxa(w.p)}</span>
      <span className="block text-[10px] text-gray-600 mt-0.5 tabular-nums">
        {taxa(w.low)}–{taxa(w.high)}
      </span>
    </>
  );
}

/**
 * A contagem, nas duas réguas que a tela usa.
 *
 * Em cima o que já teve chance de assinar (o denominador da taxa); embaixo o
 * que ainda não teve. Sem a segunda linha, uma peça que estreou esta semana
 * aparece como **0** e lê-se "ninguém veio" — quando o certo é "ainda não dá
 * para saber". Foi o que aconteceu com os posts do blog e com a landing nova.
 */
function Contagem({ maduras, todas }: { maduras: number; todas: number }) {
  const novas = Math.max(0, todas - maduras);
  return (
    <>
      <span className={maduras === 0 ? "text-gray-500" : ""}>
        {maduras === 0 ? "—" : num(maduras)}
      </span>
      {novas > 0 && (
        <span className="block text-[10px] text-gray-600 mt-0.5">
          +{num(novas)} maturando
        </span>
      )}
    </>
  );
}

/* ------------------------------------------------------------- canais ----- */

function TabelaDeCanais({ painel }: { painel: PainelDeOrigem }) {
  const { contas, receitaCents } = painel.totais;
  const mediaCasa = contas > 0 ? receitaCents / contas : 0;
  const visiveis = painel.canais.filter((c) => c.contasTodas > 0);
  const escala = Math.max(...visiveis.map(receitaPorConta), mediaCasa, 1) * 1.15;

  return (
    <div className={CARD}>
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h3 className="text-sm font-medium text-gray-200">De onde veio o clique</h3>
        <span className="text-[11px] text-gray-500 tabular-nums">
          {num(contas)} contas maduras · {brl(receitaCents)}
        </span>
      </div>
      <p className="text-xs text-gray-500 mt-1 leading-relaxed">
        Primeiro toque de cada conta. <strong>Contas maduras</strong> são as
        que já tiveram os {painel.janelaDias} dias para assinar — são elas que
        formam a taxa; as mais novas aparecem à parte, porque contá-las no
        denominador faria todo canal recente parecer pior do que é. A coluna{" "}
        <strong>no plugin</strong> é a fatia que chegou a abrir o SketchUp: é ela
        que separa quem assina de quem só cadastra, e costuma explicar mais que o
        próprio canal.
      </p>

      <div className="overflow-x-auto mt-3">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-gray-500 border-b border-gray-800">
              <th className="text-left font-normal py-1.5 pr-2">Canal</th>
              <th className="text-right font-normal py-1.5 px-2">Contas maduras</th>
              <th className="text-right font-normal py-1.5 px-2">Assina</th>
              <th className="text-right font-normal py-1.5 px-2">No plugin</th>
              <th className="text-right font-normal py-1.5 pl-2">R$/conta</th>
            </tr>
          </thead>
          <tbody>
            {visiveis.map((c) => {
              const rpc = receitaPorConta(c);
              const fatia = c.contas > 0 ? c.plugin.contas / c.contas : 0;
              return (
                <tr key={c.canal} className="border-b border-gray-800/40">
                  <td className="py-2 pr-2">
                    <span className="text-gray-200">{c.canal}</span>{" "}
                    <Chip qualidade={c.qualidade} />
                  </td>
                  <td className="text-right py-2 px-2 tabular-nums text-gray-300">
                    <Contagem maduras={c.contas} todas={c.contasTodas} />
                  </td>
                  <td className="text-right py-2 px-2 tabular-nums">
                    <Taxa acertos={c.assinantes} base={c.contas} />
                  </td>
                  <td className="text-right py-2 px-2 tabular-nums text-gray-400">
                    {c.contas >= PISO_DO_CANAL ? taxa(fatia) : "—"}
                  </td>
                  <td className="text-right py-2 pl-2 tabular-nums">
                    <span className="text-gray-200">{brl(rpc)}</span>
                    <span className="block mt-1 h-1 rounded-full bg-gray-800 overflow-hidden">
                      <span
                        className="block h-full bg-gradient-to-r from-indigo-500 to-purple-500"
                        style={{ width: `${Math.max(0.6, (rpc / escala) * 100)}%` }}
                      />
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Os baldes que não disputam — com o motivo escrito ao lado.
 *
 * Some seria pior: são 3 de cada 10 contas. O que não pode é competirem no
 * ranking, porque nenhum deles é um canal de aquisição.
 */
function ForaDoRanking({ painel }: { painel: PainelDeOrigem }) {
  const linhas = painel.foraDoRanking.filter((c) => c.contasTodas > 0);
  if (!linhas.length) return null;
  const total = painel.totais.contasTodas;

  return (
    <div className={CARD}>
      <h3 className="text-sm font-medium text-gray-200">
        Fora do ranking — e por quê
      </h3>
      <p className="text-xs text-gray-500 mt-1 leading-relaxed">
        Continuam no total (o denominador não perde nada), mas não competem: não
        são canais de aquisição. Aqui a contagem é de{" "}
        <strong>contas criadas</strong> — não a de contas maduras da tabela
        acima, porque o que importa nestes baldes é o tamanho do buraco, não a
        taxa deles.
      </p>
      <div className="mt-3 space-y-2.5">
        {linhas.map((c) => (
          <div key={c.canal} className="flex gap-3 items-start">
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="text-xs text-gray-200">{c.canal}</span>
                <span className="text-[11px] text-gray-500 tabular-nums">
                  {num(c.contasTodas)} contas criadas
                  {total > 0 && ` · ${taxa(c.contasTodas / total)} da base`}
                </span>
              </div>
              <p className="text-[11px] text-gray-600 mt-0.5 leading-relaxed">
                {FORA_DO_RANKING[c.canal] ?? "Balde à parte."}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- peças ---- */

/**
 * Campanha, criativo e posicionamento.
 *
 * `utm_content` e `utm_medium` não eram lidos por nenhuma tela do painel — e é
 * neles que o Meta grava o nome do criativo e onde ele apareceu, e o blog
 * grava qual post e qual CTA trouxe a pessoa. A informação estava chegando e
 * indo direto para o chão.
 */
function TabelaDePecas({ pecas }: { pecas: LinhaDePeca[] }) {
  if (!pecas.length) return null;

  return (
    <div className={CARD}>
      <h3 className="text-sm font-medium text-gray-200">Qual peça trouxe</h3>
      <p className="text-xs text-gray-500 mt-1 leading-relaxed">
        Campanha, criativo (<code className="text-gray-400">utm_content</code>) e
        onde apareceu (<code className="text-gray-400">utm_medium</code>). No
        Meta o posicionamento vem no lugar do meio; no blog, o CTA.
      </p>

      <div className="overflow-x-auto mt-3">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-gray-500 border-b border-gray-800">
              <th className="text-left font-normal py-1.5 pr-2">Canal</th>
              <th className="text-left font-normal py-1.5 px-2">Campanha</th>
              <th className="text-left font-normal py-1.5 px-2">Criativo</th>
              <th className="text-left font-normal py-1.5 px-2">Onde</th>
              <th className="text-right font-normal py-1.5 px-2">Contas</th>
              <th className="text-right font-normal py-1.5 pl-2">Assina</th>
            </tr>
          </thead>
          <tbody>
            {pecas.map((p, i) => (
              <tr
                key={`${p.canal}|${p.campanha}|${p.criativo}|${p.posicao}|${i}`}
                className="border-b border-gray-800/40"
              >
                <td className="py-2 pr-2 text-gray-400 whitespace-nowrap">{p.canal}</td>
                <td className="py-2 px-2 text-gray-300 max-w-[14rem] truncate" title={p.campanha}>
                  {p.campanha || "—"}
                </td>
                <td className="py-2 px-2 text-gray-300 max-w-[16rem] truncate" title={p.criativo}>
                  {p.criativo || "—"}
                </td>
                <td className="py-2 px-2 text-gray-500 max-w-[10rem] truncate" title={p.posicao}>
                  {p.posicao || "—"}
                </td>
                <td className="text-right py-2 px-2 tabular-nums text-gray-300">
                  <Contagem maduras={p.contas} todas={p.contasTodas} />
                </td>
                <td className="text-right py-2 pl-2 tabular-nums">
                  <Taxa acertos={p.assinantes} base={p.contas} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- portas ---- */

/**
 * Por qual porta a pessoa entrou — host E rota.
 *
 * O `/experimentos` já mostrava a porta, mas cortada em `domain()`: dava para
 * saber que veio de `collection.com.br` e nunca se foi pela home, pela `/lp` ou
 * pela `/instalar`. A rota é o primeiro segmento só — `/produto/mesa-xyz` vira
 * `/produto` — porque o que decide é a porta, não qual produto.
 */
function TabelaDePortas({ portas }: { portas: LinhaDePorta[] }) {
  if (!portas.length) return null;

  return (
    <div className={CARD}>
      <h3 className="text-sm font-medium text-gray-200">Por qual porta entrou</h3>
      <p className="text-xs text-gray-500 mt-1 leading-relaxed">
        Primeira página vista, com o dispositivo. É o que responde &ldquo;qual
        site&rdquo;: a biblioteca, a landing, o blog e a página de cadastro são
        portas diferentes, com conversões diferentes.
      </p>

      <div className="overflow-x-auto mt-3">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-gray-500 border-b border-gray-800">
              <th className="text-left font-normal py-1.5 pr-2">Porta</th>
              <th className="text-left font-normal py-1.5 px-2">Dispositivo</th>
              <th className="text-right font-normal py-1.5 px-2">Contas</th>
              <th className="text-right font-normal py-1.5 pl-2">Assina</th>
            </tr>
          </thead>
          <tbody>
            {portas.map((p, i) => (
              <tr key={`${p.host}${p.rota}${p.dispositivo}${i}`} className="border-b border-gray-800/40">
                <td className="py-2 pr-2">
                  <span className="text-gray-200">{p.host}</span>
                  <span className="text-gray-500">{p.rota}</span>
                </td>
                <td className="py-2 px-2 text-gray-500">{p.dispositivo}</td>
                <td className="text-right py-2 px-2 tabular-nums text-gray-300">
                  <Contagem maduras={p.contas} todas={p.contasTodas} />
                </td>
                <td className="text-right py-2 pl-2 tabular-nums">
                  <Taxa acertos={p.assinantes} base={p.contas} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- interesse ---- */

/**
 * O que a pessoa DISSE que queria.
 *
 * É o único sinal que atravessa o plugin: quem nasce dentro do SketchUp não
 * tem gclid nem referrer recuperável, mas respondeu "o que te trouxe aqui".
 * Declaração, não atribuição — e por isso fica num bloco à parte, nunca somado
 * ao ranking. A cobertura vem escrita junto porque é parcial.
 */
function TabelaDeInteresse({ linhas }: { linhas: LinhaDeInteresse[] }) {
  if (!linhas.length) return null;

  const total = linhas.reduce((a, l) => a + l.contas, 0);
  const semResposta = linhas
    .filter((l) => l.interesse.startsWith("("))
    .reduce((a, l) => a + l.contas, 0);

  /* Cauda de texto livre: o campo é aberto, e dezenas de respostas únicas
     ("meu apartamento", "o acaso") não são um segmento — são ruído com cara de
     dado. Some quem respondeu algo que ninguém mais respondeu. */
  const comResposta = linhas.filter((l) => !l.interesse.startsWith("(") && l.contas >= 5);

  const porInteresse = new Map<string, { contas: number; canais: Map<string, number> }>();
  for (const l of comResposta) {
    const atual = porInteresse.get(l.interesse) ?? { contas: 0, canais: new Map() };
    atual.contas += l.contas;
    atual.canais.set(l.canal, (atual.canais.get(l.canal) ?? 0) + l.contas);
    porInteresse.set(l.interesse, atual);
  }
  const ordenado = [...porInteresse.entries()].sort((a, b) => b[1].contas - a[1].contas);
  if (!ordenado.length) return null;

  return (
    <div className={CARD}>
      <h3 className="text-sm font-medium text-gray-200">
        O que a pessoa disse que queria
      </h3>
      <p className="text-xs text-gray-500 mt-1 leading-relaxed">
        Resposta do próprio cadastro. É o único sinal que atravessa o plugin —
        quem nasce dentro do SketchUp não tem clique recuperável, mas respondeu
        isto.{" "}
        {total > 0 && (
          <>
            <strong className="text-gray-400">
              Cobertura de {taxa(1 - semResposta / total)}
            </strong>{" "}
            — a pergunta só aparece numa das portas de cadastro, então o recorte
            não representa a base inteira.
          </>
        )}
      </p>

      <div className="mt-3 space-y-2">
        {ordenado.map(([interesse, dados]) => {
          const topo = [...dados.canais.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3);
          return (
            <div key={interesse} className="flex items-baseline justify-between gap-3">
              <div className="min-w-0">
                <span className="text-xs text-gray-200">{interesse}</span>
                <span className="block text-[11px] text-gray-600 truncate">
                  {topo.map(([c, q]) => `${c} (${num(q)})`).join(" · ")}
                </span>
              </div>
              <span className="text-xs tabular-nums text-gray-400 shrink-0">
                {num(dados.contas)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- topo ---- */

function Regua({ painel }: { painel: PainelDeOrigem }) {
  return (
    <div className={CARD}>
      <h3 className="text-sm font-medium text-gray-200">O que esta tela mede</h3>
      <p className="text-xs text-gray-500 mt-1.5 leading-relaxed">
        Contas criadas entre{" "}
        <strong className="text-gray-400">{painel.coorteDe}</strong> e{" "}
        <strong className="text-gray-400">{painel.coorteAte}</strong>, atribuídas
        ao <strong className="text-gray-400">primeiro toque</strong> registrado
        no ClickHouse. &ldquo;Assina&rdquo; é fatura paga de assinatura dentro de{" "}
        {painel.janelaDias} dias do cadastro — por isso a coorte para{" "}
        {painel.janelaDias} dias atrás: contas mais novas ainda não tiveram
        chance.
      </p>
      <p className="text-[11px] text-gray-600 mt-2 leading-relaxed">
        Régua diferente da tela <strong>Funil</strong>, que conta o que o próprio
        cadastro declarou no momento em que aconteceu. As duas respondem
        perguntas diferentes e não batem número a número — o que elas não podem
        é usar nomes diferentes para a mesma coisa, e agora não usam.
      </p>
    </div>
  );
}

/* --------------------------------------------------------------- seção ---- */

export function SecaoOrigem({
  painel,
  interesse,
}: {
  painel: PainelDeOrigem;
  interesse: LinhaDeInteresse[] | null;
}) {
  return (
    <div className="space-y-3">
      <Regua painel={painel} />
      <TabelaDeCanais painel={painel} />
      <ForaDoRanking painel={painel} />
      <TabelaDePecas pecas={painel.pecas} />
      <TabelaDePortas portas={painel.portas} />
      {interesse && <TabelaDeInteresse linhas={interesse} />}
    </div>
  );
}

/**
 * O bloco quando o ClickHouse não responde.
 *
 * Card vermelho com o erro à vista, e não um zero silencioso: um painel que
 * mostra zero quando não sabe é pior que um painel que não mostra nada.
 */
export function OrigemIndisponivel({ erro }: { erro: string }) {
  return (
    <div className="bg-red-950/30 border border-red-900/40 rounded-2xl p-4">
      <h3 className="text-sm font-medium text-red-200">
        Origem indisponível
      </h3>
      <p className="text-xs text-red-300/70 mt-1 leading-relaxed">{erro}</p>
    </div>
  );
}
