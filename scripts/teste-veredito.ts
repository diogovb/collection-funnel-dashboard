/**
 * Teste do veredito — roda com `npx tsx scripts/teste-veredito.ts`.
 *
 * O repo não tem harness de teste; este script é o contrato executável da
 * regra que decide o rótulo de gente. Sai com código 1 se qualquer caso
 * falhar — foi conferido que falha de verdade invertendo a regra do conflito.
 */
import { veredito, type SinaisDaJornada } from '../src/lib/veredito';

const casos: Array<[string, SinaisDaJornada, ReturnType<typeof veredito>]> = [
  [
    'conflito REAL registrado → único caso que pode dizer "barrado"',
    { contaSemTelefone: true, verificouCodigo: true, conflitoDeNumero: true },
    'barrado_numero_em_uso',
  ],
  [
    'conflito registrado mesmo sem código (recusa no create sem bilhete)',
    { contaSemTelefone: true, verificouCodigo: false, conflitoDeNumero: true },
    'barrado_numero_em_uso',
  ],
  [
    'verificou e ficou sem telefone, SEM conflito → não é barrado (era o falso positivo de 68%)',
    { contaSemTelefone: true, verificouCodigo: true, conflitoDeNumero: false },
    'verificou_sem_confirmacao_do_vinculo',
  ],
  [
    'nunca verificou e ficou sem telefone → saiu antes',
    { contaSemTelefone: true, verificouCodigo: false, conflitoDeNumero: false },
    'saiu_antes_do_whatsapp',
  ],
  [
    'telefone no banco (phone_linked zerou a marca) → nada a explicar',
    { contaSemTelefone: false, verificouCodigo: true, conflitoDeNumero: false },
    null,
  ],
  [
    'conflito que se resolveu (tentou outro número e concluiu) → nada a explicar',
    { contaSemTelefone: false, verificouCodigo: true, conflitoDeNumero: true },
    null,
  ],
];

let falhas = 0;
for (const [nome, sinais, esperado] of casos) {
  const obtido = veredito(sinais);
  const ok = obtido === esperado;
  if (!ok) falhas++;
  console.log(`${ok ? 'ok  ' : 'FALHOU'}  ${nome}`);
  if (!ok) console.log(`        esperado=${esperado}  obtido=${obtido}`);
}
if (falhas) {
  console.error(`\n${falhas} caso(s) falharam`);
  process.exit(1);
}
console.log('\ntodos os casos passam');
