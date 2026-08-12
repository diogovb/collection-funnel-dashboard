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

/**
 * `/api/dataset` corta em 2.000 linhas **em silêncio**: devolve 200, sem aviso
 * nenhum no corpo. Uma consulta que passa disso volta exatamente neste número,
 * e é assim que se detecta — não existe outro sinal.
 */
export const METABASE_ROW_CAP = 2000;

/** Consulta lenta que trava é bug; consulta lenta que pendura a rota é pior. */
const TIMEOUT_MS = 60_000;

export class MetabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetabaseError";
  }
}

/**
 * Devolve as linhas E se a resposta encostou no teto.
 *
 * Quem precisa de contagem confiável **agrega no SQL** e lê uma linha só; esta
 * função é para quem realmente quer a lista.
 */
export async function queryMetabaseRaw<T = Record<string, unknown>>(
  sql: string,
): Promise<{ rows: T[]; noTeto: boolean }> {
  let res: Response;
  try {
    res = await fetch(`${METABASE_URL}/api/dataset`, {
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
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (erro) {
    throw new MetabaseError(`Metabase inalcançável: ${String(erro)}`);
  }

  const data = await res.json().catch(() => null);

  if (!data?.data?.rows) {
    /* ANTES isto devolvia `[]`, e o card mostrava 0 como se fosse a verdade —
       foi o que aconteceu quando a query citava uma coluna que ainda não
       existia. Erro tem que subir: quem chama decide o que mostrar, e "não
       sei" nunca pode virar "zero". */
    const erro = data?.error ?? `HTTP ${res.status}`;
    throw new MetabaseError(`Metabase recusou a query: ${erro}`);
  }

  const cols = data.data.cols.map((c: { name: string }) => c.name);
  const rows: T[] = data.data.rows.map((row: unknown[]) => {
    const obj: Record<string, unknown> = {};
    cols.forEach((col: string, i: number) => (obj[col] = row[i]));
    return obj as T;
  });

  return { rows, noTeto: rows.length === METABASE_ROW_CAP };
}

export async function queryMetabase<T = Record<string, unknown>>(
  sql: string,
): Promise<T[]> {
  const { rows, noTeto } = await queryMetabaseRaw<T>(sql);
  if (noTeto) {
    console.warn(
      `Metabase devolveu exatamente ${METABASE_ROW_CAP} linhas — provavelmente truncado.`,
    );
  }
  return rows;
}

/** Aspas simples escapadas para interpolar string em SQL nativo. */
export function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
