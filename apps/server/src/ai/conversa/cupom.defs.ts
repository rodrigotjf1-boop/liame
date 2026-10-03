import { z } from 'zod';
import type { FerramentaDef } from '../registro/definicoes.js';
import { FERRAMENTA_PROPOR_CUPOM } from './prompt.js';

// A proposta de cupom pela conversa (A3, I10b; D-A3-5: a única proposta da IA que vira ação é o cupom no Regem).
// A LIA monta o PEDIDO; quem cria o cupom é o Action Service, depois que uma pessoa com permissão aprova com o
// código do app (política `cupom.criar`). A entrada não tem id nenhum: as leituras mostram loja e campanha pelo
// nome, e o código acha os ids na marca da conversa. Valor em reais como texto ("R$ 10,00"): quem converte é o
// código. A execução está em `conversa/proposta-cupom.service.ts`, pelo mesmo serviço da rota `POST /v1/coupons/regem`.

const Dia = z.iso.date();

export const ProporCupomInput = z.strictObject({
  /** A loja, pelo nome que aparece na leitura dos cupons. */
  loja: z.string().trim().min(1).max(120),
  /** A campanha, pelo nome que aparece nas leituras. */
  campanha: z.string().trim().min(1).max(200),
  /** De 4 a 20 letras maiúsculas ou números. */
  codigo: z.string().trim().regex(/^[A-Z0-9]{4,20}$/),
  tipo: z.enum(['percentual', 'valor', 'frete_gratis']),
  /** Só no percentual: de 1 a 100. */
  percentual: z.int().min(1).max(100).optional(),
  /** Só no valor fixo, em reais como a pessoa disse ("R$ 10,00"). */
  valor: z.string().trim().min(1).max(30).optional(),
  /** Pedido mínimo em reais, quando houver. */
  pedido_minimo: z.string().trim().min(1).max(30).optional(),
  valido_de: Dia,
  valido_ate: Dia,
  /** Exclusivo da campanha: só o cupom exclusivo prova de onde veio o pedido. */
  exclusivo: z.boolean(),
});
export type ProporCupomInput = z.infer<typeof ProporCupomInput>;

export const PROPOR_CUPOM: FerramentaDef = {
  name: FERRAMENTA_PROPOR_CUPOM,
  version: 1,
  description:
    'Monta a proposta de um cupom de campanha numa loja do Regem e a manda para Aprovações: nada é criado agora. O cupom só nasce no Regem depois que uma pessoa com permissão aprovar. Use a loja e a campanha pelo nome, como aparecem nos dados, e a validade com datas do contexto. Uma proposta por pedido da pessoa.',
  risk: 'R1',
  permission: 'cupons.criar',
  owner: 'vendas',
  input: ProporCupomInput,
};

const REAIS = /^(?:R\$\s?)?(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?$/;

/** "R$ 1.250,00", "10,5" ou "10" → micros em texto (1 real = 1.000.000); nulo quando não é um valor em reais. */
export function reaisParaMicros(texto: string): string | null {
  const m = REAIS.exec(texto.replace(/ /g, ' ').trim());
  if (!m) return null;
  const inteiro = BigInt((m[1] ?? '0').replace(/\./g, ''));
  const centavos = BigInt((m[2] ?? '0').padEnd(2, '0'));
  return (inteiro * 1_000_000n + centavos * 10_000n).toString();
}
