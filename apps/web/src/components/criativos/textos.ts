import type { AdPieceFinding, AdPieceOptionsResponse, AdPieceRequestResponse, AdPieceResponse, AdPieceReview, AdPieceVersion } from '@liame/contracts';
import { custoNaTela, diaMesDe } from '@/components/equipe/textos';
import type { Frase, Trecho } from '@/components/resultados/textos';
import { Fontes, type LinhaDeFonte, type Texto } from '@/components/resumo/textos';
import type { NomeIcone } from '@/components/ui/icone';
import { inteiro, quandoComHora } from '@/lib/formato';

// Criativos (A4 · X8, parte 6; mockups/prototipo-criativos.html, P10 aprovado em 05/10/2026): as peças de anúncio que
// o Criativo escreve a pedido de quem opera campanhas. Esta entrega é a do TEXTO (título, texto principal e botão); a
// imagem a partir da foto do produto e a campanha nova ficaram para o fim do roteiro. O que a API manda
// (`/v1/ad-pieces` e `/v1/ad-pieces/options`) vira o que a pessoa lê. Quem confere a peça é o servidor; aqui só se
// escreve. Funções puras: o "agora" entra como parâmetro.

type Opcoes = AdPieceOptionsResponse;
type Peca = AdPieceResponse;
type Cotacao = Opcoes['usd_brl'];

const b = (t: string): Trecho => ({ t, b: true });
const maiuscula = (s: string) => s.charAt(0).toLocaleUpperCase('pt-BR') + s.slice(1);
const vezes = (n: number, um: string, varios: string) => `${inteiro(n)} ${n === 1 ? um : varios}`;
const emLista = (itens: string[]) => (itens.length < 2 ? itens.join('') : `${itens.slice(0, -1).join(', ')} e ${itens.at(-1)}`);

export const SUBTITULO = 'O texto dos seus anúncios, escrito pelo Criativo a partir do que você já vende. O Compliance confere cada peça antes de ela aparecer, e nada vai para a Meta por aqui.';

export const BOTOES: Record<string, string> = { pedir_agora: 'Pedir agora', ver_cardapio: 'Ver cardápio', enviar_mensagem: 'Enviar mensagem' };
export const botaoEscrito = (botao: string): string => BOTOES[botao] ?? botao.replaceAll('_', ' ');
export const DESTINOS: Record<string, { rotulo: string; site: string }> = {
  cardapio: { rotulo: 'O cardápio da loja', site: 'Cardápio online' },
  whatsapp: { rotulo: 'Uma conversa no WhatsApp', site: 'WhatsApp' },
};
export const MOTIVOS_DA_RECUSA: Array<{ valor: 'texto_nao_serve' | 'nao_parece_a_marca' | 'nao_preciso_mais'; rotulo: string }> = [
  { valor: 'texto_nao_serve', rotulo: 'O texto não serve' },
  { valor: 'nao_parece_a_marca', rotulo: 'Não parece a minha marca' },
  { valor: 'nao_preciso_mais', rotulo: 'Não preciso mais' },
];
const MOTIVO_ESCRITO: Record<string, string> = { texto_nao_serve: 'O texto não serve', nao_parece_a_marca: 'Não parece a minha marca', nao_preciso_mais: 'Não preciso mais', outro: 'Outro motivo' };
export const SUGESTOES_DE_MUDANCA = ['Mais curto', 'Sem o preço', 'Fale da retirada no balcão'];
/** As quantidades que o pedido oferece (o protótipo), dentro do que o servidor aceita. */
export function variacoesDoPedido(limites: Opcoes['limits']): number[] {
  return [2, 3, 4].filter((n) => n >= limites.variations_min && n <= limites.variations_max);
}

// ------------------------------------------------------------------ a conferência do Compliance

export const ehBarrada = (p: Pick<Peca, 'current'>): boolean => p.current.review.status === 'barrou';
export const temAviso = (p: Pick<Peca, 'current'>): boolean => p.current.review.status === 'aviso';
/** A peça espera a decisão de alguém e pode ser aprovada agora. */
export const podeAprovar = (p: Peca): boolean => p.status === 'decidir' && !p.redoing && !ehBarrada(p);

export interface ResumoDaConferencia {
  situacao: 'ok' | 'aviso' | 'falha';
  classe: string;
  icone: NomeIcone;
  texto: string;
  curto: string;
}

export function resumoDaConferencia(r: AdPieceReview): ResumoDaConferencia {
  const [falhas, avisos, total] = [r.items.filter((i) => i.status === 'barrou').length, r.items.filter((i) => i.status === 'aviso').length, r.items.length];
  if (falhas) return { situacao: 'falha', classe: 'st st--perigo', icone: 'ban', texto: `Barrada em ${falhas} de ${total} conferências`, curto: 'Barrada pelo Compliance' };
  if (avisos) return { situacao: 'aviso', classe: 'st st--aguardando', icone: 'alert', texto: `Passou em ${total - avisos} ${total - avisos === 1 ? 'conferência' : 'conferências'} e tem ${avisos === 1 ? '1 aviso' : `${avisos} avisos`}`, curto: 'Passou, com aviso' };
  return { situacao: 'ok', classe: 'st st--concluido', icone: 'check', texto: `Passou nas ${total} conferências`, curto: 'Passou na conferência' };
}

/** As regras de texto do servidor, como a pessoa lê; nome novo aparece sem os traços. */
const REGRA: Record<string, string> = {
  politico_eleitoral: 'conteúdo político ou eleitoral',
  promessa_de_resultado: 'promessa de resultado',
  categoria_proibida: 'categoria que as plataformas proíbem',
  dado_pessoal: 'dado pessoal',
  link: 'um link',
  bebida_alcoolica: 'bebida alcoólica',
  concorrente: 'o nome de um concorrente',
};
const nomeDaRegra = (k: string) => REGRA[k] ?? k.replaceAll('_', ' ');
const trecho = (f: AdPieceFinding) => `“${f.excerpt}”`;

export interface ItemDaConferencia {
  chave: string;
  situacao: 'ok' | 'aviso' | 'falha';
  titulo: string;
  texto: string;
}

const SITUACAO: Record<string, ItemDaConferencia['situacao']> = { passou: 'ok', aviso: 'aviso', barrou: 'falha' };

/** A conferência item por item, com o motivo de cada um. O item que a tela não conhece aparece pelo nome. */
export function itensDaConferencia(r: AdPieceReview, oferta: string, marca: string): ItemDaConferencia[] {
  return r.items.map((i) => {
    const situacao = SITUACAO[i.status] ?? 'aviso';
    const passou = situacao === 'ok';
    const achados = i.findings;
    switch (i.item) {
      case 'oferta':
        return passou
          ? { chave: i.item, situacao, titulo: 'O preço é o da oferta', texto: r.cites_value ? 'O valor que o texto cita é o da oferta, como está em Minha marca.' : 'O texto não cita preço.' }
          : {
              chave: i.item,
              situacao,
              titulo: 'O texto diz o que a oferta não diz',
              texto: `O texto traz ${emLista(achados.map((f) => (f.kind === 'preco_fora' ? `o preço ${trecho(f)}` : f.kind === 'gratis_fora' ? `${trecho(f)}` : `o número ${trecho(f)}`))) || 'um valor'}, que não está na oferta. Em Minha marca, ela é “${oferta}”.`,
            };
      case 'regras_da_liame':
        return passou
          ? { chave: i.item, situacao, titulo: 'Segue as regras da Liame e das plataformas', texto: 'Sem promessa de resultado, sem política e sem categoria que as plataformas proíbem.' }
          : { chave: i.item, situacao, titulo: 'Bate numa regra da Liame para anúncios', texto: `O texto tem ${emLista(achados.map((f) => `${nomeDaRegra(f.kind)} (${trecho(f)})`)) || 'um trecho que as regras não deixam'}.` };
      case 'regras_da_marca':
        return passou
          ? { chave: i.item, situacao, titulo: `Segue as regras da ${marca}`, texto: 'Nada do que Minha marca manda não dizer.' }
          : { chave: i.item, situacao, titulo: `Diz o que a ${marca} não diz`, texto: `O texto traz ${emLista(achados.map(trecho)) || 'um trecho que Minha marca manda não dizer'}.` };
      case 'tamanho': {
        const { title, body } = r.characters;
        const rec = r.recommended;
        if (passou) return { chave: i.item, situacao, titulo: 'Cabe no tamanho que a Meta recomenda', texto: `Título com ${title} de ${rec.title} caracteres e texto principal com ${body} de ${rec.body}.` };
        const partes = [
          ...(title > rec.title ? [`o título tem ${title} caracteres, e a Meta recomenda até ${rec.title}`] : []),
          ...(body > rec.body ? [`o texto principal tem ${body}, e a Meta recomenda até ${rec.body}`] : []),
        ];
        return { chave: i.item, situacao, titulo: 'Passa do tamanho que a Meta recomenda', texto: `${maiuscula(partes.join('; ')) || 'O texto passa do tamanho recomendado'}. É recomendação, não regra: dá para aprovar assim, editar ou pedir outra.` };
      }
      default:
        return { chave: i.item, situacao, titulo: maiuscula(i.item.replaceAll('_', ' ')), texto: achados.map(trecho).join(', ') };
    }
  });
}

/** O campo com os trechos que a conferência apontou em destaque: é o que a pessoa precisa achar para corrigir. */
export function textoMarcado(texto: string, campo: 'titulo' | 'texto', r: AdPieceReview): Array<{ t: string; marcado: boolean }> {
  const trechos = r.items
    .filter((i) => i.status === 'barrou')
    .flatMap((i) => i.findings)
    .filter((f) => f.field === campo && f.excerpt)
    .map((f) => f.excerpt);
  let partes: Array<{ t: string; marcado: boolean }> = [{ t: texto, marcado: false }];
  for (const alvo of trechos) {
    partes = partes.flatMap((p) => {
      if (p.marcado) return [p];
      const i = p.t.toLocaleLowerCase('pt-BR').indexOf(alvo.toLocaleLowerCase('pt-BR'));
      if (i < 0) return [p];
      return [
        { t: p.t.slice(0, i), marcado: false },
        { t: p.t.slice(i, i + alvo.length), marcado: true },
        { t: p.t.slice(i + alvo.length), marcado: false },
      ].filter((x) => x.t);
    });
  }
  return partes;
}

/** "27 de 40 caracteres", com a marca de quando passa do recomendado. */
export function contagem(atual: number, limite: number): { texto: string; acima: boolean } {
  return { texto: `${atual} de ${limite} caracteres${atual > limite ? ' (acima do recomendado)' : ''}`, acima: atual > limite };
}

// ------------------------------------------------------------------ a peça na lista

export interface Selo {
  classe: string;
  rotulo: string;
}

export function situacaoDaPeca(p: Peca): Selo {
  if (p.status === 'aprovada') return { classe: 'st st--concluido', rotulo: 'Aprovada' };
  if (p.status === 'recusada') return { classe: 'st st--espera', rotulo: 'Recusada' };
  if (p.redoing) return { classe: 'st st--ia', rotulo: `Fazendo a versão ${p.current.version + 1}` };
  return ehBarrada(p) ? { classe: 'st st--perigo', rotulo: 'Barrada' } : { classe: 'st st--aguardando', rotulo: 'Para decidir' };
}

/** O que o leitor de tela diz do cartão da peça. */
export function nomeDoCartao(p: Peca): string {
  return `Abrir a peça “${p.current.title}”, de ${p.offer}: ${situacaoDaPeca(p).rotulo.toLocaleLowerCase('pt-BR')}`;
}

export interface ParaDecidir {
  frase: Frase;
  /** As que passaram e podem ser aprovadas de uma vez (a tela oferece com duas ou mais). */
  passam: Peca[];
  barradas: number;
  /** "Aprovar as 3 peças que passaram na conferência?" */
  confirmacao: string;
}

/** O bloco "Para decidir": quantas passaram, quantas foram barradas e o que fazer. Nulo sem peça esperando. */
export function paraDecidir(pecas: Peca[], pode: boolean): ParaDecidir | null {
  const lista = pecas.filter((p) => p.status === 'decidir');
  if (!lista.length) return null;
  const passam = lista.filter(podeAprovar);
  const barradas = lista.filter((p) => !p.redoing && ehBarrada(p)).length;
  let frase: Frase;
  if (passam.length) {
    frase = [
      b(`${passam.length === 1 ? '1 peça passou' : `${passam.length} peças passaram`} na conferência${barradas ? ` e ${barradas === 1 ? '1 foi barrada' : `${barradas} foram barradas`}` : ''}.`),
      { t: pode ? ' Abra cada uma e decida. Aprovar guarda a peça na biblioteca; nada vai para a Meta agora.' : ' Quem opera campanhas decide cada uma.' },
    ];
  } else if (barradas) {
    frase = [
      b(`${barradas === 1 ? 'A peça que resta foi barrada' : `As ${barradas} peças que restam foram barradas`} na conferência.`),
      { t: pode ? ' Abra, veja o motivo e edite o texto, peça outra versão ou recuse.' : ' Quem opera campanhas pede outra versão ou recusa.' },
    ];
  } else {
    frase = [b('O Criativo está fazendo uma versão nova.'), { t: ' Ela aparece aqui quando passar pelo Compliance.' }];
  }
  return {
    frase,
    passam,
    barradas,
    confirmacao: `Aprovar as ${passam.length} peças que passaram na conferência? Elas vão para a biblioteca.${passam.some(temAviso) ? ' A que tem aviso de tamanho entra junto.' : ''} Nada vai para a Meta.`,
  };
}

/** O aviso quando as peças de um pedido ficam prontas, ou quando o pedido não deu certo. */
export function avisoDoPedidoPronto(pecas: Peca[]): string {
  const barradas = pecas.filter(ehBarrada).length;
  const passam = pecas.length - barradas;
  return `As peças estão prontas: ${passam === 1 ? '1 passou' : `${passam} passaram`} na conferência${barradas ? ` e ${barradas === 1 ? '1 foi barrada' : `${barradas} foram barradas`}` : ''}.`;
}

// ------------------------------------------------------------------ o uso de IA e o custo

export interface UsoDeIa {
  texto: Texto;
  /** Quanto do limite já foi usado, de 0 a 100. */
  porcento: number;
  cheio: boolean;
  fontes: LinhaDeFonte[];
}

const porcento = (gasto: string, teto: string): number => {
  const [g, t] = [BigInt(gasto), BigInt(teto)];
  if (t <= 0n) return 100;
  return Math.min(100, Number((g * 100n) / t));
};

/** "Uso de IA hoje: R$ 7,49 de R$ 20,00. As peças de hoje custaram R$ 1,29." O limite mostrado é o que está mais perto de acabar. */
export function usoDeIa(ai: NonNullable<Opcoes['ai']>, cotacao: Cotacao, fontes: Fontes): Omit<UsoDeIa, 'fontes'> {
  const doMes = ai.binding === 'mes';
  const faixa = doMes ? ai.month : ai.day;
  const reais = (micros: string) => custoNaTela(micros, cotacao);
  const gasto = fontes.n(reais(faixa.spent_usd_micros), `Liame · uso de IA da empresa ${doMes ? 'no mês' : 'hoje'} (todas as marcas e todos os funcionários de IA) · medido pelo sistema`);
  const texto: Texto = [b(doMes ? 'Uso de IA no mês:' : 'Uso de IA hoje:'), { t: ' ' }, { num: gasto }, { t: ` de ${reais(faixa.ceiling_usd_micros)}.` }];
  if (BigInt(ai.pieces_today_usd_micros) > 0n) {
    texto.push({ t: ' As peças de hoje custaram ' }, { num: fontes.n(reais(ai.pieces_today_usd_micros), 'Liame · custo das chamadas do Criativo hoje, nesta marca (inclusive as que não viraram peça) · medido pelo sistema') }, { t: '.' });
  }
  return { texto, porcento: porcento(faixa.spent_usd_micros, faixa.ceiling_usd_micros), cheio: BigInt(ai.remaining_usd_micros) <= 0n };
}

/** A estimativa do pedido, antes de pedir (D-A4-32). Nula quando o servidor não tem como estimar. */
export function estimativaDoPedido(ai: Opcoes['ai'], cotacao: Cotacao, variacoes: number): string | null {
  if (!ai?.request_estimate) return null;
  const e = ai.request_estimate;
  const reais = (micros: string) => custoNaTela(micros, cotacao);
  const doMes = ai.binding === 'mes';
  const faixa = doMes ? ai.month : ai.day;
  return `Estimativa: ${e.basis === 'historico' ? 'cerca de' : 'até'} ${reais(e.usd_micros)} (${vezes(variacoes, 'texto', 'textos')} e a conferência de cada peça). ${doMes ? 'Neste mês' : 'Hoje'} a empresa usou ${reais(faixa.spent_usd_micros)} de ${reais(faixa.ceiling_usd_micros)} do limite de IA.`;
}

/** O custo de pedir outra versão, na linha de baixo do formulário. */
export function custoDeOutraVersao(ai: Opcoes['ai'], cotacao: Cotacao): string {
  const e = ai?.request_estimate;
  const custo = e ? `Custa ${e.basis === 'historico' ? 'cerca de' : 'até'} ${custoNaTela(e.usd_micros, cotacao)} e entra no limite de IA da empresa.` : 'Entra no limite de IA da empresa.';
  return `${custo} A versão nova passa pelo Compliance antes de aparecer.`;
}

export interface CustoDaPeca {
  linhas: Array<{ rotulo: string; valor: string }>;
  total: string | null;
  nota: string | null;
}

/** O custo da versão à vista e, com mais de uma, o de todas. A versão que uma pessoa escreveu não custa IA. */
export function custoDaPeca(p: Peca, v: AdPieceVersion, cotacao: Cotacao): CustoDaPeca {
  const reais = (micros: string) => custoNaTela(micros, cotacao);
  const versoes = p.versions ?? [p.current];
  const soma = versoes.reduce((a, x) => a + BigInt(x.cost_usd_micros ?? '0'), 0n);
  return {
    linhas: [{ rotulo: v.author === 'pessoa' ? 'Esta versão (texto escrito por uma pessoa)' : 'Esta versão (texto do Criativo)', valor: v.cost_usd_micros === null ? 'sem custo de IA' : reais(v.cost_usd_micros) }],
    total: versoes.length > 1 ? `As ${versoes.length} versões desta peça custaram ${reais(String(soma))} em IA.` : null,
    nota: 'Uma chamada escreve todas as peças do pedido, e o custo é dividido entre as que ficaram. A conferência é feita por código, sem custo de IA.',
  };
}

// ------------------------------------------------------------------ o que impede de pedir, e os avisos da tela

export interface AvisoDaTela {
  chave: string;
  tipo: 'acao' | 'atencao';
  icone: NomeIcone;
  titulo: string;
  texto: string;
  /** Um atalho para a tela que resolve. */
  link: { href: string; rotulo: string } | null;
}

/** Por que o botão "Pedir uma peça" não pede agora, em uma frase; nulo quando dá para pedir. */
export function motivoDeNaoPedir(o: Opcoes): string | null {
  if (o.available) return null;
  switch (o.reason) {
    case 'criativo_desligado':
      return 'O Criativo não está ligado para esta empresa: quem liga é a Liame, a pedido do dono.';
    case 'sem_dossie':
      return 'Minha marca ainda não foi preenchida: o Criativo parte de uma oferta de lá.';
    case 'sem_oferta':
      return 'Minha marca ainda não tem oferta: cadastre a primeira para pedir uma peça.';
    case 'limite_de_ia':
      return 'O limite de uso de IA da empresa foi atingido: pedir peça nova volta quando houver limite.';
    case 'lote_em_andamento':
      return 'O Criativo ainda está fazendo o pedido anterior. Espere ele terminar para pedir outro.';
    default:
      return 'Não dá para pedir uma peça agora.';
  }
}

/** Por que "Pedir outra" não pede agora: o Criativo desligado ou o limite de IA. Um pedido novo na fila não impede refazer uma peça. */
export function motivoDeNaoRefazer(o: Opcoes): string | null {
  if (o.reason === 'criativo_desligado' || o.reason === 'limite_de_ia') return motivoDeNaoPedir(o);
  if (o.ai !== null && !o.ai.fits) return 'O limite de uso de IA da empresa foi atingido: pedir outra versão volta quando houver limite.';
  return null;
}

/** As faixas do topo da tela: o que está desligado, o limite de IA e quem só acompanha. */
export function avisosDaTela(o: Opcoes, pode: boolean): AvisoDaTela[] {
  const avisos: AvisoDaTela[] = [];
  if (o.reason === 'criativo_desligado') {
    avisos.push({
      chave: 'desligado',
      tipo: 'atencao',
      icone: 'info',
      titulo: 'O Criativo não está ligado nesta empresa',
      texto: 'As peças que já existem continuam aqui. Para pedir peças novas, a IA e o Criativo precisam estar ligados: quem liga é a Liame, a pedido do dono.',
      link: null,
    });
  } else if (o.reason === 'limite_de_ia' || (o.ai !== null && !o.ai.fits)) {
    const doMes = o.ai?.binding === 'mes';
    avisos.push({
      chave: 'limite',
      tipo: 'atencao',
      icone: 'clock',
      titulo: `O limite de uso de IA ${doMes ? 'do mês' : 'de hoje'} foi atingido${o.ai ? ` (${custoNaTela(doMes ? o.ai.month.ceiling_usd_micros : o.ai.day.ceiling_usd_micros, o.usd_brl)})` : ''}`,
      texto: `Dá para aprovar, editar e recusar as peças que já existem. Pedir peça nova volta ${doMes ? 'no mês que vem' : 'amanhã'}, ou quando o limite da empresa for revisto.`,
      link: null,
    });
  } else if (o.reason === 'sem_dossie' || o.reason === 'sem_oferta') {
    avisos.push({
      chave: 'marca',
      tipo: 'acao',
      icone: 'palette',
      titulo: o.reason === 'sem_dossie' ? 'Minha marca ainda não foi preenchida' : 'Minha marca ainda não tem oferta',
      texto: 'O Criativo parte de uma oferta de Minha marca: o nome, o que é e o preço que uma pessoa conferiu. Ele não inventa oferta nem preço.',
      link: { href: '/marca', rotulo: 'Abrir Minha marca' },
    });
  }
  if (!pode) {
    avisos.push({ chave: 'leitor', tipo: 'acao', icone: 'lock', titulo: 'Você acompanha as peças por aqui', texto: 'Quem pede, aprova e recusa peça é quem opera campanhas: o Dono, o Administrador e o Gestor.', link: null });
  }
  return avisos;
}

const PROBLEMA_DA_OFERTA: Record<string, string> = {
  politico_eleitoral: 'conteúdo político ou eleitoral',
  categoria_proibida: 'categoria que as plataformas proíbem',
  bebida_alcoolica: 'bebida alcoólica (o Criativo não escreve anúncio de bebida alcoólica nesta fase)',
  dado_pessoal: 'dado pessoal',
  promessa_de_resultado: 'promessa de resultado',
};

/** A oferta no seletor do pedido: o texto e, quando ela não pode ir ao Criativo, o porquê. */
export function ofertaNoPedido(o: Opcoes['offers'][number]): { texto: string; impedida: string | null; semPreco: boolean } {
  const motivos = o.problems.map((p) => PROBLEMA_DA_OFERTA[p.reason] ?? p.reason.replaceAll('_', ' '));
  return { texto: o.text, impedida: motivos.length ? `Esta oferta não vai ao Criativo: ${emLista(motivos)}.` : null, semPreco: !o.has_value };
}

/** O anúncio de referência no seletor: "Combo sexta · carrossel · 27 pedidos em 7 dias". */
export function anuncioNoPedido(a: Opcoes['reference_ads'][number]): string {
  return `${a.name} · ${vezes(a.orders, 'pedido', 'pedidos')} em 7 dias`;
}

// ------------------------------------------------------------------ o pedido em andamento e o que não deu certo

export interface PassoDoPedido {
  situacao: 'ok' | 'agora' | 'depois';
  titulo: string;
  sub: string;
}

export interface PedidoEmAndamento {
  titulo: string;
  sub: string;
  passos: PassoDoPedido[];
}

/** O pedido que o Criativo está fazendo: o que já foi, o que é agora e o que vem. O servidor diz `pendente` (na fila) ou `gerando`. */
export function pedidoEmAndamento(r: AdPieceRequestResponse, agora: Date): PedidoEmAndamento {
  const etapa = r.status === 'gerando' ? 1 : 0;
  const base: Array<[string, string]> = [
    [r.reference ? 'Ler o anúncio de referência e Minha marca' : 'Ler Minha marca', r.reference ? `“${r.reference.name}” e a versão ${r.dossier_version} de Minha marca` : 'a oferta, a voz da casa e o que a marca não diz'],
    [`Escrever ${vezes(r.variations, 'texto', 'textos')}`, 'título, texto principal e botão'],
    ['Compliance: conferir cada peça', 'só então elas aparecem para você'],
  ];
  return {
    titulo: `O Criativo está fazendo ${vezes(r.variations, 'peça', 'peças')} para “${r.offer}”`,
    sub: `Pedido${r.requested_by ? ` por ${r.requested_by.name}` : ''} ${quandoComHora(r.created_at, agora)}${r.instruction ? ` · “${r.instruction}”` : ''}`,
    passos: base.map(([titulo, sub], i) => ({ situacao: i < etapa ? 'ok' : i === etapa ? 'agora' : 'depois', titulo, sub: i < etapa ? 'feito' : i === etapa ? (r.status === 'pendente' ? `na fila · ${sub}` : `agora · ${sub}`) : sub })),
  };
}

const MOTIVO_DO_PEDIDO: Record<string, string> = {
  politica: 'o pedido bate numa regra de anúncio',
  bebida_alcoolica: 'a oferta ou a instrução cita bebida alcoólica, e o Criativo não escreve anúncio de bebida alcoólica nesta fase',
  categoria_proibida: 'a oferta é de uma categoria que as plataformas proíbem',
  sem_peca: 'nenhum texto passou na conferência',
  formato: 'o texto veio fora do formato esperado',
  ia_fora_do_ar: 'a IA não respondeu',
  limite_de_ia: 'o limite de uso de IA da empresa foi atingido',
};

/** O pedido de peças novas que não deu certo (o mais recente): o que houve e o que fazer. Nulo quando deu certo ou ainda anda. */
export function pedidoQueNaoDeuCerto(r: AdPieceRequestResponse, agora: Date): { titulo: string; sub: string; tipo: 'atencao' | 'perigo'; aviso: string; texto: string } | null {
  if (r.piece_id !== null || (r.status !== 'recusado' && r.status !== 'falhou')) return null;
  const motivo = MOTIVO_DO_PEDIDO[r.reason ?? ''] ?? 'o pedido não pôde ser atendido';
  return {
    titulo: `As peças de “${r.offer}” não ficaram prontas`,
    sub: `Pedido${r.requested_by ? ` por ${r.requested_by.name}` : ''} ${quandoComHora(r.created_at, agora)}${r.instruction ? ` · “${r.instruction}”` : ''}`,
    tipo: r.status === 'falhou' ? 'perigo' : 'atencao',
    aviso: r.status === 'falhou' ? `O pedido falhou: ${motivo}` : `O Criativo não fez este pedido: ${motivo}`,
    texto: r.status === 'falhou' ? 'Nenhuma peça foi feita. Peça de novo em alguns minutos.' : 'Nenhuma peça foi feita. Mude a oferta ou a instrução e peça de novo.',
  };
}

// ------------------------------------------------------------------ a peça aberta

export interface CabecalhoDaPeca {
  quem: string;
  quando: string;
  chips: Selo[];
  versao: string;
}

export function cabecalhoDaPeca(p: Peca, v: AdPieceVersion, agora: Date): CabecalhoDaPeca {
  const r = resumoDaConferencia(v.review);
  const sit = situacaoDaPeca(p);
  return {
    quem: 'Criativo',
    quando: `${quandoComHora(p.current.created_at, agora)} · para “${p.offer}”`,
    chips: [{ classe: r.classe, rotulo: r.curto }, ...(sit.rotulo === 'Barrada' ? [] : [sit])],
    versao: `versão ${v.version}${v.author === 'pessoa' ? ` · editada${v.created_by ? ` por ${v.created_by.name}` : ''}` : ''}`,
  };
}

export interface ResultadoDaPeca {
  tom: 'ok' | 'espera' | 'falha' | 'neutro';
  icone: NomeIcone;
  forte: string;
  texto: string;
}

/** O que já aconteceu com a peça: sendo refeita, aprovada, recusada ou barrada. Nulo na peça que só espera a decisão. */
export function resultadoDaPeca(p: Peca, v: AdPieceVersion, agora: Date, pode: boolean, marca: string): ResultadoDaPeca | null {
  const atual = v.version === p.current.version;
  if (p.redoing) return { tom: 'espera', icone: 'clock', forte: `O Criativo está fazendo a versão ${p.current.version + 1}.`, texto: ' Ela passa pelo Compliance antes de aparecer aqui.' };
  const quem = p.decided_by ? ` por ${p.decided_by.name}` : '';
  const quando = p.decided_at ? ` ${quandoComHora(p.decided_at, agora)}` : '';
  if (p.status === 'aprovada') {
    return { tom: 'ok', icone: 'check', forte: `Aprovada${quem}${quando} (versão ${p.current.version}).`, texto: ' Está na biblioteca. Nada foi para a Meta: criar a campanha com a peça chega numa próxima fase.' };
  }
  if (p.status === 'recusada') {
    const d = p.decisions?.find((x) => x.decision === 'recusada');
    const motivo = d ? `“${MOTIVO_ESCRITO[d.reason ?? ''] ?? 'Sem motivo'}${d.comment ? `: ${d.comment}` : ''}”` : null;
    return { tom: 'neutro', icone: 'x', forte: `Recusada${quem}${quando}${motivo ? ':' : '.'}`, texto: `${motivo ? ` ${motivo}.` : ''} O motivo fica guardado com a peça. Nada foi para a Meta.` };
  }
  if (v.review.status === 'barrou') {
    const falha = itensDaConferencia(v.review, p.offer, marca).find((i) => i.situacao === 'falha');
    const titulo = falha ? `${falha.titulo.charAt(0).toLocaleLowerCase('pt-BR')}${falha.titulo.slice(1)}` : 'o texto bate numa regra';
    return {
      tom: 'falha',
      icone: 'ban',
      forte: `Barrada pelo Compliance: ${titulo}.`,
      texto: ` Esta versão não pode ser aprovada nem ir para a Meta.${!atual ? ' Por isso existe uma versão mais recente.' : pode ? ' Edite o texto, peça outra versão ou recuse a peça.' : ''}`,
    };
  }
  return null;
}

export interface OrigemDaPeca {
  icone: NomeIcone;
  forte: string;
  texto: Texto;
}

/** "De onde veio": o anúncio de referência, Minha marca, o que foi feito com IA e o aviso de uso (D-A4-33). */
export function origemDaPeca(p: Peca, v: AdPieceVersion, pedido: AdPieceRequestResponse | null, anuncios: Opcoes['reference_ads'], periodo: Opcoes['reference_period'] | null, fontes: Fontes): OrigemDaPeca[] {
  const ref = pedido?.reference ?? null;
  const ad = ref?.ad_id ? anuncios.find((a) => a.ad_id === ref.ad_id) : null;
  const janela = periodo ? `${diaMesDe(periodo.from)} a ${diaMesDe(periodo.to)}` : 'últimos 7 dias';
  const itens: OrigemDaPeca[] = [];
  if (ref) {
    itens.push({
      icone: 'megaphone',
      forte: 'O que já vendeu:',
      texto: ad
        ? [{ t: ` o anúncio “${ref.name}”, com ` }, { num: fontes.n(inteiro(ad.orders), `Regem · pedidos confirmados no caixa com origem no anúncio “${ad.name}” · ${janela}`) }, { t: ` ${ad.orders === 1 ? 'pedido confirmado' : 'pedidos confirmados'} no caixa em 7 dias.` }]
        : [{ t: ` o anúncio “${ref.name}”, que o pedido indicou como referência.` }],
    });
  } else {
    itens.push({ icone: 'megaphone', forte: 'Sem anúncio de referência:', texto: [{ t: ' o Criativo partiu só de Minha marca.' }] });
  }
  itens.push({ icone: 'file', forte: `Minha marca${pedido ? ` (versão ${pedido.dossier_version})` : ''}:`, texto: [{ t: ` a voz da casa, a oferta (“${p.offer}”) e o que a marca não diz.` }] });
  if (pedido?.instruction) itens.push({ icone: 'message', forte: 'O que foi pedido:', texto: [{ t: ` “${pedido.instruction}”.` }] });
  itens.push({
    icone: 'sparkles',
    forte: 'Feito com IA:',
    texto: [{ t: v.author === 'pessoa' ? ' o texto desta versão foi escrito por uma pessoa, a partir do que o Criativo fez.' : ' o texto, pelo Criativo. Nenhum dado de cliente foi para o fornecedor de IA.' }],
  });
  itens.push({ icone: 'image', forte: 'A imagem:', texto: [{ t: ' por enquanto o Criativo faz só o texto. A imagem a partir da foto do seu produto chega numa próxima fase.' }] });
  itens.push({ icone: 'info', forte: 'Uso:', texto: [{ t: ' a peça é sua para anunciar. Como foi feita por IA, outra empresa pode receber uma parecida, e a lei de direito autoral protege o que é criado por uma pessoa.' }] });
  return itens;
}

/** O rótulo de cada versão: "Versão 2 · editada por Rodrigo · 14:20". */
export function rotuloDaVersao(v: AdPieceVersion, agora: Date): string {
  const autor = v.author === 'pessoa' ? `editada${v.created_by ? ` por ${v.created_by.name}` : ''}` : 'Criativo';
  return `Versão ${v.version} · ${autor} · ${quandoComHora(v.created_at, agora)}`;
}

/** Depois de salvar a edição ou de pedir outra versão. */
export function avisoDaVersaoNova(p: Peca, editada: boolean): { texto: string; tipo: 'ok' | 'perigo' } {
  const passou = !ehBarrada(p);
  return editada
    ? { texto: `Versão ${p.current.version} salva. A conferência foi feita de novo${passou ? ' e ela passou' : ': ela foi barrada'}.`, tipo: passou ? 'ok' : 'perigo' }
    : { texto: `A versão ${p.current.version} de “${p.current.title}” está pronta e ${passou ? 'passou na conferência' : 'foi barrada na conferência'}.`, tipo: passou ? 'ok' : 'perigo' };
}

/** O que a tela diz quando o servidor recusa uma decisão; `recarregar`: a peça mudou e a tela precisa ler de novo. */
export function erroDaPeca(problema: { code: string; title: string; detail?: string; errors?: Array<{ message: string }> | undefined }): { texto: string; recarregar: boolean } {
  const campos = problema.errors?.length ? ` ${problema.errors.map((e) => e.message).join(' ')}` : '';
  const texto = `${problema.detail ?? problema.title}${campos}`;
  return { texto, recarregar: ['peca-decidida', 'peca-mudou', 'peca-refazendo', 'oferta-mudou', 'nao-encontrado', 'ja-contestada'].includes(problema.code) };
}
