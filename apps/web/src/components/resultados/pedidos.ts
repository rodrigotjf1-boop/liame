import type { ClosedLoopResponse, OrderOrigin } from '@liame/contracts';
import { reaisDeMicros } from '@/lib/formato';
import { diaHoraNoFuso, grupoDeCanal, nomesDe } from './textos';

// "Pedido a pedido" e a gaveta "Origem do pedido" (protótipo P1): de onde veio cada pedido, com a
// evidência, a janela e a confiança que a API devolve (`GET /v1/results/orders`). Sem dado pessoal: o
// pedido aparece pelo número do Regem, canal e valor. Funções puras (o fuso entra como parâmetro).

export type FiltroPedidos = 'todos' | 'com' | 'sem' | 'cancelados';

export const FILTROS: { id: FiltroPedidos; rotulo: string }[] = [
  { id: 'todos', rotulo: 'Todos' },
  { id: 'com', rotulo: 'Com origem' },
  { id: 'sem', rotulo: 'Sem origem' },
  { id: 'cancelados', rotulo: 'Cancelados' },
];

/** Quantos pedidos a tela pede de uma vez (o teto da API). */
export const LIMITE_DE_PEDIDOS = 200;

const cancelado = (o: OrderOrigin) => o.status === 'cancelado';

export function filtrarPedidos(lista: OrderOrigin[], f: FiltroPedidos): OrderOrigin[] {
  if (f === 'com') return lista.filter((o) => !cancelado(o) && o.attribution.counted);
  if (f === 'sem') return lista.filter((o) => !cancelado(o) && o.attribution.status === 'sem_origem');
  if (f === 'cancelados') return lista.filter(cancelado);
  return lista;
}

export function contarPedidos(lista: OrderOrigin[]): Record<FiltroPedidos, number> {
  return {
    todos: lista.length,
    com: filtrarPedidos(lista, 'com').length,
    sem: filtrarPedidos(lista, 'sem').length,
    cancelados: filtrarPedidos(lista, 'cancelados').length,
  };
}

const CANAIS: Record<string, string> = {
  cardapio: 'Cardápio online',
  cardapio_online: 'Cardápio online',
  whatsapp: 'WhatsApp',
  whatsapp_bot: 'WhatsApp',
  ifood: 'iFood',
  '99food': '99Food',
  food99: '99Food',
  keeta: 'Keeta',
  anota_ai: 'Anota Aí',
  anotaai: 'Anota Aí',
  balcao: 'Balcão',
  mesa: 'Mesa',
  totem: 'Totem',
};

/** Nome do canal do pedido; canal que a tela não conhece mostra o grupo dele. */
export function nomeDoCanal(o: Pick<OrderOrigin, 'channel' | 'channel_group'>): string {
  return CANAIS[o.channel] ?? grupoDeCanal(o.channel_group);
}

/** "Nº 48352" para número; outro id do Regem aparece como veio (encurtado na tabela). */
export function numeroDoPedido(externalId: string): { curto: string; completo: string } {
  const numerico = externalId.length <= 12 && [...externalId].every((c) => c >= '0' && c <= '9');
  const completo = numerico ? `Nº ${externalId}` : externalId;
  return { completo, curto: completo.length > 16 ? `${completo.slice(0, 14)}…` : completo };
}

export type Confianca = { rotulo: string; classe: 'concluido' | 'info' | 'espera' | 'perigo'; ponto: boolean };

export function confiancaDe(o: OrderOrigin): Confianca {
  if (cancelado(o)) return { rotulo: 'Cancelado · fora do ROAS', classe: 'perigo', ponto: true };
  if (o.attribution.status === 'sem_origem') return { rotulo: 'Sem origem', classe: 'espera', ponto: false };
  if (o.attribution.status === 'plataforma') return { rotulo: 'Só a plataforma', classe: 'espera', ponto: true };
  if (o.attribution.confidence === 'alta') return { rotulo: 'Alta', classe: 'concluido', ponto: true };
  if (o.attribution.confidence === 'media') return { rotulo: 'Média', classe: 'info', ponto: true };
  return { rotulo: o.attribution.confidence ?? 'Sem confiança', classe: 'espera', ponto: true };
}

const EVIDENCIAS: Record<string, string> = {
  cupom: 'cupom exclusivo',
  clique_campanha: 'clique com campanha',
  conversa_anuncio: 'conversa por anúncio',
  clique_plataforma: 'clique só da plataforma',
  conversa_plataforma: 'conversa só da plataforma',
};

export function motivoDe(reason: string | null, janela: number): string {
  switch (reason) {
    case 'sem_evidencia':
      return 'Sem evidência de anúncio';
    case 'fora_da_janela':
      return `Toque fora da janela de ${janela} dias`;
    case 'sem_id':
      return 'Id da campanha ausente ou inválido';
    case 'canal_sem_clique':
      return 'Canal sem clique';
    case 'cancelado':
      return 'Pedido cancelado';
    default:
      return reason ? reason.replaceAll('_', ' ') : 'Sem evidência de anúncio';
  }
}

export type CelulaOrigem = { principal: string; sub: string | null; forte: boolean };

/** Coluna "Origem" da tabela. */
export function origemDoPedido(o: OrderOrigin): CelulaOrigem {
  const a = o.attribution;
  if (a.campaign) {
    const plat = a.provider ? nomesDe(a.provider).nome : null;
    const tipo = a.evidence ? (EVIDENCIAS[a.evidence] ?? a.evidence.replaceAll('_', ' ')) : null;
    return { principal: a.campaign.name, sub: [plat, tipo].filter(Boolean).join(' · ') || null, forte: true };
  }
  if (a.status === 'plataforma' && a.provider) return { principal: nomesDe(a.provider).nome, sub: 'sem campanha identificada', forte: true };
  return { principal: motivoDe(a.reason, a.window_days), sub: null, forte: false };
}

/** "33 minutos", "5 horas", "2 dias": do toque à confirmação. */
export function tempoAntes(toqueIso: string, pedidoIso: string): string {
  const minutos = Math.max(0, Math.round((Date.parse(pedidoIso) - Date.parse(toqueIso)) / 60_000));
  if (minutos < 60) return minutos === 1 ? '1 minuto' : `${minutos} minutos`;
  const horas = Math.round(minutos / 60);
  if (horas < 24) return horas === 1 ? '1 hora' : `${horas} horas`;
  const dias = Math.round(minutos / 1440);
  return dias === 1 ? '1 dia' : `${dias} dias`;
}

const CONFIANCA_POR_EXTENSO: Record<string, string> = { alta: 'confiança alta', media: 'confiança média' };

export type DetalheDoPedido = {
  titulo: string;
  dados: { rotulo: string; valor: string; riscado?: boolean; mono?: boolean }[];
  resultado:
    | { tipo: 'campanha'; campanha: string; plataforma: { nome: string; classe: string } | null; nota: string }
    | { tipo: 'plataforma'; plataforma: { nome: string; classe: string }; nota: string }
    | { tipo: 'sem'; motivo: string }
    | { tipo: 'cancelado'; campanha: string | null; plataforma: string | null };
  confianca: Confianca;
  evidencia: { texto: string; tom: 'normal' | 'sem' | 'cancelado' };
  comoSabe: string[];
  linhaDoTempo: { iso: string; quando: string; oque: string; usado: boolean }[];
  margem: string;
  modelo: string;
};

function frasesDaEvidencia(o: OrderOrigin, janela: number): string[] {
  const a = o.attribution;
  const quem = a.provider ? nomesDe(a.provider) : null;
  switch (a.evidence) {
    case 'cupom':
      return [
        'O cupom do pedido está ligado a esta campanha como exclusivo.',
        ...(o.channel_group === 'presencial' || o.channel_group === 'marketplace' || o.channel_group === 'outro'
          ? ['Este canal não tem clique: só um cupom exclusivo prova a campanha.']
          : []),
        'Na ordem do modelo, cupom exclusivo vem antes de qualquer clique.',
      ];
    case 'clique_campanha':
      return [
        'O link trouxe o id da campanha (ou do anúncio) nos parâmetros da URL.',
        'O cardápio guardou de onde o cliente veio enquanto a aba estava aberta e levou até o pedido.',
        'Sem cupom exclusivo no pedido, o clique com campanha é a evidência mais forte que ele tem.',
      ];
    case 'conversa_anuncio':
      return [
        'A conversa foi aberta pelo anúncio (o RegemCast manda o id do anúncio, sem nenhuma mensagem).',
        'O pedido é do mesmo cliente: o telefone vira um identificador pseudonimizado na chegada, e os dois batem.',
        'Confiança média: prova a pessoa, não o clique no cardápio.',
      ];
    case 'clique_plataforma':
      return [
        `O clique chegou com o id de clique ${quem?.de ?? 'da plataforma'}, que prova que veio de um anúncio dela.`,
        'O link não tinha o id da campanha: não dá para dizer de qual campanha.',
        `Conta no total ${quem?.de ?? 'da plataforma'} e fica fora de todas as campanhas.`,
      ];
    case 'conversa_plataforma':
      return [
        `A conversa foi aberta por um anúncio ${quem?.de ?? 'da plataforma'}, sem o id da campanha.`,
        'O pedido é do mesmo cliente: o telefone vira um identificador pseudonimizado na chegada, e os dois batem.',
        `Conta no total ${quem?.de ?? 'da plataforma'} e fica fora de todas as campanhas.`,
      ];
  }
  switch (a.reason) {
    case 'fora_da_janela':
      return [
        'Havia um toque de anúncio, mas antes da janela.',
        `O modelo conta até ${janela} dias do toque à confirmação do pedido.`,
        'Sem evidência dentro da janela, o pedido fica sem origem. O Liame não chuta.',
      ];
    case 'sem_id':
      return [
        'O acesso ao cardápio chegou sem o id da campanha (ou com o parâmetro sem trocar, como {{campaign.id}}) e sem id de clique.',
        'Id inválido conta como ausente, nunca é cortado nem adivinhado.',
        'Sem id e sem id de clique, o acesso não prova nem a campanha nem a plataforma.',
      ];
    case 'canal_sem_clique':
      return o.channel_group === 'marketplace'
        ? ['Pedido de marketplace chega sem nenhum identificador do cliente.', 'Só entraria numa campanha por cupom exclusivo.', 'Aparece em Canais sem clique, fora do ROAS de mídia própria.']
        : ['Este canal não tem clique: só um cupom exclusivo prova a campanha.', 'Aparece em Canais sem clique, fora do ROAS de mídia própria.'];
    default:
      return ['Pode ser quem já conhece a loja e pediu direto.', 'Pedido sem evidência fica sem origem: não vira “provavelmente de um anúncio”.'];
  }
}

function textoDaEvidencia(o: OrderOrigin, fuso: string, janela: number): string {
  const a = o.attribution;
  const partes: string[] = [];
  const quem = a.provider ? nomesDe(a.provider) : null;
  const alvo = a.ad ? `anúncio “${a.ad.name}”` : a.campaign ? `campanha ${a.campaign.name}` : null;
  switch (a.evidence) {
    case 'cupom':
      partes.push(`Cupom exclusivo da campanha ${a.campaign?.name ?? ''}`.trim(), 'usado no próprio pedido');
      break;
    case 'clique_campanha':
      partes.push(alvo ? `Clique no ${alvo}` : 'Clique com campanha');
      break;
    case 'conversa_anuncio':
      partes.push(alvo ? `Conversa aberta pelo ${alvo}` : 'Conversa aberta por anúncio');
      break;
    case 'clique_plataforma':
      partes.push(`Clique vindo ${quem?.de ?? 'da plataforma'}, sem o id da campanha`);
      break;
    case 'conversa_plataforma':
      partes.push(`Conversa aberta por anúncio ${quem?.de ?? 'da plataforma'}, sem o id da campanha`);
      break;
    default:
      if (a.reason === 'canal_sem_clique') return `Pedido ${o.channel_group === 'marketplace' ? 'de marketplace' : 'de canal sem clique'} (${nomeDoCanal(o)}) · sem clique nem cupom exclusivo`;
      if (a.reason === 'fora_da_janela') return `O último toque de anúncio foi antes da janela de ${janela} dias do pedido`;
      if (a.reason === 'sem_id') return 'Acesso ao cardápio sem o id da campanha e sem id de clique';
      return `Nenhum clique, conversa por anúncio ou cupom exclusivo nos ${janela} dias antes do pedido`;
  }
  if (a.touch_at && a.evidence !== 'cupom') {
    partes.push(diaHoraNoFuso(a.touch_at, fuso), `${tempoAntes(a.touch_at, o.confirmed_at)} antes do pedido`);
  }
  if (a.evidence === 'conversa_anuncio' || a.evidence === 'conversa_plataforma') partes.push('mesmo cliente');
  if (a.evidence !== 'cupom') partes.push(`janela de ${a.window_days} dias`);
  partes.push(a.status === 'plataforma' ? 'só a plataforma' : (CONFIANCA_POR_EXTENSO[a.confidence ?? ''] ?? `confiança ${a.confidence ?? 'desconhecida'}`));
  return partes.join(' · ');
}

function oQueFoiOToque(o: OrderOrigin): string {
  const a = o.attribution;
  const alvo = a.ad ? `anúncio “${a.ad.name}”` : a.campaign ? `campanha ${a.campaign.name}` : null;
  const quem = a.provider ? nomesDe(a.provider).de : 'da plataforma';
  switch (a.evidence) {
    case 'clique_campanha':
      return alvo ? `Clique no ${alvo}` : 'Clique com campanha';
    case 'conversa_anuncio':
      return alvo ? `Conversa aberta pelo ${alvo}` : 'Conversa aberta por anúncio';
    case 'clique_plataforma':
      return `Clique vindo ${quem}, sem campanha no link`;
    case 'conversa_plataforma':
      return `Conversa aberta por anúncio ${quem}, sem campanha`;
    default:
      return 'Toque do anúncio';
  }
}

/** Texto do modelo no pé da gaveta; a ordem das evidências só aparece para o modelo que a tela conhece. */
export function textoDoModelo(m: ClosedLoopResponse['model']): string {
  const nome = m.key === 'ultimo_toque' ? 'último toque' : m.key.replaceAll('_', ' ');
  const partes = [
    `Modelo ${nome}`,
    `versão ${m.version}`,
    `janela de ${m.window_days} dias do toque até a confirmação do pedido`,
    m.counts_views ? 'com visualização' : 'sem visualização',
  ];
  if (m.key === 'ultimo_toque' && m.version === 1) {
    partes.push('ordem das evidências: cupom exclusivo, clique com campanha, conversa por anúncio, clique só da plataforma, conversa só da plataforma');
  }
  return partes.join(' · ');
}

/** Tudo o que a gaveta mostra de um pedido. */
export function detalheDoPedido(o: OrderOrigin, ctx: { fuso: string; loja: string | null; modelo: ClosedLoopResponse['model'] }): DetalheDoPedido {
  const a = o.attribution;
  const janela = a.window_days || ctx.modelo.window_days;
  const numero = numeroDoPedido(o.external_id);
  const cancel = cancelado(o);
  const plat = a.provider ? nomesDe(a.provider) : null;
  const dados: DetalheDoPedido['dados'] = [
    { rotulo: 'Confirmado em', valor: diaHoraNoFuso(o.confirmed_at, ctx.fuso), mono: true },
    { rotulo: 'Canal', valor: nomeDoCanal(o) },
    { rotulo: 'Valor (definição de faturamento do Regem)', valor: reaisDeMicros(o.revenue_micros), riscado: cancel, mono: true },
  ];
  if (ctx.loja) dados.push({ rotulo: 'Loja', valor: ctx.loja });

  let resultado: DetalheDoPedido['resultado'];
  if (cancel) resultado = { tipo: 'cancelado', campanha: a.campaign?.name ?? null, plataforma: plat?.nome ?? null };
  else if (a.campaign) resultado = { tipo: 'campanha', campanha: a.campaign.name, plataforma: plat ? { nome: plat.nome, classe: plat.classe } : null, nota: 'conta no ROAS confirmado' };
  else if (a.status === 'plataforma' && plat) resultado = { tipo: 'plataforma', plataforma: { nome: plat.nome, classe: plat.classe }, nota: `conta no total ${plat.de}, fora das campanhas` };
  else resultado = { tipo: 'sem', motivo: motivoDe(a.reason, janela) };

  const comoSabe = cancel
    ? ['Cancelado no Regem: saiu do ROAS no recálculo. Pedido cancelado ou estornado não conta.', 'A origem continua registrada no pedido, para a conferência.']
    : frasesDaEvidencia(o, janela);

  const linhaDoTempo: DetalheDoPedido['linhaDoTempo'] = [];
  if (a.touch_at && a.evidence && a.evidence !== 'cupom') linhaDoTempo.push({ iso: a.touch_at, quando: diaHoraNoFuso(a.touch_at, ctx.fuso), oque: oQueFoiOToque(o), usado: true });
  linhaDoTempo.push({
    iso: o.confirmed_at,
    quando: diaHoraNoFuso(o.confirmed_at, ctx.fuso),
    oque: a.evidence === 'cupom' ? 'Pedido confirmado no caixa, com o cupom exclusivo' : 'Pedido confirmado no caixa',
    usado: a.evidence === 'cupom',
  });

  return {
    titulo: `Pedido ${numero.completo.startsWith('Nº') ? numero.completo.replace('Nº', 'nº') : numero.completo}`,
    dados,
    resultado,
    confianca: confiancaDe(o),
    evidencia: { texto: textoDaEvidencia(o, ctx.fuso, janela), tom: cancel ? 'cancelado' : a.status === 'sem_origem' ? 'sem' : 'normal' },
    comoSabe,
    linhaDoTempo,
    margem: cancel
      ? 'Fora da conta: pedido cancelado'
      : o.margin_micros === null
        ? 'Desconhecida: algum item do pedido está sem custo no Regem'
        : `${reaisDeMicros(o.margin_micros)} · todos os itens com custo`,
    modelo: textoDoModelo(ctx.modelo),
  };
}
