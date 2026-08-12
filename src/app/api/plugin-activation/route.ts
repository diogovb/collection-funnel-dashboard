import { NextResponse } from "next/server";
import { queryMetabaseRaw, sqlLiteral, METABASE_ROW_CAP } from "@/lib/metabase";

/**
 * Quem se cadastrou no período e DEPOIS baixou algo de dentro do plugin.
 *
 * É a pergunta de ativação: o produto quer que a pessoa saia da web e vá para
 * o plugin. O cadastro a gente já sabe de onde veio (`surface` no funil); o
 * que faltava era o outro lado — quem se cadastrou na web, instalou o plugin
 * e passou a baixar por lá.
 *
 * Devolve o TOTAL e a lista de e-mails. Quem cruza com as jornadas é o
 * dashboard, para a porcentagem cair sobre a MESMA base dos cards vizinhos.
 *
 * Por que não é evento no funil: são 12 a 16 mil downloads por dia. A página
 * carrega todos os eventos do período em memória e agrega no cliente — 90
 * dias disso seria mais de um milhão de linhas a cada refresh.
 */

/**
 * O DIA EM QUE A RÉGUA NASCEU.
 *
 * `product_download."scopeId"` é o único marcador de plugin que existe no
 * legado, e ele é **100% nulo até 30/07/2026**: na semana de 06/07 são 80 mil
 * downloads e zero com scopeId; na de 27/07 ele aparece pela metade; a partir
 * de 03/08 é 99,9%. Toda janela que começa antes desta data devolve um número
 * que é **piso, não verdade** — quem usou o plugin em julho e parou é
 * indistinguível de quem nunca abriu. Medido em 11/08/2026.
 */
const VALIDO_DESDE = "2026-07-31T00:00:00.000Z";

/** O período filtra o CADASTRO, não o download — quem se cadastrou hoje e
 *  ativar amanhã tem que contar. Por isso o EXISTS não tem janela.
 *
 *  As duas CTEs são MATERIALIZED de propósito. Sem isso o planner acha que
 *  vale a pena "des-correlacionar" o EXISTS e constrói um hash das 5,7
 *  milhões de linhas de product_download, com 512 batches em disco. Com elas,
 *  ele percorre as poucas centenas de vínculos e usa o índice
 *  product_download_userOnOfficeId_scopeId_createdAt_idx: medido, 1 dia caiu
 *  de 1.099ms para 177ms.
 *
 *  `to_jsonb(pd) ->> 'surface'` e não `pd.surface`: a coluna ainda não
 *  existe (reconferido em 11/08 no information_schema). Referenciá-la direto
 *  faz o Postgres recusar a query inteira ("column surface does not exist").
 *  Pelo jsonb, coluna ausente vira NULL e o fallback do scopeId assume —
 *  quando a coluna nascer, o ramo explícito passa a valer sozinho, sem
 *  precisar mexer aqui.
 *
 *  O `count(*) OVER ()` sai de uma CTE que JÁ está distinta, então ele conta
 *  pessoas e não linhas. É o que salva a contagem do teto de 2.000 do
 *  Metabase: a lista pode voltar cortada, o total não. */
function montarSql(de: string, ate: string): string {
  return `
WITH novos AS MATERIALIZED (
  SELECT id, lower(email) AS email
  FROM "user"
  WHERE "createdAt" >= ${sqlLiteral(de)} AND "createdAt" < ${sqlLiteral(ate)}
),
vinculos AS MATERIALIZED (
  SELECT uo.id AS uo_id, n.email
  FROM novos n
  JOIN user_on_office uo ON uo."userId" = n.id
),
ativos AS (
  SELECT DISTINCT v.email
  FROM vinculos v
  WHERE EXISTS (
    SELECT 1 FROM product_download pd
    WHERE pd."userOnOfficeId" = v.uo_id
      AND (
        -- explícito: o front passou a mandar a superfície
        (to_jsonb(pd) ->> 'surface') LIKE 'plugin%'
        -- inferido: histórico, quando só existia o scopeId. Ele guarda o id do
        -- arquivo do SketchUp; o literal 'web' é a ausência dele.
        OR ((to_jsonb(pd) ->> 'surface') IS NULL
            AND pd."scopeId" IS NOT NULL AND pd."scopeId" <> 'web')
      )
  )
)
SELECT email, count(*) OVER () AS total FROM ativos`;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const de = searchParams.get("from");
  const ate = searchParams.get("to");

  if (!de || !ate) {
    return NextResponse.json({ error: "Informe from e to (ISO)" }, { status: 400 });
  }
  /* Datas entram por interpolação, então não podem ser texto livre. */
  if (Number.isNaN(Date.parse(de)) || Number.isNaN(Date.parse(ate))) {
    return NextResponse.json({ error: "Datas inválidas" }, { status: 400 });
  }

  try {
    const { rows, noTeto } = await queryMetabaseRaw<{
      email: string;
      total: number;
    }>(montarSql(new Date(de).toISOString(), new Date(ate).toISOString()));

    return NextResponse.json({
      /* Zero linhas é zero ativação — não tem `total` para ler. */
      total: rows.length ? Number(rows[0].total) : 0,
      emails: rows.map((l) => l.email).filter(Boolean),
      /* A lista veio cortada; o total acima continua certo. */
      truncado: noTeto,
      listaLimitadaA: METABASE_ROW_CAP,
      /* Janela que atravessa o nascimento da régua: o número é piso. */
      parcial: Date.parse(de) < Date.parse(VALIDO_DESDE),
      validoDesde: VALIDO_DESDE,
    });
  } catch (error) {
    console.error("Erro em plugin-activation:", error);
    /* 502 e não 200-com-zero: o dashboard precisa distinguir "ninguém ativou"
       de "não consegui perguntar". */
    return NextResponse.json(
      { error: "Erro ao consultar ativação no plugin", detalhe: String(error) },
      { status: 502 },
    );
  }
}
