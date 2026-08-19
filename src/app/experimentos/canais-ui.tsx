import { brl, pct, wilson } from "@/lib/stats";
import type { Exposicoes } from "@/lib/supabase-subs";
import {
  PISO_DO_CANAL,
  SEM_RASTRO,
  receitaPorConta,
  type LinhaDeCanal,
  type PainelDeCanais,
} from "@/lib/canais";

/**
 * Aquisição — de onde vêm os assinantes.
 *
 * Mora em arquivo separado, e não inline no `page.tsx` como os outros blocos,
 * por um motivo que não é tamanho: **esta seção mede outra coisa**. Tudo acima
 * dela divide por *pessoa exposta a um preço*, com janela de atribuição e
 * maduros do experimento; aqui o denominador é *conta criada*, e a fonte é o
 * ClickHouse e não o Supabase de assinaturas. Manter as duas réguas em arquivos
 * diferentes é a versão em código da cerca que a tela desenha.
 *
 * A régua da seção é RECEITA POR CONTA, e isso é uma decisão:
 * `assinantes = taxa x contas`, e o segundo fator é quanto se comprou de
 * tráfego — decisão de orçamento, não qualidade do canal. Ordenar por
 * assinantes absolutos responderia "onde estão os assinantes que já temos" e
 * nunca "onde conseguir o próximo". É a mesma filosofia que decide o
 * experimento por receita por exposto, e não por conversão.
 */

const CARD =
  "bg-gray-900/50 backdrop-blur-sm rounded-2xl p-4 border border-gray-800/50";

/**
 * Taxa com casas suficientes para o argumento sobreviver ao arredondamento.
 *
 * `pct` usa uma casa. Com 0,61% isso vira "0.6%", e a diferença entre 0,61% e
 * 5,16% — que é o achado inteiro desta tela — some no décimo. Abaixo de 10% vão
 * duas casas.
 */
const taxa = (v: number): string => pct(v, v < 0.1 ? 2 : 1);

const num = (v: number): string => v.toLocaleString("pt-BR");

/** "A, B e C" — e nao "A e B e C", que e o que um join(" e ") produz. */
const listar = (itens: string[]): string =>
  itens.length <= 1
    ? (itens[0] ?? "")
    : `${itens.slice(0, -1).join(", ")} e ${itens[itens.length - 1]}`;

/** Fatia de uma linha que chegou ao plugin. */
const fatiaPlugin = (l: LinhaDeCanal): number =>
  l.contas > 0 ? l.plugin.contas / l.contas : 0;

/**
 * Canal com base suficiente para DISPUTAR o topo do ranking.
 *
 * O piso de 20 contas evita a taxa anedótica, mas não evita o pódio anedótico:
 * um canal com 25 contas e 1 assinante rende R$ 32 por conta e passa na frente
 * de todos — com a barra mais longa da tela, que é a coisa que se lê primeiro.
 * O teste é o mesmo que já esmaece a taxa: se a faixa de Wilson é mais larga
 * que a própria taxa, o número não sustenta uma posição.
 *
 * Ele não some da tela. Ele sai do pódio e vai para o fim da lista, cinza.
 */
const confiavel = (l: LinhaDeCanal): boolean => {
  if (l.contas < PISO_DO_CANAL) return false;
  const w = wilson(l.assinantes, l.contas);
  return w.high - w.low <= w.p;
};

/**
 * Confiáveis primeiro, por quanto rendem. Depois os outros, por VOLUME.
 *
 * A troca de critério no segundo grupo é de propósito: se não dá para ranquear
 * por rendimento — é essa a definição de `confiavel` — então ordenar por
 * rendimento ali embaixo é ordenar por ruído, e poria um canal de 25 contas na
 * frente de um de 252. Sem régua de valor, a régua honesta é o tamanho.
 */
const ordemDoRanking = (a: LinhaDeCanal, b: LinhaDeCanal): number => {
  const ca = confiavel(a);
  const cb = confiavel(b);
  if (ca !== cb) return ca ? -1 : 1;
  if (!ca) return b.contas - a.contas;
  const d = receitaPorConta(b) - receitaPorConta(a);
  return d !== 0 ? d : b.contas - a.contas;
};

/* ------------------------------------------------------------- veredito --- */

type Julgamento = { tom: "neutro" | "atencao" | "bom" | "ruim"; titulo: string; detalhe: string };

/** Canal de volume: a partir daqui ele é responsável pelo mix, não um detalhe. */
const FATIA_DE_VOLUME = 0.2;
/** Renda menos que metade da média da casa = está queimando cadastro. */
const CORTE_DE_QUEIMA = 0.5;
/** Acima disso o rastreamento está furado demais para o ranking valer. */
const TETO_SEM_RASTRO = 0.25;

function julgarCanais(p: PainelDeCanais): Julgamento {
  const { contas, assinantes, receitaCents } = p.totais;

  if (contas === 0)
    return {
      tom: "neutro",
      titulo: "Ainda não há contas maduras no período",
      detalhe:
        "Nenhuma conta criada há tempo suficiente para ter tido chance de assinar. Se isso não é esperado, o problema é a consulta, não o marketing.",
    };

  const semRastro = p.semRastro.contas / contas;
  if (semRastro > TETO_SEM_RASTRO)
    return {
      tom: "atencao",
      titulo: "Boa parte das contas não deixou rastro",
      detalhe: `${num(p.semRastro.contas)} das ${num(contas)} contas (${taxa(
        semRastro,
      )}) não registraram nenhum evento, então não dá para dizer de onde vieram. Com esse tamanho de buraco o ranking abaixo não vale: qualquer canal pode estar escondido aí dentro. Antes de mexer em orçamento por canal, conserte o rastreamento.`,
    };

  if (assinantes === 0)
    return {
      tom: "neutro",
      titulo: "Nenhum assinante no período",
      detalhe: `${num(
        contas,
      )} contas maduras e nenhuma assinatura paga na janela. Não dá para ranquear canal por conversão quando a conversão é zero em toda parte.`,
    };

  const mediaCasa = receitaCents / contas;
  const candidatos = [...p.canais]
    .filter((c) => c.contas >= PISO_DO_CANAL)
    .sort(ordemDoRanking);

  /* O queimador é o de MAIOR VOLUME entre os que rendem menos que metade da
     média — não o pior de todos. Um canal minúsculo e ruim não é problema de
     orçamento; um canal grande e ruim é a conta inteira. */
  const queimador = candidatos
    .filter(
      (c) =>
        c.contas / contas >= FATIA_DE_VOLUME &&
        receitaPorConta(c) < mediaCasa * CORTE_DE_QUEIMA,
    )
    .sort((a, b) => b.contas - a.contas)[0];

  const melhor = candidatos[0];

  if (queimador) {
    const alternativa = candidatos.find((c) => c.canal !== queimador.canal);
    const vezes =
      alternativa && receitaPorConta(queimador) > 0
        ? receitaPorConta(alternativa) / receitaPorConta(queimador)
        : null;
    return {
      tom: "ruim",
      titulo: `${queimador.canal} traz o volume e não traz assinante`,
      detalhe:
        `${num(queimador.contas)} das ${num(contas)} contas do período (${taxa(
          queimador.contas / contas,
        )}) vieram de ${queimador.canal}, e cada uma rendeu ${brl(
          receitaPorConta(queimador),
        )}. A média da casa é ${brl(mediaCasa)}` +
        (alternativa && vezes
          ? `, e um cadastro de ${alternativa.canal} rende ${brl(
              receitaPorConta(alternativa),
            )} — ${vezes.toFixed(1).replace(".", ",")}x mais`
          : "") +
        `. Ele também é o canal com mais assinantes (${num(
          queimador.assinantes,
        )} de ${num(assinantes)}): tem mais porque trouxe mais gente, não porque converte melhor. A causa está logo abaixo — só ${taxa(
          fatiaPlugin(queimador),
        )} de quem vem dele chega a usar o plugin, e é lá que a conversão acontece.`,
    };
  }

  if (melhor && receitaPorConta(melhor) >= mediaCasa * 1.5)
    return {
      tom: "bom",
      titulo: `${melhor.canal} é o canal que mais rende por cadastro`,
      detalhe: `Cada conta vinda de ${melhor.canal} rendeu ${brl(
        receitaPorConta(melhor),
      )} na janela, contra ${brl(
        mediaCasa,
      )} da média da casa. E nenhum canal de volume está abaixo da metade da média — não há cadastro sendo queimado em escala hoje.`,
    };

  return {
    tom: "neutro",
    titulo: "Nenhum canal se destaca ainda",
    detalhe: `Nenhum canal rende 50% acima da média da casa (${brl(
      mediaCasa,
    )} por conta), e nenhum canal de volume rende menos que metade dela. Sem diferença grande o bastante, mexer no mix de aquisição é aposta.`,
  };
}

function VereditoCanais({ painel }: { painel: PainelDeCanais }) {
  const j = julgarCanais(painel);
  const cor = {
    neutro: "border-gray-800/50",
    atencao: "border-amber-500/40",
    bom: "border-emerald-500/40",
    ruim: "border-red-500/40",
  }[j.tom];
  const ponto = {
    neutro: "bg-gray-500",
    atencao: "bg-amber-400",
    bom: "bg-emerald-400",
    ruim: "bg-red-400",
  }[j.tom];

  /* A barra mede a ALAVANCA, não o placar: quantos do canal de maior volume
     chegam ao plugin, contra o que os outros canais conseguem.

     Escala 0–100% de propósito. Comprimir para 0–30% faria a diferença parecer
     maior do que é e esconderia o segundo achado: ninguém é bom nisso. */
  const maior = painel.canais.filter((c) => c.contas >= PISO_DO_CANAL).sort((a, b) => b.contas - a.contas)[0];
  /* O "Plugin SketchUp" fica fora do comparativo: ele é 100% por construção
     (nasceu dentro do plugin), e incluí-lo inflaria a régua com uma tautologia. */
  const outros = painel.canais.filter(
    (c) => c !== maior && c.contas >= PISO_DO_CANAL && fatiaPlugin(c) < 1,
  );
  const somaOutras = outros.reduce(
    (a, c) => ({ p: a.p + c.plugin.contas, t: a.t + c.contas }),
    { p: 0, t: 0 },
  );
  const refOutros = somaOutras.t > 0 ? somaOutras.p / somaOutras.t : 0;

  return (
    <div className={`${CARD} ${cor}`}>
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${ponto}`} />
        <h2 className="text-lg font-semibold text-gray-100">{j.titulo}</h2>
      </div>
      <p className="text-sm text-gray-400 mt-2 leading-relaxed">{j.detalhe}</p>

      {!!maior && maior.contas > 0 && (
        <div className="mt-4">
          <div className="flex justify-between text-xs text-gray-400 mb-1.5 gap-3 flex-wrap">
            <span>
              Chegam ao plugin, vindos de {maior.canal} —{" "}
              <span className="text-gray-200 tabular-nums">
                {num(maior.plugin.contas)} de {num(maior.contas)} ·{" "}
                {taxa(fatiaPlugin(maior))}
              </span>
            </span>
            <span>
              nos outros canais:{" "}
              <span className="text-gray-200 tabular-nums">{taxa(refOutros)}</span>
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-gray-800 overflow-hidden relative">
            <div
              className="h-full bg-gradient-to-r from-indigo-500 to-purple-500"
              style={{ width: `${Math.min(100, fatiaPlugin(maior) * 100)}%` }}
            />
            <div
              className="absolute top-0 bottom-0 w-px border-l border-dashed border-amber-300/80"
              style={{ left: `${Math.min(100, refOutros * 100)}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------- tabela dos canais ---- */

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
  /* Faixa mais larga que a própria taxa = número verdadeiro e informação
     inútil. Ele não some da tela — some do primeiro plano. */
  const fraco = w.high - w.low > w.p;
  return (
    <>
      <span className={fraco ? "text-gray-500" : "text-gray-100"}>
        {taxa(w.p)}
      </span>
      <span className="block text-[10px] text-gray-600 mt-0.5 tabular-nums">
        {taxa(w.low)}–{taxa(w.high)}
      </span>
    </>
  );
}

function TabelaDeCanais({ painel }: { painel: PainelDeCanais }) {
  const { contas, assinantes, receitaCents } = painel.totais;
  const mediaCasa = contas > 0 ? receitaCents / contas : 0;
  const visiveis = [...painel.canais]
    .filter((c) => c.contasTodas > 0)
    .sort(ordemDoRanking);

  /* Escala com folga de 15%: a maior barra não encosta na borda, e a linha da
     média cabe dentro do trilho mesmo quando é o próprio máximo. */
  const escala = Math.max(...visiveis.map(receitaPorConta), mediaCasa, 1) * 1.15;
  const largura = (v: number) => `${Math.max(0.6, (v / escala) * 100)}%`;
  const queimando = (c: LinhaDeCanal) =>
    c.contas >= PISO_DO_CANAL &&
    c.contas / contas >= FATIA_DE_VOLUME &&
    receitaPorConta(c) < mediaCasa * CORTE_DE_QUEIMA;

  const somaLinhas =
    visiveis.reduce((a, c) => a + c.contasTodas, 0) + painel.semRastro.contasTodas;

  return (
    <div className={CARD}>
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h3 className="text-sm font-medium text-gray-200">
          Quanto cada canal rende por cadastro
        </h3>
        <span className="text-[11px] text-gray-500 tabular-nums">
          {num(contas)} contas maduras · {num(assinantes)} assinantes ·{" "}
          {brl(receitaCents)}
        </span>
      </div>
      <p className="text-xs text-gray-500 mt-1 leading-relaxed">
        A régua é <span className="text-gray-300">receita por conta</span>, e não
        número de assinantes: assinante absoluto depende de quanto se comprou de
        tráfego, receita por conta não. Ordenado do que mais rende para o que
        menos rende.
      </p>

      <div className="overflow-x-auto mt-3">
        <table className="w-full text-xs min-w-[520px]">
          <thead>
            <tr className="text-gray-500 text-[11px]">
              <th className="text-left font-normal pb-2">Canal</th>
              <th className="text-right font-normal pb-2">Assinantes / contas</th>
              <th className="text-right font-normal pb-2">Receita</th>
              <th className="text-right font-normal pb-2 w-[38%]">
                Receita por conta
              </th>
            </tr>
          </thead>
          <tbody>
            {visiveis.map((c) => {
              const rpc = receitaPorConta(c);
              const alerta = queimando(c);
              return (
                <tr key={c.canal} className="border-t border-gray-800/50">
                  <td className="py-1.5 text-gray-300 align-top whitespace-nowrap">
                    {alerta && (
                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 mr-1.5 align-middle" />
                    )}
                    {c.canal}
                  </td>
                  <td className="py-1.5 text-right tabular-nums align-top">
                    <span className="whitespace-nowrap text-gray-100">
                      {num(c.assinantes)}
                      <span className="text-gray-600">/{num(c.contas)}</span>
                    </span>
                    <span className="block mt-0.5">
                      <Taxa acertos={c.assinantes} base={c.contas} />
                    </span>
                  </td>
                  <td className="py-1.5 text-right text-gray-500 tabular-nums align-top">
                    {c.receitaCents > 0 ? brl(c.receitaCents) : "—"}
                  </td>
                  <td className="py-1.5 pl-3 align-top">
                    <div className="h-2 rounded-sm bg-gray-900/80 overflow-hidden relative">
                      <div
                        className={`h-full ${
                          !confiavel(c)
                            ? "bg-gray-800"
                            : rpc >= mediaCasa
                              ? "bg-indigo-500"
                              : "bg-gray-700"
                        }`}
                        style={{ width: largura(rpc) }}
                      />
                      {/* A mesma linha em todos os trilhos: como eles estão
                          alinhados, ela se lê como uma régua vertical única. */}
                      <div
                        className="absolute top-0 bottom-0 w-px border-l border-dashed border-gray-500/50"
                        style={{ left: `${(mediaCasa / escala) * 100}%` }}
                      />
                    </div>
                    <span
                      className={`block text-right tabular-nums mt-1 ${
                        alerta
                          ? "text-amber-400"
                          : confiavel(c)
                            ? "text-gray-100"
                            : "text-gray-500"
                      }`}
                    >
                      {brl(rpc)}
                    </span>
                  </td>
                </tr>
              );
            })}

            {/* "Sem rastro" fica DENTRO do total e FORA do ranking. Tirá-lo do
                denominador criaria uma segunda régua na mesma tela. */}
            <tr>
              <td
                colSpan={4}
                className="pt-3 pb-1 text-[10px] text-gray-600 uppercase tracking-wider"
              >
                fora do ranking
              </td>
            </tr>
            <tr
              className="border-t border-gray-800/50 text-gray-600"
              title="Conta criada, nenhum evento registrado"
            >
              <td className="py-1.5 text-gray-500 align-top">
                {painel.semRastro.canal}
              </td>
              <td className="py-1.5 text-right tabular-nums align-top">
                {num(painel.semRastro.assinantes)}
                <span className="text-gray-700">
                  /{num(painel.semRastro.contas)}
                </span>
              </td>
              <td className="py-1.5 text-right align-top">—</td>
              {/* "—" e não "R$ 0,00": não é que rendeu zero, é que não dá para dizer. */}
              <td className="py-1.5 text-right align-top">—</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-gray-500 mt-3 leading-relaxed">
        <strong>Sem rastro não é um canal.</strong> São {num(painel.semRastro.contas)}{" "}
        contas maduras ({taxa(contas > 0 ? painel.semRastro.contas / contas : 0)}{" "}
        do período) que não registraram nenhum evento — nem visita, nem plugin,
        nem clique. Não é que vieram de lugar nenhum: é que não sabemos de onde
        vieram. Continuam no total, para o denominador não mentir, e ficam fora
        da comparação porque não há o que comparar. A linha tracejada nas barras
        é a média da casa, {brl(mediaCasa)} por conta.
        {painel.aindaMaturando > 0 && (
          <>
            {" "}
            Outras {num(painel.aindaMaturando)} contas foram criadas há menos de{" "}
            {painel.janelaDias} dias e ainda não entram em taxa nenhuma.
          </>
        )}
      </p>

      {somaLinhas !== painel.totais.contasTodas && (
        <p className="text-[11px] text-amber-300/70 mt-2">
          As linhas somam {num(somaLinhas)} contas e o período tem{" "}
          {num(painel.totais.contasTodas)}. Se essa diferença crescer, o problema
          é a classificação de canal.
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------ canal x plugin ---- */

function ModuloDoCanal({
  linha,
  escala,
}: {
  linha: LinhaDeCanal;
  escala: number;
}) {
  const tWeb = linha.web.contas > 0 ? linha.web.assinantes / linha.web.contas : 0;
  const tPlug =
    linha.plugin.contas > 0 ? linha.plugin.assinantes / linha.plugin.contas : 0;
  /* O multiplicador só existe com os DOIS lados de pé — comparar contra um lado
     que nem taxa tem seria inventar a metade que falta. Regra do LinhaCoorte. */
  const comBase =
    linha.web.contas >= PISO_DO_CANAL && linha.plugin.contas >= PISO_DO_CANAL;
  const mult = comBase && tWeb > 0 ? tPlug / tWeb : null;

  const barra = (v: number) => `${Math.max(0.6, (v / escala) * 100)}%`;

  return (
    <div className="rounded-lg bg-gray-950/60 border border-gray-800/50 px-2.5 py-2">
      <div className="flex justify-between text-xs mb-2 gap-3 flex-wrap">
        <span className="text-gray-300">{linha.canal}</span>
        <span className="text-gray-500 tabular-nums">
          {num(linha.plugin.contas)} de {num(linha.contas)} chegaram ao plugin ·{" "}
          <span className="text-gray-300">{taxa(fatiaPlugin(linha))}</span>
        </span>
      </div>

      <div className="flex items-center gap-3">
        <div className="flex-1 space-y-1">
          {[
            { rotulo: "web", p: linha.web, t: tWeb, cor: "bg-gray-600" },
            { rotulo: "plugin", p: linha.plugin, t: tPlug, cor: "bg-indigo-500" },
          ].map((l) => (
            <div key={l.rotulo} className="flex items-center gap-2">
              <span className="text-[10px] text-gray-600 w-10">{l.rotulo}</span>
              <span className="text-[10px] text-gray-500 tabular-nums w-16 text-right whitespace-nowrap">
                {num(l.p.assinantes)}
                <span className="text-gray-700">/{num(l.p.contas)}</span>
              </span>
              <div className="flex-1 h-3 rounded-sm bg-gray-900/80 overflow-hidden">
                <div className={`h-full ${l.cor}`} style={{ width: barra(l.t) }} />
              </div>
              <span className="text-[10px] text-gray-500 w-12 text-right tabular-nums">
                {l.p.contas >= PISO_DO_CANAL ? taxa(l.t) : "—"}
              </span>
            </div>
          ))}
        </div>
        <span
          className={`text-sm font-semibold tabular-nums w-12 text-right ${
            mult === null ? "text-gray-600" : "text-gray-100"
          }`}
        >
          {mult === null
            ? "—"
            : `${(mult >= 10 ? mult.toFixed(0) : mult.toFixed(1).replace(".", ","))}x`}
        </span>
      </div>
    </div>
  );
}

/**
 * O que separa quem assina de quem só cadastra.
 *
 * Não é heatmap de propósito: entre 0,13% e 5,41% a saturação satura, e as duas
 * células ficariam "clara" e "escura" — o mesmo par visual que separaria 3% de
 * 10%. Barra em escala compartilhada expressa a razão; cor não.
 */
function CanalXPlugin({ painel }: { painel: PainelDeCanais }) {
  /* Só entra o canal em que a comparação EXISTE: os dois lados com base, ou o
     canal que é 100% plugin por nascimento. Sem esse filtro o bloco enche de
     módulos com "—" dos dois lados — nove cartões para três informações, que é
     exatamente a sopa de números que a divisão por canal veio evitar. */
  const comparaveis = painel.canais.filter(
    (c) =>
      (c.web.contas >= PISO_DO_CANAL && c.plugin.contas >= PISO_DO_CANAL) ||
      (c.contas >= PISO_DO_CANAL && fatiaPlugin(c) === 1),
  );
  const linhas = [...comparaveis].sort((a, b) => b.contas - a.contas);
  const deFora = painel.canais.filter(
    (c) => c.contas >= PISO_DO_CANAL && !comparaveis.includes(c),
  );
  if (!linhas.length) return null;

  /* Escala compartilhada entre TODOS os canais: sem isso, comparar um módulo
     com o outro vira ilusão de ótica. Mesma decisão da MatrizCoortes. */
  const escala =
    Math.max(
      ...linhas.map((c) =>
        Math.max(
          c.plugin.contas > 0 ? c.plugin.assinantes / c.plugin.contas : 0,
          c.web.contas > 0 ? c.web.assinantes / c.web.contas : 0,
        ),
      ),
      0.01,
    ) * 1.15;

  const chegam = linhas
    .filter((c) => fatiaPlugin(c) < 1)
    .sort((a, b) => fatiaPlugin(b) - fatiaPlugin(a));

  return (
    <div className={CARD}>
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h3 className="text-sm font-medium text-gray-200">
          O que separa quem assina de quem só cadastra: o plugin
        </h3>
        <span className="text-[11px] text-gray-500">
          taxa = assinantes ÷ contas <strong>do pedaço</strong>
        </span>
      </div>
      <p className="text-xs text-gray-500 mt-1 leading-relaxed">
        O mesmo canal, partido em dois: quem ficou só na web e quem chegou a
        abrir o plugin. Em todos eles o lado do plugin converte muito mais.
      </p>

      <div className="space-y-3 mt-3">
        {linhas.map((c) => (
          <ModuloDoCanal key={c.canal} linha={c} escala={escala} />
        ))}
      </div>

      {deFora.length > 0 && (
        <p className="text-[11px] text-gray-600 mt-2">
          {deFora.length === 1 ? "Fica de fora" : "Ficam de fora"}{" "}
          {deFora.map((c) => c.canal).join(", ")}: {deFora.length === 1 ? "tem" : "têm"}{" "}
          menos de {PISO_DO_CANAL} contas de um dos dois lados, e uma comparação
          com um lado só seria inventar a metade que falta.
        </p>
      )}

      {chegam.length > 1 && (
        <p className="text-[11px] text-gray-500 mt-3 leading-relaxed">
          <strong>Chegam ao plugin:</strong>{" "}
          {chegam.map((c, i) => (
            <span key={c.canal}>
              {i > 0 && " · "}
              <span
                className={
                  i === chegam.length - 1 ? "text-amber-400" : undefined
                }
              >
                {c.canal} {taxa(fatiaPlugin(c))}
              </span>
            </span>
          ))}
          . É o único número desta seção que vira tarefa: levar ao plugin quem já
          entrou não custa mídia nova.
        </p>
      )}

      <p className="text-[11px] text-gray-500 mt-2 leading-relaxed">
        <strong>Cuidado com a causa.</strong> Quem instala o plugin já é mais
        interessado antes de instalar. Esta tela não separa &ldquo;o plugin faz
        assinar&rdquo; de &ldquo;quem ia assinar instala o plugin&rdquo; — isso
        só um teste resolve. Nas duas leituras, porém, a conclusão operacional é
        a mesma: o plugin é o melhor marcador de futuro assinante que a gente
        tem, e o canal de maior volume é o que menos leva gente até ele.
      </p>
    </div>
  );
}

/* ------------------------------------------------------- cortes extras ---- */

function Tabelinha({
  titulo,
  legenda,
  linhas,
  rotuloCol,
}: {
  titulo: string;
  legenda: string;
  rotuloCol: string;
  linhas: { rotulo: string; contas: number; assinantes: number; receitaCents?: number }[];
}) {
  if (!linhas.length) return null;
  return (
    <div className={CARD}>
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h3 className="text-sm font-medium text-gray-200">{titulo}</h3>
        <span className="text-[11px] text-gray-500">{legenda}</span>
      </div>
      <div className="overflow-x-auto mt-3">
        <table className="w-full text-xs min-w-[420px]">
          <thead>
            <tr className="text-gray-500 text-[11px]">
              <th className="text-left font-normal pb-2">{rotuloCol}</th>
              <th className="text-right font-normal pb-2">Assinantes / contas</th>
              <th className="text-right font-normal pb-2">Taxa</th>
              <th className="text-right font-normal pb-2">Receita</th>
            </tr>
          </thead>
          <tbody>
            {linhas.map((l) => (
              <tr key={l.rotulo} className="border-t border-gray-800/50">
                <td className="py-1.5 text-gray-300 align-top break-all">
                  {l.rotulo}
                </td>
                <td className="py-1.5 text-right text-gray-100 tabular-nums align-top whitespace-nowrap">
                  {num(l.assinantes)}
                  <span className="text-gray-600">/{num(l.contas)}</span>
                </td>
                <td className="py-1.5 text-right tabular-nums align-top">
                  <Taxa acertos={l.assinantes} base={l.contas} />
                </td>
                <td className="py-1.5 text-right text-gray-500 tabular-nums align-top">
                  {l.receitaCents ? brl(l.receitaCents) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * A série semanal, por semana de CADASTRO.
 *
 * As duas últimas semanas do gráfico são sempre baixas por construção — quem se
 * cadastrou anteontem não teve os {janela} dias de chance. Por isso a coorte só
 * vai até `coorteAte`, e por isso a série não passa dessa data.
 */
function SerieSemanal({ painel }: { painel: PainelDeCanais }) {
  const topo = painel.canais
    .filter((c) => c.contas >= PISO_DO_CANAL)
    .sort((a, b) => b.contas - a.contas)
    .slice(0, 5)
    .map((c) => c.canal);
  if (!topo.length) return null;

  const semanas = [...new Set(painel.semanal.map((p) => p.semana))].sort();
  const achar = (semana: string, canal: string) =>
    painel.semanal.find((p) => p.semana === semana && p.canal === canal);

  return (
    <div className={CARD}>
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h3 className="text-sm font-medium text-gray-200">
          O canal está melhorando ou piorando?
        </h3>
        <span className="text-[11px] text-gray-500">
          por semana de cadastro · assinantes/contas
        </span>
      </div>
      <p className="text-xs text-gray-500 mt-1 leading-relaxed">
        Semanas de cadastro fechadas, não janela móvel: uma janela que anda
        mistura coortes e faz o número se mexer sem nada ter mudado no produto.
      </p>
      <div className="overflow-x-auto mt-3">
        <table className="w-full text-xs min-w-[520px]">
          <thead>
            <tr className="text-gray-500 text-[11px]">
              <th className="text-left font-normal pb-2">Semana</th>
              {topo.map((c) => (
                <th key={c} className="text-right font-normal pb-2 whitespace-nowrap">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {semanas.map((s) => (
              <tr key={s} className="border-t border-gray-800/50">
                <td className="py-1.5 text-gray-400 tabular-nums whitespace-nowrap">
                  {s.split("-").reverse().slice(0, 2).join("/")}
                </td>
                {topo.map((c) => {
                  const p = achar(s, c);
                  return (
                    <td
                      key={c}
                      className="py-1.5 text-right tabular-nums whitespace-nowrap"
                    >
                      {!p || p.contas === 0 ? (
                        <span className="text-gray-700">—</span>
                      ) : (
                        <>
                          <span className="text-gray-100">{num(p.assinantes)}</span>
                          <span className="text-gray-600">/{num(p.contas)}</span>
                        </>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- como ler ----- */

function ComoLer({ painel }: { painel: PainelDeCanais }) {
  return (
    <details className={CARD}>
      <summary className="text-sm font-medium text-gray-300 cursor-pointer">
        Como ler os canais
      </summary>
      <div className="text-xs text-gray-400 mt-3 space-y-2 leading-relaxed">
        <p>
          <strong>O universo</strong> são as contas criadas entre{" "}
          {painel.coorteDe.split("-").reverse().join("/")} e{" "}
          {painel.coorteAte.split("-").reverse().join("/")} — e não as pessoas
          expostas ao teste de preço. São dois recortes diferentes com dois
          relógios diferentes, e as taxas de uma seção não se comparam com as da
          outra.
        </p>
        <p>
          <strong>A janela é de {painel.janelaDias} dias.</strong> Assinante aqui
          é quem pagou pelo menos uma fatura de assinatura dentro de{" "}
          {painel.janelaDias} dias do cadastro. Contas criadas há menos que isso
          ficam fora de toda taxa — senão um canal que cresceu na semana passada
          apareceria pior do que é só por ter contas mais novas.
        </p>
        <p>
          <strong>O canal é o da primeira visita</strong> da conta, não o da
          última. Quem clicou num anúncio e voltou pelo Google semanas depois
          conta como o anúncio. É a leitura que responde &ldquo;quem trouxe essa
          pessoa&rdquo;; a outra responderia &ldquo;quem fechou&rdquo;, e para
          decidir orçamento de aquisição a primeira é a que importa.
        </p>
        <p>
          <strong>Receita por conta é a régua</strong>, e ela é taxa × ticket.
          Número de assinantes não serve: depende de quanto se comprou de
          tráfego, que é decisão de orçamento e não qualidade do canal.
        </p>
        <p>
          <strong>&ldquo;Chegou ao plugin&rdquo;</strong> quer dizer que a conta
          registrou pelo menos um evento vindo do plugin (SketchUp ou Revit).
          Instalar e nunca abrir não conta. A divisão é exaustiva: web + plugin
          fecha com o total de contas do canal.
        </p>
        <p>
          <strong>A faixa embaixo da taxa</strong> é o intervalo de Wilson. Quando
          ela é mais larga que a própria taxa, o número aparece em cinza: é um
          número verdadeiro e uma informação inútil. Abaixo de {PISO_DO_CANAL}{" "}
          contas não existe taxa nenhuma, só o par assinantes/contas e um traço —
          mesmo piso das coortes do experimento, e pelo mesmo motivo.
        </p>
        <p>
          <strong>Onde esta tela subconta.</strong> Quem viu o anúncio no celular
          e se cadastrou no desktop tem os dois toques separados, e o do celular
          nunca é ligado à conta — o vínculo só acontece no login. Isso{" "}
          <em>subestima</em> mídia paga e <em>superestima</em> &ldquo;Direto&rdquo;.
          É piso, não retrato. Na mesma linha: a série de eventos começa em
          20/06/2026, então quem apareceu antes disso não tem primeiro toque
          observável.
        </p>
        <p>
          <strong>Enquanto o teste de preço roda</strong>, parte destas contas viu
          um preço e parte viu outro. O sorteio é independente do canal, então
          isso adiciona ruído e não viés — mas a conversão absoluta de um canal
          aqui é uma mistura de dois preços.
        </p>
      </div>
    </details>
  );
}

/* --------------------------------------------------- canal x braço A/B ---- */

/** Origem que o cruzamento não consegue nomear, e os dois motivos disso. */
const SEM_ORIGEM = "Origem desconhecida";

type CelulaAB = { expostos: number; compradores: number };

/**
 * O canal funciona melhor em algum braço do teste de preço?
 *
 * A cobertura aqui é MUITO menor que a do resto da seção, e a tela precisa
 * dizer isso antes de qualquer número: a origem só existe para quem se
 * cadastrou depois de 27/06, e a maior parte de quem foi exposto ao preço tem
 * conta mais velha que isso. Medido em 19/08: 654 de 1.544 expostos (42%).
 * O resto não é "veio de lugar nenhum" — é conta anterior à série de eventos.
 *
 * O denominador é `experiment_exposures`, e não o `pricing_arm` que existe nos
 * eventos do ClickHouse. Os dois parecem a mesma coisa e não são: um é o braço
 * que o front resolveu, o outro é a exposição registrada quando o preço
 * apareceu na tela. Trocar um pelo outro ja me fez reportar um bug que era meu.
 */
function CanalPorBraco({
  exposicoes,
  canalDoUsuario,
  controlAudience,
  variantAudience,
}: {
  exposicoes: Exposicoes;
  canalDoUsuario: Map<string, string>;
  controlAudience: string;
  variantAudience: string;
}) {
  if (!exposicoes.usuarios.length) return null;

  const bracos = [controlAudience, variantAudience];
  const grade = new Map<string, Map<string, CelulaAB>>();
  let comOrigem = 0;

  for (const u of exposicoes.usuarios) {
    const conhecido = canalDoUsuario.get(u.userId);
    /* Duas ausências diferentes caem no mesmo balde de propósito: quem não está
       no mapa tem conta anterior à série, e quem está como "Sem rastro" tem
       conta nova sem nenhum evento. Para ESTA pergunta as duas respondem a
       mesma coisa — não sei de onde veio — e separá-las daria duas linhas que
       ninguém consegue acionar. */
    const canal = conhecido && conhecido !== SEM_RASTRO ? conhecido : SEM_ORIGEM;
    if (canal !== SEM_ORIGEM) comOrigem += 1;
    const linha = grade.get(canal) ?? new Map<string, CelulaAB>();
    const cel = linha.get(u.arm) ?? { expostos: 0, compradores: 0 };
    cel.expostos += 1;
    if (u.comprou) cel.compradores += 1;
    linha.set(u.arm, cel);
    grade.set(canal, linha);
  }

  const celula = (canal: string, arm: string): CelulaAB =>
    grade.get(canal)?.get(arm) ?? { expostos: 0, compradores: 0 };

  const totalDoCanal = (canal: string) =>
    bracos.reduce((t, arm) => t + celula(canal, arm).expostos, 0);

  const canais = [...grade.keys()]
    .filter((c) => c !== SEM_ORIGEM)
    .sort((a, b) => totalDoCanal(b) - totalDoCanal(a));

  /* Escala COMPARTILHADA entre os dois braços: escalas separadas fariam o A
     empatado parecer tão escuro quanto o B. Mesma decisão da MatrizCoortes. */
  let taxaMax = 0;
  for (const canal of canais)
    for (const arm of bracos) {
      const c = celula(canal, arm);
      if (c.expostos >= PISO_DO_CANAL)
        taxaMax = Math.max(taxaMax, c.compradores / c.expostos);
    }

  const total = exposicoes.usuarios.length;
  const dias = exposicoes.desde
    ? Math.max(1, (Date.now() - Date.parse(exposicoes.desde)) / 86400000)
    : null;
  const semOrigem = total - comOrigem;

  const Cel = ({ canal, arm }: { canal: string; arm: string }) => {
    const c = celula(canal, arm);
    const comBase = c.expostos >= PISO_DO_CANAL;
    const p = comBase && taxaMax > 0 ? c.compradores / c.expostos / taxaMax : 0;
    return (
      <td
        className={`py-1.5 px-2 text-right tabular-nums ${
          c.expostos === 0
            ? "text-gray-700"
            : comBase
              ? "text-gray-100"
              : "text-gray-500"
        }`}
        style={{
          background: comBase
            ? `rgba(99,102,241,${0.12 + p * 0.6})`
            : "transparent",
        }}
        title={
          c.expostos === 0
            ? "ninguém exposto"
            : comBase
              ? `${taxa(c.compradores / c.expostos)} de conversão`
              : `menos de ${PISO_DO_CANAL} expostos — sem taxa`
        }
      >
        {c.expostos === 0 ? "—" : `${c.compradores}/${c.expostos}`}
      </td>
    );
  };

  const prontos = canais.filter((c) =>
    bracos.every((arm) => celula(c, arm).expostos >= PISO_DO_CANAL),
  );
  const faltando = canais
    .filter((c) => !prontos.includes(c))
    .map((c) => {
      const menor = Math.min(...bracos.map((arm) => celula(c, arm).expostos));
      /* O ritmo sai dos dados, não de uma constante: quantos expostos por dia
         POR BRAÇO este canal vem trazendo. */
      const ritmo = dias ? totalDoCanal(c) / dias / bracos.length : 0;
      const eta = ritmo > 0 ? Math.ceil((PISO_DO_CANAL - menor) / ritmo) : null;
      return { canal: c, eta };
    })
    .filter((x) => x.eta !== null && x.eta <= 60)
    .slice(0, 3);

  return (
    <div className={CARD}>
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h3 className="text-sm font-medium text-gray-200">
          Canal × braço do teste de preço
        </h3>
        <span className="text-[11px] text-gray-500">
          taxa a partir de {PISO_DO_CANAL} expostos por braço
        </span>
      </div>
      <p className="text-xs text-gray-500 mt-1 leading-relaxed">
        A pergunta natural — &ldquo;o preço menor funciona melhor em algum
        canal?&rdquo; — ainda não tem resposta, e o motivo não é só o tamanho da
        amostra.{" "}
        <span className="text-gray-300">
          {num(comOrigem)} dos {num(total)} expostos (
          {taxa(total > 0 ? comOrigem / total : 0)})
        </span>{" "}
        têm origem conhecida; os outros {num(semOrigem)} criaram a conta antes de
        a série de eventos existir e não têm primeiro toque observável. Quebrar
        essa metade por canal <em>e</em> por braço deixa quase toda célula abaixo
        do piso.
      </p>

      <div className="overflow-x-auto mt-3">
        <table className="text-xs min-w-[440px] w-full">
          <thead>
            <tr className="text-gray-500 text-[11px]">
              <th className="text-left font-normal pb-2" />
              <th className="text-right font-normal pb-2 px-2">A · controle</th>
              <th className="text-right font-normal pb-2 px-2">B · variante</th>
              <th className="text-right font-normal pb-2 w-16">B ÷ A</th>
            </tr>
          </thead>
          <tbody>
            {canais.map((canal) => {
              const a = celula(canal, controlAudience);
              const b = celula(canal, variantAudience);
              const ta =
                a.expostos >= PISO_DO_CANAL ? a.compradores / a.expostos : null;
              const tb =
                b.expostos >= PISO_DO_CANAL ? b.compradores / b.expostos : null;
              const razao = ta !== null && tb !== null && ta > 0 ? tb / ta : null;
              return (
                <tr key={canal} className="border-t border-gray-800/50">
                  <td className="py-1.5 text-gray-300 whitespace-nowrap">
                    {canal}
                  </td>
                  <Cel canal={canal} arm={controlAudience} />
                  <Cel canal={canal} arm={variantAudience} />
                  <td className="py-1.5 text-right text-gray-500 tabular-nums">
                    {razao === null
                      ? "—"
                      : `${razao.toFixed(1).replace(".", ",")}x`}
                  </td>
                </tr>
              );
            })}
            <tr className="border-t border-gray-800/50 text-gray-600">
              <td className="py-1.5">{SEM_ORIGEM}</td>
              <Cel canal={SEM_ORIGEM} arm={controlAudience} />
              <Cel canal={SEM_ORIGEM} arm={variantAudience} />
              <td className="py-1.5 text-right">—</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-gray-500 mt-3 leading-relaxed">
        {prontos.length === 0
          ? "Nenhum canal passou do piso nos dois braços ainda"
          : prontos.length === canais.length
            ? "Todos os canais com origem conhecida já têm base nos dois braços"
            : `${listar(prontos)} ${
                prontos.length === 1 ? "já tem" : "já têm"
              } base nos dois braços`}
        {faltando.length > 0 && (
          <>
            {". No ritmo atual, "}
            {listar(
              faltando.map(
                (f) =>
                  `${f.canal} chega em ~${f.eta} ${f.eta === 1 ? "dia" : "dias"}`,
              ),
            )}
          </>
        )}
        . Antes disso, não olhe para as células cinzas: uma taxa sobre seis
        pessoas se move dezessete pontos com o próximo comprador.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------- a seção ---- */

export function SecaoCanais({
  painel,
  exposicoes,
  canalDoUsuario,
  controlAudience,
  variantAudience,
  cruzamentoErro,
}: {
  painel: PainelDeCanais;
  exposicoes?: Exposicoes | null;
  canalDoUsuario?: Map<string, string> | null;
  controlAudience?: string;
  variantAudience?: string;
  cruzamentoErro?: string | null;
}) {
  const campanhas = painel.campanhas
    .filter((c) => c.contas >= PISO_DO_CANAL)
    .slice(0, 12)
    .map((c) => ({
      rotulo: `${c.canal} · ${c.campanha}`,
      contas: c.contas,
      assinantes: c.assinantes,
      receitaCents: c.receitaCents,
    }));

  const simples = (linhas: typeof painel.dispositivos) =>
    linhas
      .filter((l) => l.contas >= PISO_DO_CANAL)
      .map((l) => ({
        rotulo: l.chave,
        contas: l.contas,
        assinantes: l.assinantes,
        receitaCents: l.receitaCents,
      }));

  return (
    <section id="aquisicao" className="scroll-mt-4 space-y-4 pt-6">
      <div className="border-t border-gray-800/50 pt-6">
        <h2 className="text-lg font-semibold text-gray-100">
          Aquisição — de onde vêm os assinantes
        </h2>
        <p className="text-xs text-gray-500 mt-1 leading-relaxed">
          {num(painel.totais.contasTodas)} contas criadas desde{" "}
          {painel.coorteDe.split("-").reverse().join("/")} e o que elas fizeram
          desde então.{" "}
          <span className="text-gray-400">Daqui para baixo o universo é outro</span>
          : conta criada, não pessoa exposta a um preço. Nada nesta seção depende
          do teste de preço, e as taxas de cima não se comparam com as de baixo.
        </p>
      </div>

      <VereditoCanais painel={painel} />
      <TabelaDeCanais painel={painel} />
      <CanalXPlugin painel={painel} />

      {!!exposicoes &&
      !!canalDoUsuario &&
      !!controlAudience &&
      !!variantAudience ? (
        <CanalPorBraco
          exposicoes={exposicoes}
          canalDoUsuario={canalDoUsuario}
          controlAudience={controlAudience}
          variantAudience={variantAudience}
        />
      ) : (
        /* Uma linha, e não o nada de antes: bloco que some sem dizer nada é
           indistinguível de bloco que nunca foi escrito — e foi exatamente
           isso que me travou o diagnóstico no primeiro deploy. */
        <div className={`${CARD} text-[11px] text-gray-500`}>
          <span className="text-gray-400">Canal × braço do teste de preço</span> —
          não deu para cruzar agora
          {cruzamentoErro ? (
            <span className="font-mono text-gray-600 break-all"> ({cruzamentoErro})</span>
          ) : (
            <> (nenhuma exposição com origem conhecida no período)</>
          )}
          . O resto da seção não depende disso.
        </div>
      )}

      <Tabelinha
        titulo="Qual campanha traz cadastro que assina"
        legenda={`campanhas com pelo menos ${PISO_DO_CANAL} contas`}
        rotuloCol="Canal · campanha"
        linhas={campanhas}
      />

      <SerieSemanal painel={painel} />

      <Tabelinha
        titulo="Dispositivo do primeiro toque"
        legenda="serve para descartar, não para explicar"
        rotuloCol="Dispositivo"
        linhas={simples(painel.dispositivos)}
      />

      <Tabelinha
        titulo="Por qual porta a pessoa entrou"
        legenda="domínio da primeira página vista"
        rotuloCol="Página de entrada"
        linhas={simples(painel.landings)}
      />

      <ComoLer painel={painel} />
    </section>
  );
}

/**
 * O erro NÃO some em silêncio — e aqui eu divirjo do funil e das coortes de
 * propósito.
 *
 * Naqueles dois, `catch { = null }` e o bloco desaparece, o que é aceitável
 * para um diagnóstico do experimento. Este bloco responde a pergunta principal
 * da tela; um bloco ausente se lê como "não tem dado", e alguém decidiria
 * orçamento com base numa ausência. A última frase existe para ninguém achar
 * que a tela inteira caiu.
 */
export function CanaisIndisponiveis({ motivo }: { motivo: string }) {
  return (
    <section id="aquisicao" className="scroll-mt-4 pt-6">
      <div className={`${CARD} border-red-500/40`}>
        <p className="text-sm text-red-300 font-medium">
          Não consegui montar a leitura por canal.
        </p>
        <p className="text-xs text-gray-500 mt-1 font-mono break-all">{motivo}</p>
        <p className="text-xs text-gray-500 mt-2">
          Os números estariam errados, então não mostro nenhum. O teste de preço,
          acima, não depende desta consulta e continua válido.
        </p>
      </div>
    </section>
  );
}
