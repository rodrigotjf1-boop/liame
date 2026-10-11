import type { z } from 'zod';
import { conferirPedidoDoCrm } from '../ai/crm/contexto.js';
import { type MotivoDaMensagem, NOME_DE_EXEMPLO, RODAPE_DE_SAIDA } from '../ai/crm/mensagem.js';
import type { ModeloParaRascunhar, VariavelDaMensagem } from '../connectors/regemcast/conector-regemcast.js';
import type { PublicosRegemcast } from '../connectors/regemcast/contrato-regemcast.js';
import { somarDias } from './desconto.js';
import type { CupomDaMensagem, PropostaDeMensagem } from './proposta-de-mensagem.js';
import type { PropostaNova } from './proposta-do-crm.js';

// A rotina do funcionário de CRM e mensageria (A5, Y6; `plano-a5.md` D-A5-14 a D-A5-16; protótipo P16): as regras
// puras. Ele propõe uma mensagem quando há uma oferta de Minha marca para divulgar (a promoção) ou quando há clientes
// que pararam de pedir (o "volte a pedir"). Aqui se decide para quem, com que frequência, com qual oferta e com qual
// cupom; nada aqui fala com o banco, com o modelo de IA ou com o RegemCast. Nenhuma mensagem sai sem a aprovação de
// uma pessoa com o código do app.
//
// Os números deste arquivo são padrões que o plano não fixou (para quem vai cada mensagem e de quanto em quanto
// tempo). Estão escritos em `docs/decisoes-design.md` e na página de pendências do dono, para ele mudar se quiser.

/** De quantos em quantos dias ele propõe cada tipo de mensagem, por marca. */
export const DIAS_ENTRE_PROPOSTAS: Record<MotivoDaMensagem, number> = { promocao: 7, volte_a_pedir: 30 };

/** A mesma oferta de Minha marca não vira mensagem de novo antes destes dias. */
export const DIAS_PARA_REPETIR_A_OFERTA = 30;

/**
 * Os perfis do RegemCast de cada tipo de mensagem (os ids são os de lá). A promoção vai para quem compra; o "volte a
 * pedir", para quem comprou mais de uma vez e sumiu (com os padrões do RegemCast, há 91 a 180 dias). O RegemCast não
 * tem um grupo de "60 dias sem pedir": o mais próximo é este. Quem sumiu há mais tempo ("Perdidos") fica de fora.
 */
export const PERFIS_DO_MOTIVO: Record<MotivoDaMensagem, readonly string[]> = {
  promocao: ['fieis', 'campeoes', 'promissores', 'novos'],
  volte_a_pedir: ['em_risco', 'nao_posso_perder'],
};

/** Com menos gente que isto, a mensagem não vale a análise da Meta nem a atenção de quem aprova. */
export const PESSOAS_NO_MINIMO = 10;

const DIA_MS = 86_400_000;

/**
 * O público da mensagem: entre os perfis do motivo, o que tem mais pessoas que podem receber (o RegemCast já tira
 * quem pediu para sair e quem não tem WhatsApp). No empate, o primeiro da lista do motivo. Nulo quando nenhum chega
 * ao mínimo: sem público, ele não propõe. Sai no formato em que a proposta o guarda.
 */
export function publicoDoMotivo(publicos: Pick<PublicosRegemcast, 'perfis'>, motivo: MotivoDaMensagem): PropostaNova['publico'] | null {
  let escolhido: PropostaNova['publico'] | null = null;
  for (const id of PERFIS_DO_MOTIVO[motivo]) {
    const perfil = publicos.perfis.find((p) => p.id === id);
    if (!perfil || perfil.pessoas < PESSOAS_NO_MINIMO) continue;
    if (!escolhido || perfil.pessoas > escolhido.pessoas) escolhido = { origem: { origem: 'perfil', id: perfil.id }, nome: perfil.nome, regra: perfil.regra, pessoas: perfil.pessoas };
  }
  return escolhido;
}

/** Duas ofertas são a mesma quando o texto é igual, sem contar espaços nas pontas nem maiúsculas. */
const mesmaOferta = (a: string, b: string) => a.trim().toLocaleLowerCase('pt-BR') === b.trim().toLocaleLowerCase('pt-BR');

/**
 * A oferta pode ir ao funcionário? As mesmas regras do pedido (`conferirPedidoDoCrm`): nada de política, de categoria
 * que as plataformas proíbem, de bebida alcoólica nem de dado pessoal.
 */
export function ofertaPodeVirarMensagem(oferta: string): boolean {
  if (!oferta.trim()) return false;
  const problemas = conferirPedidoDoCrm({ motivo: 'promocao', oferta, publico: { nome: '', regra: null, pessoas: 1 }, cupom: { beneficio: '', validade: '' } });
  return !problemas.some((p) => p.campo === 'oferta');
}

/**
 * A oferta que ele divulga agora: a primeira de Minha marca (na ordem em que a empresa as escreveu) que pode virar
 * mensagem e que não virou proposta nos últimos 30 dias. A que as regras não deixam divulgar é pulada aqui, na
 * escolha: se ela fosse escolhida e recusada depois, voltaria a ser escolhida para sempre, e as outras nunca teriam a
 * vez. Nula quando não há oferta que sirva.
 */
export function ofertaDaVez(ofertas: readonly string[], usadas: readonly { oferta: string; em: Date }[], agora: Date): string | null {
  const desde = agora.getTime() - DIAS_PARA_REPETIR_A_OFERTA * DIA_MS;
  const recentes = usadas.filter((u) => u.em.getTime() > desde);
  for (const oferta of ofertas) {
    if (!ofertaPodeVirarMensagem(oferta)) continue;
    if (!recentes.some((u) => mesmaOferta(u.oferta, oferta))) return oferta;
  }
  return null;
}

/**
 * Já passou o intervalo desde a última proposta deste tipo, para a marca? `ultima` é quando a última nasceu (qualquer
 * que tenha sido o fim dela: a recusada e a barrada também contam, para ele não insistir); nula = nunca propôs.
 */
export function passouOIntervalo(motivo: MotivoDaMensagem, ultima: Date | null, agora: Date): boolean {
  if (!ultima) return true;
  return agora.getTime() - ultima.getTime() >= DIAS_ENTRE_PROPOSTAS[motivo] * DIA_MS;
}

/**
 * O que ele decidiu ao olhar uma marca, para um tipo de mensagem. Fica na fila do olhar (`message_routine.outcome`),
 * como código: serve a quem dá suporte e à próxima olhada. Só `proposta_aberta` quer dizer que ele propôs.
 */
export const RESULTADOS_DO_OLHAR = [
  'proposta_aberta',
  // A marca e as chaves.
  'marca_arquivada',
  'ia_desligada',
  'crm_desligado',
  'mensageria_desligada',
  'envio_desligado',
  'funcionario_desligado',
  // O que já existe.
  'em_andamento',
  'intervalo',
  // O que falta para propor.
  'sem_desconto',
  'sem_loja_do_cupom',
  'sem_responsavel',
  'sem_regemcast',
  'sem_autorizacao',
  'sem_permissao',
  'sem_dossie',
  'sem_oferta',
  'sem_publico',
  'teto_cheio',
  // O que não deu para saber agora.
  'regemcast_fora',
  'erro',
] as const;
export type ResultadoDoOlhar = (typeof RESULTADOS_DO_OLHAR)[number];

/** De quanto em quanto tempo ele olha cada marca, quando nada diz outra coisa. */
export const HORAS_ENTRE_OLHADAS = 24;
/** Quando o RegemCast não respondeu, ou algo falhou: ele olha de novo logo. */
export const HORAS_DEPOIS_DE_FALHA = 1;

const HORA_MS = 3_600_000;

/**
 * Quando ele olha a marca de novo. Uma vez por dia basta: o que muda a resposta (uma oferta nova, o desconto definido,
 * o público que cresceu) muda devagar. Duas exceções: o que falhou (o RegemCast fora do ar, um erro) é olhado de novo
 * em 1 hora; e, quando o que impede é só o intervalo entre propostas, ele volta quando o intervalo acabar (`ate`), se
 * isso for depois de amanhã.
 */
export function proximaOlhada(resultado: ResultadoDoOlhar, agora: Date, ate?: Date | null): Date {
  if (resultado === 'regemcast_fora' || resultado === 'erro') return new Date(agora.getTime() + HORAS_DEPOIS_DE_FALHA * HORA_MS);
  const amanha = agora.getTime() + HORAS_ENTRE_OLHADAS * HORA_MS;
  if (resultado === 'intervalo' && ate && ate.getTime() > amanha) return new Date(ate.getTime());
  return new Date(amanha);
}

/** Quando o intervalo desde a última proposta deste tipo acaba. */
export function fimDoIntervalo(motivo: MotivoDaMensagem, ultima: Date): Date {
  return new Date(ultima.getTime() + DIAS_ENTRE_PROPOSTAS[motivo] * DIA_MS);
}

/** O teto de gasto de mensagens do RegemCast está cheio em algum período (dia, semana ou mês)? Com ele cheio, ele não propõe (P16). */
export function tetoCheio(orcamento: { periodos: ReadonlyArray<{ sinal: string }> }): boolean {
  return orcamento.periodos.some((p) => p.sinal === 'cheio');
}

/** Sem as letras e os números que se confundem ao ler e ao digitar (O e 0, I e 1). */
export const LETRAS_DO_CODIGO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const COMECO_DO_CODIGO: Record<MotivoDaMensagem, string> = { promocao: 'PROMO', volte_a_pedir: 'VOLTE' };

/**
 * O código do cupom de uma mensagem: o começo diz o tipo, e as quatro letras do fim o tornam único ("PROMO7K3Q"). O
 * sorteio vem de quem chama (um número de 0 a menos de 1 a cada letra), para o teste ser exato. Se o código já existe
 * na loja, quem chama sorteia outro: quem garante que não repete é o banco.
 */
export function codigoDoCupom(motivo: MotivoDaMensagem, sorteio: () => number): string {
  let fim = '';
  for (let i = 0; i < 4; i++) fim += LETRAS_DO_CODIGO[Math.min(LETRAS_DO_CODIGO.length - 1, Math.max(0, Math.floor(sorteio() * LETRAS_DO_CODIGO.length)))];
  return `${COMECO_DO_CODIGO[motivo]}${fim}`;
}

/** Por quantos dias o cupom vale, contando o primeiro e o último. */
export function diasDoCupom(c: Pick<CupomDaMensagem, 'valido_de' | 'valido_ate'>): number {
  return Math.round((Date.parse(`${c.valido_ate}T12:00:00Z`) - Date.parse(`${c.valido_de}T12:00:00Z`)) / DIA_MS) + 1;
}

/**
 * O mesmo cupom, valendo a partir do dia dado pelos mesmos dias. A proposta nasce dias antes do envio (a Meta analisa
 * o modelo e uma pessoa aprova o pedido): as datas guardadas com ela dizem só por quantos dias o cupom vale, e as
 * datas de verdade são as do dia em que a mensagem sai.
 */
export function cupomNoDia(c: CupomDaMensagem, dia: string): CupomDaMensagem {
  return { ...c, valido_de: dia, valido_ate: somarDias(dia, diasDoCupom(c) - 1) };
}

/** "R$ 1.000,00", de centavos inteiros. O espaço é o comum: este texto vai para o modelo de IA e para a conferência. */
const reais = (centavos: number) => `R$ ${Math.trunc(centavos / 100).toLocaleString('pt-BR')},${String(centavos % 100).padStart(2, '0')}`;

/**
 * O cupom em palavras, como o funcionário o recebe para escrever e como a conferência o usa de fonte (o preço e o
 * percentual da mensagem só podem ser os daqui). A validade vai em dias, e não em data: o texto do modelo é aprovado
 * pela Meta antes, e o envio acontece dias depois; uma data escrita poderia chegar vencida. "Hoje" é o dia em que a
 * pessoa recebe. O número de dias está sempre escrito, para a mensagem poder dizê-lo.
 */
export function cupomEmPalavras(c: Pick<CupomDaMensagem, 'tipo' | 'percentual' | 'valor_centavos' | 'pedido_minimo_centavos' | 'valido_de' | 'valido_ate'>): { beneficio: string; validade: string } {
  const desconto = c.tipo === 'percentual' ? `${c.percentual}% de desconto` : c.tipo === 'valor' ? `${reais(c.valor_centavos ?? 0)} de desconto` : 'entrega grátis';
  const minimo = c.pedido_minimo_centavos > 0 ? ` em pedidos a partir de ${reais(c.pedido_minimo_centavos)}` : '';
  const dias = diasDoCupom(c);
  return {
    beneficio: `${desconto}${minimo}`,
    validade: dias === 1 ? 'válido por 1 dia: só hoje' : `válido por ${dias} dias, contando hoje`,
  };
}

/** O idioma dos modelos que ele rascunha. */
export const IDIOMA_DO_MODELO = 'pt_BR';

/**
 * O nome do modelo na Meta: letras minúsculas, números e sublinhado, único por proposta (o id dela, sem os traços).
 * O nome que ele escreve para a mensagem é o da equipe da loja, e não serve de nome de modelo.
 */
export function nomeDoModelo(motivo: MotivoDaMensagem, propostaId: string): string {
  return `liame_${motivo}_${propostaId.replaceAll('-', '').toLowerCase()}`;
}

/** A chave de idempotência do rascunho do modelo no RegemCast: a mesma proposta rascunha o mesmo modelo. */
export const chaveDoModelo = (propostaId: string): string => `liame:modelo:${propostaId}`;

/**
 * O modelo que vai para o RegemCast como rascunho (quem o envia para a análise da Meta é uma pessoa, lá: D-A5-15): o
 * corpo conferido, o rodapé de saída, que é do sistema, e um exemplo para cada variável, que a Meta pede: um primeiro
 * nome que não é de ninguém e o código do cupom.
 */
export function modeloParaRascunhar(p: { id: string; motivo: MotivoDaMensagem; corpo: string; codigoDoCupom: string }): ModeloParaRascunhar {
  return {
    nome: nomeDoModelo(p.motivo, p.id),
    categoria: 'marketing',
    idioma: IDIOMA_DO_MODELO,
    corpo: p.corpo,
    corpoExemplos: [NOME_DE_EXEMPLO, p.codigoDoCupom],
    rodape: RODAPE_DE_SAIDA,
  };
}

/**
 * O valor de cada variável do modelo, na ordem: `{{1}}` é o primeiro nome de quem recebe, que o RegemCast preenche (o
 * Liame não tem o nome de ninguém); `{{2}}` é o código do cupom, fixo.
 */
export function variaveisDaMensagem(codigoDoCupom: string): VariavelDaMensagem[] {
  return [{ origem: 'primeiro_nome' }, { origem: 'fixo', valor: codigoDoCupom }];
}

/**
 * A proposta guardada vira a proposta de mensagem que o pedido de envio confere e monta (`PropostaDeMensagem`): o nome
 * que ele escreveu, o modelo que a Meta aprovou, o público escolhido, as duas variáveis e o cupom, valendo a partir do
 * dia dado (o dia da loja em que o pedido é montado; no envio, as datas andam de novo).
 */
export function propostaParaOPedido(
  p: { brandId: string; conta: string; nome: string; modelo: { nome: string; idioma: string }; publico: PropostaDeMensagem['publico']; cupom: CupomDaMensagem },
  dia: string,
): z.input<typeof PropostaDeMensagem> {
  return {
    marca: p.brandId,
    conta: p.conta,
    nome: p.nome,
    modelo: { nome: p.modelo.nome, idioma: p.modelo.idioma },
    publico: p.publico,
    variaveis: variaveisDaMensagem(p.cupom.codigo),
    cupom: cupomNoDia(p.cupom, dia),
  };
}
