import type { MessageDiscount, MessageDiscountKind, MessageDiscountRequest, MessageDiscountResponse } from '@liame/contracts';
import { regraDoCupomEscrita } from '@/components/aprovacoes/mensagem-textos';
import type { Problema } from '@/lib/api';
import { centavos } from './textos';

// O desconto do cupom das mensagens na tela Mensagens (mockups/prototipo-mensagens-desconto.html, P15 parte D, aprovado
// pelo dono em 14/10/2026; A5 · Y6). A empresa define uma vez o desconto que o cupom de cada mensagem dá; o funcionário
// de CRM e mensageria usa esse e não inventa oferta nem preço; sem ele, não propõe. Quem define é quem define os limites
// da Verba do mês (o Dono e o Administrador). O servidor confere tudo de novo (`PUT /v1/messaging/discount`).

/** Os três tipos do cupom de campanha do Regem, com os nomes que o app já usa ao criar um cupom. */
export const TIPOS_DO_DESCONTO: { tipo: MessageDiscountKind; rotulo: string }[] = [
  { tipo: 'percentual', rotulo: 'Percentual' },
  { tipo: 'valor', rotulo: 'Valor fixo' },
  { tipo: 'frete_gratis', rotulo: 'Entrega grátis' },
];

const dias = (n: number) => (n === 1 ? '1 dia' : `${n} dias`);
const maiuscula = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const primeiroNome = (nome: string) => nome.trim().split(/\s+/)[0] ?? nome;

/** "10% de desconto", "R$ 10,00 de desconto" ou "entrega grátis". */
export function beneficioDoDesconto(d: Pick<MessageDiscount, 'kind' | 'percent' | 'value_cents'>): string {
  if (d.kind === 'frete_gratis') return 'entrega grátis';
  if (d.kind === 'valor') return `${centavos(d.value_cents ?? 0)} de desconto`;
  return `${d.percent ?? 0}% de desconto`;
}

/** "07/10", no fuso de quem vê. */
function diaMes(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export type CaixaDoDesconto = {
  titulo: string;
  linhas: string[];
  /** A loja onde o cupom nasce saiu do Liame: o desconto precisa de outra. */
  aviso: string | null;
  /** "Definir o desconto" ou "Mudar" (quem pode definir); nulo para quem só vê. */
  botao: string | null;
  /** Para quem só vê: quem define. */
  quem: string | null;
};

const QUEM_DEFINE = 'Quem define é o Dono ou o Administrador.';

/** A quarta caixa do topo da tela: o que o cupom dá, por quantos dias vale, quem definiu, e o botão. */
export function caixaDoDesconto(r: MessageDiscountResponse): CaixaDoDesconto {
  const d = r.discount;
  const quem = r.can_edit ? null : QUEM_DEFINE;
  if (!d) return { titulo: 'Não definido', linhas: ['sem ele, nenhuma mensagem é proposta'], aviso: null, botao: r.can_edit ? 'Definir o desconto' : null, quem };
  const minimo = d.min_order_cents ? `em pedidos a partir de ${centavos(d.min_order_cents)}` : 'sem pedido mínimo';
  // Com mais de uma loja do Regem, a caixa diz em qual o cupom nasce (o nome entre aspas: a preposição é da palavra "loja").
  const loja = r.stores.length > 1 ? ` · na loja “${d.store.name}”` : '';
  const por = d.set_by ? `definido por ${primeiroNome(d.set_by.name)} em ${diaMes(d.set_at)}` : `definido em ${diaMes(d.set_at)}`;
  return {
    titulo: maiuscula(beneficioDoDesconto(d)),
    linhas: [`${minimo} · vale por ${dias(d.valid_days)}, contando o dia do envio${loja}`, por],
    aviso: d.store.connected ? null : `A loja “${d.store.name}” foi desconectada do Liame: o cupom precisa de outra loja do Regem.`,
    botao: r.can_edit ? 'Mudar' : null,
    quem,
  };
}

/** A faixa do topo enquanto ninguém definiu o desconto (com a função ligada); nula depois. */
export function faixaDoDesconto(r: MessageDiscountResponse): { titulo: string; texto: string; botao: string | null } | null {
  if (!r.enabled || r.discount) return null;
  return {
    titulo: 'Falta definir o desconto do cupom das mensagens',
    texto: `Cada mensagem leva um cupom só dela, e o desconto dele é ${r.can_edit ? 'você quem define, uma vez' : 'definido uma vez pelo Dono ou pelo Administrador'}. Sem isso, o CRM e mensageria não propõe mensagem.`,
    botao: r.can_edit ? 'Definir o desconto' : null,
  };
}

// ------------------------------------------------------------------ a gaveta de definir

export type CampoDoDesconto = 'quanto' | 'minimo' | 'dias' | 'loja';
export type FormularioDoDesconto = { tipo: MessageDiscountKind; quanto: string; minimo: string; dias: string; loja: string };

/** As lojas do Regem da marca onde o cupom pode nascer (as que liberaram "criar cupom de campanha"). */
export function lojasQueCriam(r: MessageDiscountResponse): MessageDiscountResponse['stores'] {
  return r.stores.filter((s) => s.can_create);
}

const emTexto = (centavosOuNulo: number | null) => (centavosOuNulo === null ? '' : (centavosOuNulo / 100).toFixed(2).replace('.', ','));

/** O formulário ao abrir: o desconto de agora; na primeira vez, o valor em branco (quem escolhe é a pessoa) e 3 dias. */
export function formularioInicial(r: MessageDiscountResponse): FormularioDoDesconto {
  const d = r.discount;
  const varias = lojasQueCriam(r).length > 1;
  if (!d) return { tipo: 'percentual', quanto: '', minimo: '', dias: '3', loja: '' };
  const tipo = d.kind as MessageDiscountKind;
  const loja = varias && lojasQueCriam(r).some((s) => s.connected_account_id === d.store.connected_account_id) ? d.store.connected_account_id : '';
  return { tipo, quanto: tipo === 'valor' ? emTexto(d.value_cents) : tipo === 'percentual' ? String(d.percent ?? '') : '', minimo: emTexto(d.min_order_cents), dias: String(d.valid_days), loja };
}

/** "30", "30,00" ou "1.250,50" em centavos; nulo quando não é valor em reais. Sem expressão regular (V48). */
export function centavosDoTexto(texto: string): number | null {
  const s = texto.trim().replaceAll('.', '');
  const partes = s.split(',');
  if (partes.length > 2) return null;
  const [inteiros = '', decimais = ''] = partes;
  if (!inteiros || inteiros.length > 7 || decimais.length > 2) return null;
  if (![...inteiros, ...decimais].every((c) => c >= '0' && c <= '9')) return null;
  return Number(inteiros) * 100 + Number(decimais.padEnd(2, '0'));
}

/** Um número inteiro escrito só com dígitos ("3", "10"); nulo no resto. */
export function inteiroDoTexto(texto: string): number | null {
  const s = texto.trim();
  if (!s || s.length > 4 || ![...s].every((c) => c >= '0' && c <= '9')) return null;
  return Number(s);
}

export type LeituraDoFormulario = { ok: true; corpo: MessageDiscountRequest } | { ok: false; erro: string; campo: CampoDoDesconto };

/** Confere o formulário com os limites que o servidor manda; as frases são as do servidor (`conferirDesconto`). */
export function lerFormulario(g: FormularioDoDesconto, r: MessageDiscountResponse): LeituraDoFormulario {
  const L = r.limits;
  const recusar = (erro: string, campo: CampoDoDesconto): LeituraDoFormulario => ({ ok: false, erro, campo });
  const corpo: MessageDiscountRequest = { brand_id: r.brand_id, kind: g.tipo, valid_days: 1 };
  if (g.tipo === 'percentual') {
    if (g.quanto.includes(',') || g.quanto.includes('.')) return recusar(`O percentual vai de 1 a ${L.percent_max}, sem casas decimais.`, 'quanto');
    const n = inteiroDoTexto(g.quanto);
    if (n === null || n < 1) return recusar(`Informe o desconto, de 1% a ${L.percent_max}%.`, 'quanto');
    if (n > L.percent_max) return recusar(`O desconto passa de ${L.percent_max}%: o Liame não aceita mais que isso no cupom das mensagens.`, 'quanto');
    corpo.percent = n;
  }
  if (g.tipo === 'valor') {
    const n = centavosDoTexto(g.quanto);
    if (n === null || n < 100) return recusar(`Informe o desconto, de ${centavos(100)} a ${centavos(L.value_cents_max)}.`, 'quanto');
    if (n > L.value_cents_max) return recusar(`O desconto passa de ${centavos(L.value_cents_max)}: o Liame não aceita mais que isso no cupom das mensagens.`, 'quanto');
    corpo.value_cents = n;
  }
  if (g.minimo.trim()) {
    const n = centavosDoTexto(g.minimo);
    if (n === null || n <= 0 || n > L.min_order_cents_max) return recusar('Informe o pedido mínimo em reais, ou deixe em branco.', 'minimo');
    corpo.min_order_cents = n;
  }
  if (g.tipo === 'valor' && (corpo.min_order_cents === undefined || corpo.min_order_cents <= (corpo.value_cents ?? 0))) {
    return recusar('Com desconto de valor fixo, informe o pedido mínimo, maior que o desconto.', 'minimo');
  }
  const d = inteiroDoTexto(g.dias);
  if (d === null || d < 1 || d > L.valid_days_max) return recusar(`O cupom vale de 1 a ${L.valid_days_max} dias.`, 'dias');
  corpo.valid_days = d;
  if (lojasQueCriam(r).length > 1) {
    if (!g.loja) return recusar('Escolha em qual loja o cupom vale.', 'loja');
    corpo.connected_account_id = g.loja;
  }
  return { ok: true, corpo };
}

const SEMANA = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const dataLocal = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * O exemplo da gaveta: como o cupom de uma mensagem enviada hoje aparece no pedido em Aprovações, nas mesmas palavras de
 * lá (`regraDoCupomEscrita`). O cupom vale do dia do envio até `valid_days` dias, contando o do envio.
 */
export function exemploDoCupom(g: FormularioDoDesconto, r: MessageDiscountResponse, hoje: Date): { intro: string; cupom: string | null } {
  const lido = lerFormulario({ ...g, loja: g.loja || 'qualquer' }, { ...r, stores: r.stores.slice(0, 1) });
  if (!lido.ok) return { intro: 'O exemplo do cupom aparece aqui quando o desconto estiver preenchido e dentro dos limites.', cupom: null };
  const c = lido.corpo;
  const fim = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() + c.valid_days - 1);
  const cupom = regraDoCupomEscrita({
    code: '',
    kind: c.kind,
    percent: c.percent ?? null,
    value_cents: c.value_cents ?? null,
    min_order_cents: c.min_order_cents ?? null,
    valid_from: dataLocal(hoje),
    valid_until: dataLocal(fim),
    created: false,
  });
  return { intro: `O cupom de uma mensagem enviada hoje (${SEMANA[hoje.getDay()]}, ${diaMes(hoje.toISOString())}) vai aparecer assim no pedido:`, cupom };
}

/** A recusa do servidor em palavras, com o campo quando o servidor diz qual. */
export function erroAoSalvarDesconto(p: Problema): { erro: string; campo: CampoDoDesconto | null; semLoja: boolean } {
  if (p.code === 'loja-sem-cupom') return { erro: p.detail ?? p.title, campo: null, semLoja: true };
  const primeiro = p.errors?.[0];
  const campo: CampoDoDesconto | null = !primeiro
    ? null
    : primeiro.path === 'percent' || primeiro.path === 'value_cents'
      ? 'quanto'
      : primeiro.path === 'min_order_cents'
        ? 'minimo'
        : primeiro.path === 'valid_days'
          ? 'dias'
          : primeiro.path === 'connected_account_id'
            ? 'loja'
            : null;
  return { erro: primeiro?.message ?? p.detail ?? p.title, campo, semLoja: false };
}
