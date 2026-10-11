import type { MessageDiscountRequest } from '@liame/contracts';

// O desconto padrão do cupom das mensagens (A5, Y6; decisão do dono em 10/10/2026; protótipo P15, parte D): as regras
// puras. O cupom de cada mensagem tem o mesmo desconto, definido uma vez pela empresa; o funcionário de CRM e
// mensageria usa esse e não inventa oferta nem preço.

/**
 * Até onde o Liame aceita o desconto. É mais estreito que o contrato de cupons do Regem (que aceita 100% e validade
 * longa), porque este desconto se repete em toda mensagem. Os números são os do protótipo e ainda esperam o aceite do
 * dono: ficam aqui, e não na tabela, para mudar sem migration.
 */
export const LIMITES_DO_DESCONTO = {
  percentMax: 50,
  valueCentsMax: 10_000,
  minOrderCentsMax: 100_000,
  validDaysMax: 14,
} as const;

export type ErroDoDesconto = { path: string; message: string };

/** "R$ 1.000,00", de centavos inteiros (sem ponto flutuante na conta). */
const reais = (centavos: number) => `R$ ${Math.trunc(centavos / 100).toLocaleString('pt-BR')},${String(centavos % 100).padStart(2, '0')}`;

/**
 * Confere o desconto pedido contra as regras do produto; devolve o que está errado, campo a campo (vazio = pode
 * gravar). O formato de cada campo já veio conferido pelo contrato.
 */
export function conferirDesconto(d: Pick<MessageDiscountRequest, 'kind' | 'percent' | 'value_cents' | 'min_order_cents' | 'valid_days'>): ErroDoDesconto[] {
  const L = LIMITES_DO_DESCONTO;
  const erros: ErroDoDesconto[] = [];
  if (d.kind === 'percentual') {
    if (d.percent === undefined) erros.push({ path: 'percent', message: `Informe o desconto, de 1% a ${L.percentMax}%.` });
    else if (d.percent > L.percentMax) erros.push({ path: 'percent', message: `O desconto passa de ${L.percentMax}%: o Liame não aceita mais que isso no cupom das mensagens.` });
  } else if (d.percent !== undefined) {
    erros.push({ path: 'percent', message: 'O percentual só vale no cupom percentual.' });
  }
  if (d.kind === 'valor') {
    if (d.value_cents === undefined) erros.push({ path: 'value_cents', message: `Informe o desconto, de ${reais(100)} a ${reais(L.valueCentsMax)}.` });
    else if (d.value_cents < 100) erros.push({ path: 'value_cents', message: `O desconto de valor fixo começa em ${reais(100)}.` });
    else if (d.value_cents > L.valueCentsMax) erros.push({ path: 'value_cents', message: `O desconto passa de ${reais(L.valueCentsMax)}: o Liame não aceita mais que isso no cupom das mensagens.` });
  } else if (d.value_cents !== undefined) {
    erros.push({ path: 'value_cents', message: 'O valor só vale no cupom de valor fixo.' });
  }
  if (d.min_order_cents !== undefined && d.min_order_cents > L.minOrderCentsMax) {
    erros.push({ path: 'min_order_cents', message: `O pedido mínimo passa de ${reais(L.minOrderCentsMax)}.` });
  }
  // Com desconto em reais, o pedido mínimo é obrigatório e maior que o desconto: sem isso, o cupom zeraria um pedido pequeno.
  if (d.kind === 'valor' && d.value_cents !== undefined && (d.min_order_cents === undefined || d.min_order_cents <= d.value_cents)) {
    erros.push({ path: 'min_order_cents', message: 'Com desconto de valor fixo, informe o pedido mínimo, maior que o desconto.' });
  }
  if (d.valid_days > L.validDaysMax) erros.push({ path: 'valid_days', message: `O cupom vale de 1 a ${L.validDaysMax} dias.` });
  return erros;
}

/** O desconto como a tabela o guarda. */
export type DescontoGuardado = {
  kind: 'percentual' | 'valor' | 'frete_gratis';
  percent: number | null;
  value_cents: number | null;
  min_order_cents: number | null;
  valid_days: number;
  coupon_account_id: string;
};

/** O dia (AAAA-MM-DD) tantos dias depois: conta de calendário, sem fuso. */
function somarDias(dia: string, dias: number): string {
  return new Date(Date.parse(`${dia}T12:00:00Z`) + dias * 86_400_000).toISOString().slice(0, 10);
}

/**
 * O cupom de uma mensagem que sai no dia dado (o dia da loja), a partir do desconto padrão: vale do dia do envio até
 * `valid_days` dias, **contando o do envio** (2 dias = o do envio e o seguinte). É o formato do cupom da proposta de
 * mensagem (`proposta-de-mensagem.ts`); o código, único por mensagem, é de quem chama.
 */
export function cupomDoDesconto(d: DescontoGuardado, diaDoEnvio: string, codigo: string) {
  return {
    loja: d.coupon_account_id,
    codigo,
    tipo: d.kind,
    ...(d.kind === 'percentual' && d.percent !== null ? { percentual: d.percent } : {}),
    ...(d.kind === 'valor' && d.value_cents !== null ? { valor_centavos: d.value_cents } : {}),
    pedido_minimo_centavos: d.min_order_cents ?? 0,
    valido_de: diaDoEnvio,
    valido_ate: somarDias(diaDoEnvio, d.valid_days - 1),
  };
}
