import { NextRequest, NextResponse } from "next/server";

/**
 * A porta do painel. Antes dela, TUDO aqui era público na internet.
 *
 * O que estava aberto, medido em 17/08: `/experimentos` mostra receita por
 * braço do teste de preço e coortes de compradores; `/` mostra o funil de
 * cadastro com e-mails; e `POST /api/delete-user` apagava o histórico de
 * qualquer pessoa a partir do e-mail dela, sem pedir nada a ninguém. Não havia
 * middleware, gate no layout nem proteção na Vercel.
 *
 * Basic Auth porque o painel não tem — e não precisa ter — sistema de contas:
 * são duas pessoas olhando. O que ele precisa é deixar de ser público, e essa
 * é a menor mudança que faz isso de verdade, sem sessão, banco ou tela nova.
 */

/**
 * Quem NÃO passa por aqui, e por quê. Toda entrada desta lista é um endpoint
 * que se autentica sozinho — a isenção é para não pedir senha duas vezes, e
 * some no instante em que a rota deixar de ter porta própria.
 *
 * - `/api/track-event`: chamado pelo NAVEGADOR de quem usa a biblioteca, com
 *   CORS `*`. Pedir senha aqui mataria a telemetria do produto inteiro. Tem
 *   segredo próprio na query (que, por viajar no bundle, é identificação e
 *   não segredo — ver o comentário da própria rota).
 * - `/api/whatsapp/*`: chamados pela ponte de WhatsApp, que já manda
 *   `Authorization` conferido contra `WHATSAPP_BRIDGE_TOKEN`.
 */
const ROTAS_COM_PORTA_PROPRIA = ["/api/track-event", "/api/whatsapp"];

function pedirSenha(motivo: string): NextResponse {
  return new NextResponse(motivo, {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Painel Collection", charset="UTF-8"',
    },
  });
}

/**
 * Comparação de tamanho fixo. Não é o modelo de ameaça de um painel interno,
 * mas comparar com `===` vaza o prefixo correto pelo tempo de resposta, e
 * escrever certo aqui custa quatro linhas.
 */
function iguais(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diferenca = 0;
  for (let i = 0; i < a.length; i += 1) {
    diferenca |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diferenca === 0;
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (ROTAS_COM_PORTA_PROPRIA.some((rota) => pathname.startsWith(rota))) {
    return NextResponse.next();
  }

  const usuario = process.env.DASHBOARD_USER;
  const senha = process.env.DASHBOARD_PASSWORD;

  /**
   * Sem credencial configurada, NEGA — não libera.
   *
   * O contrário seria o pior dos dois mundos: uma porta que parece existir no
   * código e não existe no ar, e ninguém descobre até alguém achar a URL. Se
   * o painel responder isto depois de um deploy, faltam as variáveis na
   * Vercel, e a correção é configurá-las — não remover o middleware.
   */
  if (!usuario || !senha) {
    return new NextResponse(
      "Painel sem credenciais configuradas. Defina DASHBOARD_USER e DASHBOARD_PASSWORD.",
      { status: 503 },
    );
  }

  const cabecalho = request.headers.get("authorization") ?? "";
  if (!cabecalho.startsWith("Basic ")) {
    return pedirSenha("Autenticação necessária.");
  }

  let recebido = "";
  try {
    recebido = atob(cabecalho.slice("Basic ".length).trim());
  } catch {
    return pedirSenha("Credencial ilegível.");
  }

  /* Só o PRIMEIRO `:` separa — senha com dois-pontos é senha válida. */
  const separador = recebido.indexOf(":");
  const usuarioRecebido = separador >= 0 ? recebido.slice(0, separador) : "";
  const senhaRecebida = separador >= 0 ? recebido.slice(separador + 1) : "";

  if (!iguais(usuarioRecebido, usuario) || !iguais(senhaRecebida, senha)) {
    return pedirSenha("Credencial inválida.");
  }

  return NextResponse.next();
}

/**
 * Tudo passa pelo middleware, menos o que o Next serve de si mesmo. A lista de
 * exceção é curta de propósito: rota nova nasce FECHADA, e quem precisar abrir
 * escreve isso explicitamente em `ROTAS_COM_PORTA_PROPRIA`.
 */
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
