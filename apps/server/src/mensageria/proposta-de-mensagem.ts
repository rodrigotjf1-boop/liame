import { z } from 'zod';
import type { RegraDoCupom } from '../actions/regem-cupom.js';
import { canonicalJson, sha256 } from '../audit/audit.js';
import type { CampanhaParaRascunhar, PublicoDaCampanha, VariavelDaMensagem } from '../connectors/regemcast/conector-regemcast.js';
import type { ModelosRegemcast, PublicosRegemcast } from '../connectors/regemcast/contrato-regemcast.js';

// A proposta de uma mensagem de WhatsApp e as regras puras em cima dela (A5, Y5, parte 4; `plano-a5.md` D-A5-10 a
// D-A5-16; protótipo P15). Quem propõe é o funcionário de CRM e mensageria (Y6); quem aprova é uma pessoa, com o código
// do app; quem envia é o RegemCast. Aqui fica o que se confere ANTES de montar o rascunho lá:
//
// - o público é sempre um que já existe no RegemCast (uma lista, um público pronto ou um perfil): nunca a base inteira,
//   nunca números soltos (D-A5-10);
// - o envio só acontece entre 9h e 20h, no fuso da conta (D-A5-13): a proposta pode estreitar a janela, nunca alargar;
// - cada variável do texto tem valor, e o valor fixo não leva telefone: o nome de cada pessoa é posto pelo RegemCast;
// - a mensagem que leva cupom cita o código dele: é pelo cupom que o resultado é medido no caixa (D-A5-16).

export const JANELA_INICIO = '09:00';
export const JANELA_FIM = '20:00';
const HORA = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const Dia = z.iso.date();

const Variavel = z
  .strictObject({ origem: z.enum(['fixo', 'nome', 'primeiro_nome', 'cashback_saldo', 'cashback_validade']), valor: z.string().trim().min(1).max(200).optional() })
  .superRefine((v, ctx) => {
    if (v.origem === 'fixo' && v.valor === undefined) ctx.addIssue({ code: 'custom', path: ['valor'], message: 'A variável fixa precisa do valor' });
    if (v.origem !== 'fixo' && v.valor !== undefined) ctx.addIssue({ code: 'custom', path: ['valor'], message: 'Só a variável fixa leva valor: as outras o RegemCast preenche' });
  });

/** O cupom da mensagem, como o funcionário o propõe. Vira a regra do contrato de cupons do Regem (§3.3). */
const CupomDaMensagem = z
  .strictObject({
    /** A loja do Regem onde o cupom nasce (a conta conectada, no Liame). */
    loja: z.uuid(),
    codigo: z.string().regex(/^[A-Z0-9]{4,20}$/, { error: 'De 4 a 20 letras maiúsculas ou números, sem espaço' }),
    nome: z.string().trim().min(1).max(80).optional(),
    tipo: z.enum(['percentual', 'valor', 'frete_gratis']),
    percentual: z.int().min(1).max(100).optional(),
    valor_centavos: z.int().min(1).max(100_000_000).optional(),
    pedido_minimo_centavos: z.int().min(0).max(100_000_000).default(0),
    valido_de: Dia,
    valido_ate: Dia,
  })
  .superRefine((c, ctx) => {
    if (c.tipo === 'percentual' && c.percentual === undefined) ctx.addIssue({ code: 'custom', path: ['percentual'], message: 'Informe o desconto em %' });
    if (c.tipo !== 'percentual' && c.percentual !== undefined) ctx.addIssue({ code: 'custom', path: ['percentual'], message: 'O percentual só vale no cupom percentual' });
    if (c.tipo === 'valor' && c.valor_centavos === undefined) ctx.addIssue({ code: 'custom', path: ['valor_centavos'], message: 'Informe o valor do desconto' });
    if (c.tipo !== 'valor' && c.valor_centavos !== undefined) ctx.addIssue({ code: 'custom', path: ['valor_centavos'], message: 'O valor só vale no cupom de valor fixo' });
    if (c.valido_ate < c.valido_de) ctx.addIssue({ code: 'custom', path: ['valido_ate'], message: 'A validade termina antes de começar' });
  });
export type CupomDaMensagem = z.infer<typeof CupomDaMensagem>;

export const PropostaDeMensagem = z.strictObject({
  marca: z.uuid(),
  /** A conta do RegemCast conectada (o id no Liame). */
  conta: z.uuid(),
  nome: z.string().trim().min(2).max(120),
  modelo: z.strictObject({ nome: z.string().min(1).max(512), idioma: z.string().min(2).max(20).optional() }),
  publico: z.strictObject({
    origem: z.enum(['lista', 'publico', 'perfil']),
    /** O id da lista, do público pronto ou do perfil, como veio do RegemCast. */
    id: z.string().min(1).max(100),
    /** O bairro, o mês ou o produto, quando o público pronto pede. */
    valor: z.string().trim().min(1).max(80).optional(),
  }),
  variaveis: z.array(Variavel).max(10).default([]),
  variavel_do_titulo: Variavel.optional(),
  janela: z
    .strictObject({ dias: z.array(z.int().min(0).max(6)).min(1).max(7).optional(), inicio: z.string().regex(HORA).optional(), fim: z.string().regex(HORA).optional() })
    .default({}),
  cupom: CupomDaMensagem.nullable().default(null),
});
export type PropostaDeMensagem = z.infer<typeof PropostaDeMensagem>;

/** A proposta não pode virar pedido como está: o motivo vai para quem propôs (e para o registro). */
export class PropostaRecusada extends Error {}

export type Janela = { dias: number[]; inicio: string; fim: string };

/** A janela de envio da proposta, sempre dentro de 9h às 20h (D-A5-13). Sem nada, todos os dias, o horário inteiro. */
export function janelaDaProposta(j: PropostaDeMensagem['janela']): Janela {
  const inicio = j.inicio ?? JANELA_INICIO;
  const fim = j.fim ?? JANELA_FIM;
  // O formato é HH:MM com dois dígitos: a ordem do texto é a ordem da hora.
  if (inicio < JANELA_INICIO || fim > JANELA_FIM) throw new PropostaRecusada('O envio de mensagem só acontece entre 9h e 20h, no horário da loja.');
  if (inicio >= fim) throw new PropostaRecusada('A janela de envio termina antes de começar.');
  const dias = [...new Set(j.dias ?? [0, 1, 2, 3, 4, 5, 6])].sort((a, b) => a - b);
  return { dias, inicio, fim };
}

type Modelo = ModelosRegemcast['modelos'][number];

/** O modelo da proposta, como o RegemCast o tem agora: precisa existir e estar aprovado pela Meta. */
export function modeloDaProposta(modelos: ModelosRegemcast, pedido: PropostaDeMensagem['modelo']): Modelo {
  const doNome = modelos.modelos.filter((m) => m.nome === pedido.nome);
  const modelo = pedido.idioma ? doNome.find((m) => m.idioma === pedido.idioma) : doNome.length === 1 ? doNome[0] : (doNome.find((m) => m.idioma === 'pt_BR') ?? doNome[0]);
  if (!modelo) throw new PropostaRecusada(`O modelo "${pedido.nome}" não existe nesta conta do RegemCast.`);
  if (!modelo.podeDisparar) throw new PropostaRecusada(`O modelo "${modelo.nome}" ainda não foi aprovado pela Meta: só modelo aprovado pode ser enviado.`);
  return modelo;
}

const marcas = (texto: string | null): number[] => [...(texto ?? '').matchAll(/\{\{(\d{1,2})\}\}/g)].map((m) => Number(m[1]));
/** Dez dígitos ou mais num valor é número de telefone (um preço, uma data ou um código de cupom não chegam a isso). */
const pareceTelefone = (valor: string): boolean => valor.replace(/\D/g, '').length >= 10;

/** Cada variável do modelo tem valor, na ordem; o valor fixo não leva telefone. O título só leva variável se o modelo tiver. */
export function conferirVariaveis(modelo: Modelo, variaveis: VariavelDaMensagem[], doTitulo: VariavelDaMensagem | undefined): void {
  if (variaveis.length !== modelo.variaveis) {
    throw new PropostaRecusada(`O modelo "${modelo.nome}" espera ${modelo.variaveis} ${modelo.variaveis === 1 ? 'variável' : 'variáveis'} no texto, e a proposta traz ${variaveis.length}.`);
  }
  const noTitulo = marcas(modelo.cabecalho).length > 0;
  if (noTitulo && !doTitulo) throw new PropostaRecusada(`O título do modelo "${modelo.nome}" tem uma variável, e a proposta não diz o valor dela.`);
  if (!noTitulo && doTitulo) throw new PropostaRecusada(`O título do modelo "${modelo.nome}" não tem variável.`);
  for (const v of [...variaveis, ...(doTitulo ? [doTitulo] : [])]) {
    if (v.origem === 'fixo' && v.valor && pareceTelefone(v.valor)) throw new PropostaRecusada('O texto da mensagem não pode levar número de telefone.');
  }
}

/** O texto da mensagem como a pessoa vai ler: o valor fixo no lugar da variável, e o nome do que o RegemCast preenche. */
const ROTULO_DA_VARIAVEL: Record<VariavelDaMensagem['origem'], string> = {
  fixo: '',
  nome: '[nome]',
  primeiro_nome: '[primeiro nome]',
  cashback_saldo: '[saldo de cashback]',
  cashback_validade: '[validade do cashback]',
};
export function textoComVariaveis(texto: string, variaveis: VariavelDaMensagem[]): string {
  return texto.replace(/\{\{(\d{1,2})\}\}/g, (marca, n: string) => {
    const v = variaveis[Number(n) - 1];
    if (!v) return marca;
    return v.origem === 'fixo' ? (v.valor ?? '') : ROTULO_DA_VARIAVEL[v.origem];
  });
}

/** A mensagem diz o código do cupom em algum lugar que a pessoa lê: o título, o texto, o rodapé ou um botão. */
export function citaOCupom(modelo: Modelo, variaveis: VariavelDaMensagem[], doTitulo: VariavelDaMensagem | undefined, codigo: string): boolean {
  const lido = [textoComVariaveis(modelo.cabecalho ?? '', doTitulo ? [doTitulo] : []), textoComVariaveis(modelo.corpo, variaveis), modelo.rodape ?? '', ...modelo.botoes].join('\n');
  return lido.toUpperCase().includes(codigo);
}

/** O público da proposta, como o RegemCast o descreve agora (o nome e a regra): precisa existir lá. */
export function publicoDaProposta(publicos: PublicosRegemcast, p: PropostaDeMensagem['publico']): { nome: string; regra: string | null; doRegemcast: PublicoDaCampanha } {
  const grupo = p.origem === 'lista' ? publicos.listas : p.origem === 'publico' ? publicos.publicos : publicos.perfis;
  const achado = grupo.find((g) => g.id === p.id);
  if (!achado) throw new PropostaRecusada('O público da proposta não existe mais nesta conta do RegemCast.');
  const doRegemcast: PublicoDaCampanha =
    p.origem === 'lista' ? { origem: 'lista', origemId: p.id } : p.origem === 'publico' ? { origem: 'publico', publico: p.id, ...(p.valor ? { publicoValor: p.valor } : {}) } : { origem: 'perfil', segmento: p.id };
  return { nome: p.valor ? `${achado.nome}: ${p.valor}` : achado.nome, regra: achado.regra, doRegemcast };
}

/** A regra do cupom como o contrato de cupons do Regem pede (§3.3). */
export function regraDoCupom(c: CupomDaMensagem, nomeDaMensagem: string): RegraDoCupom {
  return {
    codigo: c.codigo,
    nome: c.nome ?? `Mensagem · ${nomeDaMensagem}`.slice(0, 80),
    tipo: c.tipo,
    ...(c.tipo === 'percentual' ? { percentual: `${c.percentual}.00` } : {}),
    ...(c.tipo === 'valor' ? { valor_centavos: c.valor_centavos } : {}),
    ...(c.pedido_minimo_centavos > 0 ? { pedido_minimo_centavos: c.pedido_minimo_centavos } : {}),
    valido_de: c.valido_de,
    valido_ate: c.valido_ate,
  };
}

/** A campanha em rascunho, como o RegemCast a recebe. */
export function campanhaDoRascunho(p: PropostaDeMensagem, modelo: Modelo, publico: PublicoDaCampanha, janela: Janela): CampanhaParaRascunhar {
  return {
    nome: p.nome,
    modeloNome: modelo.nome,
    modeloIdioma: modelo.idioma,
    publico,
    ...(p.variaveis.length ? { variaveis: p.variaveis } : {}),
    ...(p.variavel_do_titulo ? { variavelDoTitulo: p.variavel_do_titulo } : {}),
    janelaDias: janela.dias,
    janelaInicio: janela.inicio,
    janelaFim: janela.fim,
  };
}

/**
 * A chave de idempotência do rascunho: a mesma proposta, na mesma conta, devolve a mesma campanha em rascunho no
 * RegemCast (a rotina que caiu no meio e repete não monta duas).
 */
export function chaveDoRascunho(tenantId: string, contaId: string, campanha: CampanhaParaRascunhar): string {
  return `liame:rascunho:${sha256(canonicalJson([tenantId, contaId, campanha])).slice(0, 48)}`;
}
