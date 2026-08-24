/**
 * O veredito sobre uma jornada que ficou sem telefone no banco.
 *
 * Antes disto o card "Barrado por número em uso" era uma INFERÊNCIA:
 * `contaSemTelefone` (foto do INSERT no `account_created`) + código
 * verificado ⇒ "barrado". Medido em 24/08 contra o banco legado, a
 * inferência errava em 68% dos casos (32 de 47): no caminho Google a conta
 * nasce sem telefone e ganha o número SEGUNDOS depois — quem verificava e
 * saía antes do perfil virava "barrado", com a frase "não abandonou: foi
 * recusado no fim" fabricada pela heurística.
 *
 * Agora quem decide são eventos REAIS:
 *   - `phone_conflict` (backend + front, 24/08): a régua "um número, uma
 *     conta" recusou de verdade;
 *   - `phone_linked` (backend, 24/08): o vínculo concluiu COM prova — corrige
 *     a foto velha do INSERT.
 *
 * Função pura de propósito: o page.tsx é um componente de 2 mil linhas onde
 * nada disto seria testável. `scripts/teste-veredito.ts` exercita as regras.
 */

export type SinaisDaJornada = {
  /** `account_created` com `has_phone:false` e nada depois provou o contrário. */
  contaSemTelefone: boolean;
  /** `signup_code_verified` presente. */
  verificouCodigo: boolean;
  /** `phone_conflict` presente — recusa real da régua do número. */
  conflitoDeNumero: boolean;
};

export type Veredito =
  | 'barrado_numero_em_uso'
  | 'verificou_sem_confirmacao_do_vinculo'
  | 'saiu_antes_do_whatsapp'
  | null;

export function veredito(s: SinaisDaJornada): Veredito {
  /* Telefone no banco = nada a explicar. `phone_linked` e telefone em
     qualquer evento zeram `contaSemTelefone` antes de chegar aqui. */
  if (!s.contaSemTelefone) return null;

  /* Recusa REAL registrada. Só ela autoriza a palavra "barrado". */
  if (s.conflitoDeNumero) return 'barrado_numero_em_uso';

  /* Verificou o código e o telefone não consta: sem o evento de conflito não
     dá para afirmar recusa. Em jornadas antigas isso é quase sempre cadastro
     CONCLUÍDO que saiu antes do perfil (o evento do vínculo não existia); nas
     novas, é falha de vínculo a investigar. */
  if (s.verificouCodigo) return 'verificou_sem_confirmacao_do_vinculo';

  return 'saiu_antes_do_whatsapp';
}
