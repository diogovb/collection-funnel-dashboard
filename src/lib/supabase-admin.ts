import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Cliente service-role do projeto do FUNIL (não o de assinaturas — esse é o
 * `supabase-subs.ts`).
 *
 * A chave morava AQUI, escrita no fonte, desde sempre. Saiu em 17/08 pelo
 * mesmo padrão que o `supabase-subs.ts` já usava: env obrigatória, sem
 * fallback. Sem fallback é o ponto — deixar o valor antigo como plano B faz a
 * rotação da chave não rotacionar nada, porque o código continua preferindo o
 * que está escrito nele.
 *
 * ⚠️ Tirar do fonte NÃO revoga: a chave antiga continua no histórico do git e
 * segue válida até ser rotacionada no painel do Supabase. Este arquivo fecha a
 * porta de hoje em diante; a rotação é o que fecha a de ontem.
 *
 * ⚠️ E é FUNÇÃO, não constante, pelo mesmo motivo do `getSubsClient`: o Next
 * importa os módulos de rota durante o `build`, e um `throw` no corpo do
 * módulo derrubaria a compilação numa máquina sem as variáveis. Adiando a
 * leitura para o primeiro USO, quem falta env descobre no request — com a
 * mensagem dizendo qual variável cadastrar — em vez de num build vermelho.
 *
 * `server-only`: import acidental por componente de cliente vira erro de
 * BUILD, e não uma service-role no bundle.
 */
function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `[supabase-admin] Falta a variável de ambiente ${name}. ` +
        `Cadastre-a na Vercel — este módulo não tem fallback no código.`,
    );
  }
  return value;
}

let cliente: SupabaseClient | null = null;

/** O cliente service-role do funil, criado uma vez por processo. */
export function getFunnelAdmin(): SupabaseClient {
  if (!cliente) {
    cliente = createClient(
      requiredEnv("FUNNEL_SUPABASE_URL"),
      requiredEnv("FUNNEL_SUPABASE_SERVICE_ROLE_KEY"),
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      },
    );
  }
  return cliente;
}
