import { NextRequest, NextResponse } from "next/server";
import { clickhouseConfigurado, ClickHouseNaoConfigurado } from "@/lib/clickhouse";
import { carregarCanais, JANELA_PADRAO } from "@/lib/canais";

/**
 * O mesmo painel de canais que a tela mostra, em JSON.
 *
 * Existe para a leitura ser CONFERÍVEL sem depender do render: a query cruza
 * quatro tabelas de dois bancos, e quando um número parecer errado a pergunta
 * "é a query ou é o componente?" precisa ter resposta em um curl.
 *
 * Só agregados: nenhuma pessoa, nenhum e-mail, nenhum uuid — mesma postura de
 * `api/plugin-metrics`, e por isso esta rota não precisa cruzar com o Supabase
 * do funil nem com o legado.
 */

export const revalidate = 300;
/* A query varre ~60 dias de eventos. O ClickHouse mata em 45 s (o teto vive no
   `chQuery`) e o fetch aborta em 55 s; sem este 60 a função morreria antes dos
   dois e o erro apontaria para o lugar errado. */
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!clickhouseConfigurado()) {
    /* 503 e não 500: não é defeito, é configuração ausente. A mensagem diz o
       nome das envs porque o sintoma (bloco some) não aponta para a causa. */
    return NextResponse.json(
      {
        error: "ClickHouse não configurado",
        detalhe: new ClickHouseNaoConfigurado().message,
      },
      { status: 503 },
    );
  }

  const bruto = Number(req.nextUrl.searchParams.get("janela"));
  const janela = Number.isFinite(bruto) && bruto > 0 ? bruto : JANELA_PADRAO;

  try {
    return NextResponse.json(await carregarCanais(janela));
  } catch (error) {
    console.error("Erro em canais:", error);
    return NextResponse.json(
      { error: "Erro ao consultar o ClickHouse", detalhe: String(error) },
      { status: 502 },
    );
  }
}
