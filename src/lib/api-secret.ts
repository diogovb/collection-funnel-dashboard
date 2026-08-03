import { NextRequest } from "next/server";

/**
 * Autenticação das rotas de API internas (?secret=).
 *
 * O valor vem de FUNNEL_API_SECRET (Vercel env). Enquanto os chamadores
 * antigos não forem migrados, o valor legado continua aceito SE
 * FUNNEL_API_SECRET_LEGACY_OK=1 — desligue essa env assim que todos os
 * callers usarem o secret novo.
 */
export function isAuthorized(request: NextRequest): boolean {
  const provided = request.nextUrl.searchParams.get("secret");
  if (!provided) return false;

  const secret = process.env.FUNNEL_API_SECRET;
  if (secret && provided === secret) return true;

  if (process.env.FUNNEL_API_SECRET_LEGACY_OK === "1" && provided === "collection2024") {
    return true;
  }

  return false;
}
