/**
 * Ponte de LEITURA para o ClickHouse de produção (pipeline `track-events`).
 *
 * ⚠️ SÓ DO SERVIDOR. Sem o pacote `server-only` (não está nas dependências e
 * não vou acrescentar uma por causa disto), o que segura a regra é o uso:
 * importar apenas de Route Handlers. Um `"use client"` importando este arquivo
 * mandaria a senha do ClickHouse para o bundle — `Buffer` nem existe lá, então
 * quebra em desenvolvimento antes de vazar, mas a regra vale por escrito.
 *
 * Por que ele e não o legado: `properties.platform` (`sketchup` | `revit` |
 * `web`) existe em **todo** evento desde junho/2026, enquanto o único marcador
 * de plugin do Postgres (`product_download."scopeId"`) só passou a ser gravado
 * em 31/07 — ver a constante `VALIDO_DESDE` em `api/plugin-activation`. Sem o
 * ClickHouse não existe série histórica comparável, e "o plugin está
 * crescendo?" fica sem resposta.
 *
 * Credencial só por env, de propósito. Este repositório já tem chave do
 * Metabase e service-role do Supabase escritas no fonte (dívida a pagar à
 * parte); não vou acrescentar mais uma — e sem env é melhor o painel dizer
 * que não sabe do que inventar zero.
 */

export class ClickHouseNaoConfigurado extends Error {
  constructor() {
    super(
      "Faltam as envs CLICKHOUSE_URL / CLICKHOUSE_USER / CLICKHOUSE_PASSWORD (e CLICKHOUSE_DB).",
    );
    this.name = "ClickHouseNaoConfigurado";
  }
}

export class ClickHouseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClickHouseError";
  }
}

/**
 * Lê a env tirando aspas que vieram junto no copiar-e-colar.
 *
 * No `.env` do backend — que é de onde estes quatro valores saem — eles estão
 * escritos COM aspas (`CLICKHOUSE_URL="https://…"`). O dotenv tira; o painel da
 * Vercel, não: lá o campo é literal e a aspa vira parte do valor. O estrago é
 * desproporcional ao erro — `new URL('"https://…"')` lança "Invalid URL", e a
 * senha com aspas dá 401 do ClickHouse, dois sintomas que não apontam para a
 * causa. Aparar aqui custa uma linha e mata a classe inteira.
 */
function env(nome: string): string | undefined {
  const bruto = process.env[nome];
  if (!bruto) return undefined;
  /* Sem a flag `s`: o target deste tsconfig é anterior a es2018 e o compilador
     recusa (TS1501). Valor de env com quebra de linha no meio não é caso real. */
  const limpo = bruto.trim().replace(/^(['"])(.*)\1$/, "$2");
  return limpo || undefined;
}

export function clickhouseConfigurado(): boolean {
  return Boolean(env("CLICKHOUSE_URL") && env("CLICKHOUSE_USER") && env("CLICKHOUSE_PASSWORD"));
}

/** Teto no servidor, para consulta pesada morrer lá e não pendurar a rota. */
const MAX_EXECUTION_SECONDS = 45;

export async function chQuery<T = Record<string, unknown>>(
  sql: string,
): Promise<T[]> {
  if (!clickhouseConfigurado()) throw new ClickHouseNaoConfigurado();

  const url = new URL(env("CLICKHOUSE_URL") as string);
  /* Fallback `collection`, e não `default`: a base padrão do ClickHouse não tem
     `events_distributed`, então esquecer a env daria "tabela não existe" — erro
     verdadeiro, mas que manda procurar no lugar errado. */
  url.searchParams.set("database", env("CLICKHOUSE_DB") || "collection");
  url.searchParams.set("max_execution_time", String(MAX_EXECUTION_SECONDS));

  /* `FORMAT JSON` entra aqui para o chamador não precisar lembrar. */
  const body = /format\s+json\s*;?\s*$/i.test(sql.trim())
    ? sql
    : `${sql.trim().replace(/;\s*$/, "")} FORMAT JSON`;

  const auth = Buffer.from(
    `${env("CLICKHOUSE_USER")}:${env("CLICKHOUSE_PASSWORD")}`,
  ).toString("base64");

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "text/plain" },
      body,
      signal: AbortSignal.timeout((MAX_EXECUTION_SECONDS + 10) * 1000),
    });
  } catch (erro) {
    throw new ClickHouseError(`ClickHouse inalcançável: ${String(erro)}`);
  }

  const texto = await res.text();
  if (!res.ok) {
    throw new ClickHouseError(`ClickHouse ${res.status}: ${texto.slice(0, 400)}`);
  }
  try {
    return JSON.parse(texto).data as T[];
  } catch {
    throw new ClickHouseError(`Resposta não-JSON: ${texto.slice(0, 200)}`);
  }
}

/**
 * Data no formato do ClickHouse, validada.
 *
 * Tudo que entra em SQL aqui é data; nada de texto livre. Se algum dia entrar,
 * usar os `param_*` do protocolo HTTP em vez de interpolar.
 */
export function chDate(valor: string): string {
  const iso = new Date(valor);
  if (Number.isNaN(iso.getTime())) throw new ClickHouseError(`Data inválida: ${valor}`);
  return `'${iso.toISOString().slice(0, 10)}'`;
}

/**
 * `properties` é uma string JSON — não há coluna por chave.
 *
 * ⚠️ NÃO filtrar por `environment`: o campo só nasceu em 26/07 e `''` é ~70%
 * dos eventos. Filtrar por ele descarta a metade da história que interessa
 * comparar.
 */
export const prop = (chave: string) =>
  `JSONExtractString(properties,'${chave}')`;

/** As duas superfícies de plugin, sempre juntas. */
export const PLUGIN = `${prop("platform")} IN ('sketchup','revit')`;
export const WEB = `${prop("platform")} = 'web'`;
