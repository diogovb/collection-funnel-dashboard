import { NextResponse } from "next/server";
import { queryMetabase, sqlLiteral } from "@/lib/metabase";

/**
 * Quem se cadastrou no período e DEPOIS baixou algo de dentro do plugin.
 *
 * É a pergunta de ativação: o produto quer que a pessoa saia da web e vá para
 * o plugin. O cadastro a gente já sabe de onde veio (`surface` no funil); o
 * que faltava era o outro lado — quem se cadastrou na web, instalou o plugin
 * e passou a baixar por lá.
 *
 * Devolve só os e-mails. Quem cruza com as jornadas é o dashboard, para a
 * porcentagem cair sobre a MESMA base dos cards vizinhos.
 *
 * Por que não é evento no funil: são 12 a 16 mil downloads por dia. A página
 * carrega todos os eventos do período em memória e agrega no cliente — 90
 * dias disso seria mais de um milhão de linhas a cada refresh.
 */

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
 *  existe. Referenciá-la direto faz o Postgres recusar a query inteira
 *  ("column surface does not exist"), e esta rota sobe antes da migration.
 *  Pelo jsonb, coluna ausente vira NULL e o fallback do scopeId assume —
 *  quando a coluna nascer, o ramo explícito passa a valer sozinho, sem
 *  precisar mexer aqui. */
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
)
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
)`;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const de = searchParams.get("from");
    const ate = searchParams.get("to");

    if (!de || !ate) {
      return NextResponse.json(
        { error: "Informe from e to (ISO)" },
        { status: 400 },
      );
    }
    /* Datas entram por interpolação, então não podem ser texto livre. */
    if (Number.isNaN(Date.parse(de)) || Number.isNaN(Date.parse(ate))) {
      return NextResponse.json({ error: "Datas inválidas" }, { status: 400 });
    }

    const linhas = await queryMetabase<{ email: string }>(
      montarSql(new Date(de).toISOString(), new Date(ate).toISOString()),
    );

    return NextResponse.json({
      emails: linhas.map((l) => l.email).filter(Boolean),
    });
  } catch (error) {
    console.error("Erro em plugin-activation:", error);
    return NextResponse.json(
      { error: "Erro ao consultar ativação no plugin" },
      { status: 500 },
    );
  }
}
