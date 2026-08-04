/**
 * Ponte para o Postgres de produção da Collection.
 *
 * A Vercel não alcança o banco direto — o caminho é o Metabase, que expõe
 * `/api/dataset` para SQL nativo. Extraído de `api/sync-downloads/route.ts`,
 * onde vivia privado, quando a rota de ativação no plugin passou a precisar
 * do mesmo acesso.
 *
 * A chave sai de `METABASE_API_KEY` quando existir, com o valor antigo como
 * fallback para não quebrar o deploy atual enquanto a env não é configurada.
 */
const METABASE_URL = process.env.METABASE_URL ?? "https://metabase.collection.com.br";
const METABASE_API_KEY =
  process.env.METABASE_API_KEY ?? "mb_HCdbdyTeP9uQMmbIndq4p1Il1ZXsRWeEavGejy2vitU=";

/** Collection PostgreSQL — PROD. */
const DATABASE_ID = 10;

export async function queryMetabase<T = Record<string, unknown>>(
  sql: string,
): Promise<T[]> {
  const res = await fetch(`${METABASE_URL}/api/dataset`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": METABASE_API_KEY,
    },
    body: JSON.stringify({
      database: DATABASE_ID,
      type: "native",
      native: { query: sql },
    }),
  });
  const data = await res.json();
  if (!data.data?.rows) {
    /* Sem isto, SQL inválido vira "zero linhas" e o card mostra 0 como se
       fosse a verdade. Foi o que aconteceu quando a query citava uma coluna
       que ainda não existia. */
    if (data?.error) console.error("Metabase recusou a query:", data.error);
    return [];
  }
  const cols = data.data.cols.map((c: { name: string }) => c.name);
  return data.data.rows.map((row: unknown[]) => {
    const obj: Record<string, unknown> = {};
    cols.forEach((col: string, i: number) => (obj[col] = row[i]));
    return obj as T;
  });
}

/** Aspas simples escapadas para interpolar string em SQL nativo. */
export function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
