import type { CouponCampaign, CouponItem, CouponListResponse, CouponRequest, CouponStore, OrderPlatform } from '@liame/contracts';
import type { Problema } from '@/lib/api';
import { dia, quandoComHora, reaisDeMicros } from '@/lib/formato';

// Regras e textos da aba Cupons e da plataforma de pedidos da loja (mockups/prototipo-links-cupons-
// plataforma.html, aprovado em 30/09/2026). Só o cupom exclusivo prova de onde veio o pedido; o Liame não
// muda nada na plataforma de pedidos. No Regem, a única escrita é criar o cupom de campanha, e só depois da
// aprovação de quem pode aprovar (o pedido fica na lista enquanto espera).

type InfoPlataforma = {
  nome: string;
  /** "do Anota AI", "da Brendi". */
  de: string;
  /** "ao Anota AI", "à Brendi". */
  a: string;
  /** Os pedidos chegam ao Regem pela integração (com o código do cupom). */
  integrado: boolean;
  /** O cupom dela pode ser informado no Liame. */
  cupomExterno: boolean;
};

const PLATAFORMAS: Record<OrderPlatform, InfoPlataforma> = {
  regem: { nome: 'Cardápio do Regem', de: 'do Cardápio do Regem', a: 'ao Cardápio do Regem', integrado: true, cupomExterno: false },
  anotaai: { nome: 'Anota AI', de: 'do Anota AI', a: 'ao Anota AI', integrado: true, cupomExterno: true },
  cardapioweb: { nome: 'CardápioWeb', de: 'do CardápioWeb', a: 'ao CardápioWeb', integrado: true, cupomExterno: true },
  brendi: { nome: 'Brendi', de: 'da Brendi', a: 'à Brendi', integrado: false, cupomExterno: false },
  outra: { nome: 'outra plataforma', de: 'da outra plataforma', a: 'à outra plataforma', integrado: false, cupomExterno: false },
};

/** As opções do diálogo "Onde a loja recebe pedidos online", na ordem do protótipo. */
export const OPCOES_PLATAFORMA: { valor: OrderPlatform; titulo: string; texto: string }[] = [
  { valor: 'anotaai', titulo: 'Anota AI', texto: 'Os pedidos chegam ao Regem pela integração. Mede cada campanha pelo cupom exclusivo.' },
  { valor: 'cardapioweb', titulo: 'CardápioWeb', texto: 'Os pedidos chegam ao Regem pela integração. Mede cada campanha pelo cupom exclusivo.' },
  { valor: 'brendi', titulo: 'Brendi', texto: 'Os pedidos ainda não chegam ao Regem: por enquanto, o Liame não mede essas vendas.' },
  { valor: 'regem', titulo: 'Cardápio do Regem', texto: 'Mede pelo link com rastreio e pelo cupom exclusivo.' },
  { valor: 'outra', titulo: 'Outra plataforma', texto: 'Informe o endereço do cardápio.' },
];

export function infoPlataforma(p: OrderPlatform, url?: string | null): InfoPlataforma {
  const info = PLATAFORMAS[p];
  if (p !== 'outra' || !url) return info;
  // A outra plataforma é chamada pelo endereço que a loja informou.
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    /* o endereço veio conferido do servidor; sem ele, fica o texto como está */
  }
  return { ...info, nome: host, de: `de ${host}`, a: `a ${host}` };
}

export type PlataformaDaLoja = {
  plataforma: OrderPlatform;
  /** Informada pela empresa; falso = sugerida pelos anúncios (ou o padrão, o cardápio do Regem). */
  informada: boolean;
  info: InfoPlataforma;
};

/** A plataforma de pedidos da loja: a informada; sem ela, a sugerida pelos anúncios; sem sugestão, o cardápio do Regem. */
export function plataformaDaLoja(loja: CouponStore | null, sugerida: CouponListResponse['detected_platform']): PlataformaDaLoja {
  const p = loja?.order_platform ?? sugerida?.platform ?? 'regem';
  return { plataforma: p, informada: !!loja?.order_platform, info: infoPlataforma(p, loja?.order_platform_url) };
}

/** "Loja Centro", ou o nome da loja no Regem enquanto ela não está ligada a uma loja do Liame. */
export function nomeDaLoja(loja: CouponStore): string {
  return loja.unit?.name ?? loja.store_name;
}

const ROTULO_PROVIDER: Record<string, string> = { meta_ads: 'da Meta', google_ads: 'do Google Ads' };

/** A linha "Pedidos online da Loja Centro: Anota AI" com como o Liame mede. */
export function linhaPlataforma(loja: CouponStore, p: PlataformaDaLoja, sugerida: CouponListResponse['detected_platform']): { titulo: string; texto: string } {
  const { info } = p;
  const como =
    p.plataforma === 'regem'
      ? 'O Liame mede pelo link com rastreio e pelo cupom exclusivo.'
      : info.integrado
        ? `Os pedidos ${info.de} chegam ao Regem, mas sem o clique do anúncio: o Liame mede cada campanha pelo cupom exclusivo dela.`
        : `Os pedidos ${info.de} ainda não chegam ao Regem: por enquanto, o Liame não consegue medir essas vendas.`;
  const aviso = p.informada
    ? ''
    : sugerida && sugerida.platform === p.plataforma
      ? ` Sugerido pelos anúncios ativos ${ROTULO_PROVIDER[sugerida.provider] ?? ''} (${sugerida.host}): confirme.`
      : ' Confirme onde a loja recebe os pedidos.';
  const nome = p.plataforma === 'outra' ? info.nome : info.nome.charAt(0).toUpperCase() + info.nome.slice(1);
  return { titulo: `Pedidos online da ${nomeDaLoja(loja)}: ${nome}`, texto: `${como}${aviso}` };
}

/** Nota do diálogo da plataforma: de onde veio a sugestão. */
export function notaSugestao(sugerida: CouponListResponse['detected_platform']): string | null {
  if (!sugerida) return null;
  return `Detectado nos anúncios ativos ${ROTULO_PROVIDER[sugerida.provider] ?? ''}: ${sugerida.host}. Confirme ou troque.`.replace('  ', ' ');
}

/** Confere o endereço de "outra plataforma" antes de enviar (o servidor confere de novo). */
export function erroEnderecoPlataforma(url: string): string | null {
  return /^https:\/\/[^\s/]+\.[^\s]+$/.test(url.trim()) ? null : 'Informe o endereço do cardápio, começando com https://.';
}

// ─────────────────────────── cupons ───────────────────────────

/** Valor em reais sem centavos quando é redondo ("R$ 50"), com centavos quando não é ("R$ 12,90"). */
function valor(micros: string): string {
  return reaisDeMicros(micros, BigInt(micros) % 1_000_000n === 0n ? 0 : 2);
}

const diaMesNoFuso = (iso: string, fuso: string) => new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', timeZone: fuso }).format(new Date(iso));
/** O último dia da validade: o fim é exclusivo (começo do dia seguinte). */
const ultimoDia = (iso: string, fuso: string) => diaMesNoFuso(new Date(new Date(iso).getTime() - 1).toISOString(), fuso);

type Regra = { kind: string; percent: number | null; value_micros: string | null; min_order_micros: string | null; max_discount_micros?: string | null };

/** "15% · mín. R$ 50", "R$ 5 de desconto · sem mínimo", "Entrega grátis · mín. R$ 40". */
function textoDaRegra(c: Regra): string {
  let base: string;
  if (c.kind === 'percentual' && c.percent !== null) base = `${c.percent.toLocaleString('pt-BR')}%${c.max_discount_micros ? ` até ${valor(c.max_discount_micros)}` : ''}`;
  else if (c.kind === 'valor' && c.value_micros) base = `${valor(c.value_micros)} de desconto`;
  else if (c.kind === 'frete_gratis') base = 'Entrega grátis';
  else base = 'Regra no Regem';
  const minimo = c.min_order_micros && BigInt(c.min_order_micros) > 0n ? `mín. ${valor(c.min_order_micros)}` : 'sem mínimo';
  return `${base} · ${minimo}`;
}

/** A regra do cupom do Regem; o informado mostra de onde veio. */
export function regraDoCupom(c: CouponItem, agora: Date): string {
  if (c.origin === 'externo' && c.platform) {
    const quando = dia(c.first_seen_at, agora);
    return `Cupom ${infoPlataforma(c.platform as OrderPlatform).de} · informado ${quando === 'hoje' ? 'hoje' : `em ${quando}`}`;
  }
  return textoDaRegra(c);
}

/** "até 10/10", "02/10 a 31/10", "venceu em 20/09", "sem validade"; o informado: a regra fica na plataforma. */
export function validadeDoCupom(c: CouponItem, loja: CouponStore, agora: Date): string {
  if (c.origin === 'externo' && c.platform) return `regra e validade ficam no ${infoPlataforma(c.platform as OrderPlatform).nome}`;
  const fuso = loja.timezone;
  if (c.expired && c.valid_until) return `venceu em ${ultimoDia(c.valid_until, fuso)}`;
  const de = c.valid_from && new Date(c.valid_from).getTime() > agora.getTime() ? diaMesNoFuso(c.valid_from, fuso) : null;
  const ate = c.valid_until ? ultimoDia(c.valid_until, fuso) : null;
  if (de && ate) return `${de} a ${ate}`;
  if (ate) return `até ${ate}`;
  if (de) return `a partir de ${de}`;
  return 'sem validade';
}

/** Situação que tira a ação da linha: vencido ou desativado no Regem. */
export function situacaoDoCupom(c: CouponItem): 'vencido' | 'desativado' | null {
  if (c.expired) return 'vencido';
  if (!c.active) return 'desativado';
  return null;
}

/** Cupom exclusivo ligado, sem nenhum uso em 7 dias, com a campanha gastando: vale um aviso. */
export function semUsoComGasto(c: CouponItem): boolean {
  return !!c.link?.exclusive && c.uses_7d === 0 && !!c.link.campaign_spend_7d_micros && BigInt(c.link.campaign_spend_7d_micros) > 0n;
}

/** "exclusivo · prova a origem", com o período quando ele tem início adiante ou fim marcado. */
export function textoVinculo(c: CouponItem, loja: CouponStore, agora: Date): string {
  const l = c.link;
  if (!l) return '';
  const tipo = l.exclusive ? 'exclusivo · prova a origem' : 'não exclusivo · só acompanha';
  const partes = [tipo];
  if (new Date(l.starts_at).getTime() > agora.getTime()) partes.push(`a partir de ${diaMesNoFuso(l.starts_at, loja.timezone)}`);
  if (l.ends_at) partes.push(`até ${ultimoDia(l.ends_at, loja.timezone)}`);
  return partes.join(' · ');
}

export type FiltroCupom = 'todos' | 'ligados' | 'sem';

export function filtrarCupons(itens: CouponItem[], filtro: FiltroCupom): CouponItem[] {
  if (filtro === 'ligados') return itens.filter((c) => c.link);
  if (filtro === 'sem') return itens.filter((c) => !c.link);
  return itens;
}

/** Hoje (AAAA-MM-DD) no fuso da loja: o seletor de datas do vínculo começa nele. */
export function hojeNoFuso(fuso: string, agora = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit' }).format(agora);
}

export type ErrosLigar = { campanha?: string; exclusivo?: string; data?: string };

export function errosLigar(v: { campanha: string; exclusivo: '' | 'sim' | 'nao'; inicio: string; fim: string; hoje: string }): ErrosLigar {
  const e: ErrosLigar = {};
  if (!v.campanha) e.campanha = 'Escolha a campanha.';
  if (!v.exclusivo) e.exclusivo = 'Escolha se o cupom é exclusivo desta campanha.';
  if (v.inicio && v.inicio < v.hoje) e.data = 'O vínculo começa hoje ou depois.';
  else if (v.fim && v.inicio && v.fim < v.inicio) e.data = 'O fim do vínculo não pode ser antes do início.';
  return e;
}

export type ErrosExterno = { codigo?: string; campanha?: string; exclusivo?: string };

/** Mesmo formato que o Regem repassa e o servidor aceita; o código repetido na loja é recusado. */
export function errosExterno(v: { codigo: string; campanha: string; exclusivo: '' | 'sim' | 'nao'; existentes: string[] }): ErrosExterno {
  const e: ErrosExterno = {};
  const codigo = v.codigo.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,59}$/.test(codigo)) e.codigo = 'Use de 3 a 60 letras, números, ponto, hífen ou sublinhado, sem espaço.';
  else if (v.existentes.some((x) => x.toUpperCase() === codigo.toUpperCase())) e.codigo = 'Esse código já está na lista.';
  if (!v.campanha) e.campanha = 'Escolha a campanha do cupom.';
  if (!v.exclusivo) e.exclusivo = 'Escolha se o cupom é exclusivo desta campanha.';
  return e;
}

/** O aviso depois de ligar (ou de informar e ligar). */
export function avisoLigado(codigo: string, campanha: string, exclusivo: boolean, de?: string): string {
  return exclusivo
    ? `${codigo} ligado à campanha ${campanha} como exclusivo: os pedidos${de ? ` ${de}` : ''} com ele passam a contar para a campanha.`
    : `${codigo} ligado à campanha ${campanha} para acompanhar. Como não é exclusivo, não conta como evidência.`;
}

export function avisoDesligado(c: CouponItem, campanha: string): string {
  const onde = c.origin === 'externo' && c.platform ? `no ${infoPlataforma(c.platform as OrderPlatform).nome}` : 'no Regem';
  return `${c.code} desligado da campanha ${campanha}. O cupom continua valendo ${onde}.`;
}

// ─────────────────────────── criar cupom no Regem (com aprovação) ───────────────────────────

export type TipoDesconto = 'percentual' | 'valor' | 'frete_gratis';

/** "12,50", "12.5" ou "12" (reais) → micros em texto; nulo quando não é um valor em reais com até 2 casas. */
export function microsDeReais(texto: string): string | null {
  const t = texto.trim().replace(',', '.');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return null;
  const [reais, centavos = ''] = t.split('.');
  return (BigInt(reais!) * 1_000_000n + BigInt(centavos.padEnd(2, '0')) * 10_000n).toString();
}

export type ErrosCriar = { codigo?: string; valor?: string; minimo?: string; data?: string; campanha?: string };

export type CamposCriar = {
  codigo: string;
  tipo: TipoDesconto;
  /** Percentual (inteiro) ou valor em reais, conforme o tipo; ignorado na entrega grátis. */
  valor: string;
  /** Pedido mínimo em reais; vazio = sem mínimo. */
  minimo: string;
  inicio: string;
  fim: string;
  campanha: string;
};

/** Confere o pedido antes de enviar (o servidor confere de novo): `existentes` são os códigos da loja; `pedidos`, os que esperam. */
export function errosCriar(v: CamposCriar, ctx: { hoje: string; existentes: string[]; pedidos: string[] }): ErrosCriar {
  const e: ErrosCriar = {};
  const codigo = v.codigo.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,20}$/.test(codigo)) e.codigo = 'Use de 4 a 20 letras ou números, sem espaço nem acento.';
  else if (ctx.existentes.some((x) => x.toUpperCase() === codigo)) e.codigo = 'Esse código já existe nesta loja. Escolha outro.';
  else if (ctx.pedidos.some((x) => x.toUpperCase() === codigo)) e.codigo = 'Já existe um pedido de cupom com este código. Cancele o pedido ou escolha outro código.';
  if (v.tipo === 'percentual') {
    const n = Number(v.valor);
    if (!v.valor.trim()) e.valor = 'Informe o valor do desconto.';
    else if (!/^\d{1,3}$/.test(v.valor.trim()) || n < 1 || n > 100) e.valor = 'O percentual vai de 1 a 100, sem casas decimais.';
  } else if (v.tipo === 'valor') {
    const micros = microsDeReais(v.valor);
    if (!micros || BigInt(micros) <= 0n) e.valor = 'Informe o valor do desconto, em reais.';
  }
  if (v.minimo.trim() && microsDeReais(v.minimo) === null) e.minimo = 'Informe o pedido mínimo em reais, ou deixe em branco.';
  if (!v.inicio || !v.fim) e.data = 'Informe o início e o fim da validade.';
  else if (v.fim < v.inicio) e.data = 'O fim da validade não pode ser antes do início.';
  else if (v.fim < ctx.hoje) e.data = 'O fim da validade já passou.';
  if (!v.campanha) e.campanha = 'Escolha a campanha do cupom.';
  return e;
}

/** O corpo de `POST /v1/coupons/regem` a partir dos campos já conferidos. */
export function corpoDoPedido(v: CamposCriar, unidade: string, exclusivo: boolean) {
  const minimo = v.minimo.trim() ? microsDeReais(v.minimo) : null;
  return {
    unit_id: unidade,
    code: v.codigo.trim().toUpperCase(),
    kind: v.tipo,
    ...(v.tipo === 'percentual' ? { percent: Number(v.valor) } : {}),
    ...(v.tipo === 'valor' ? { value_micros: microsDeReais(v.valor) ?? '0' } : {}),
    ...(minimo && BigInt(minimo) > 0n ? { min_order_micros: minimo } : {}),
    valid_from: v.inicio,
    valid_until: v.fim,
    campaign_id: v.campanha,
    exclusive: exclusivo,
  };
}

/** A recusa do servidor no campo certo do diálogo; sem campo, a mensagem vai para o topo. */
export function erroDoPedido(p: Problema): { campo?: keyof ErrosCriar; mensagem: string } {
  const doCampo: Record<string, keyof ErrosCriar> = { code: 'codigo', percent: 'valor', value_micros: 'valor', min_order_micros: 'minimo', valid_from: 'data', valid_until: 'data', campaign_id: 'campanha' };
  const primeiro = p.errors?.[0];
  if (primeiro && doCampo[primeiro.path]) return { campo: doCampo[primeiro.path], mensagem: primeiro.message };
  if (p.code === 'acao-duplicada') return { campo: 'codigo', mensagem: 'Já existe um pedido de cupom com este código. Cancele o pedido ou escolha outro código.' };
  if (p.code === 'plano-recusado' && p.detail?.startsWith('Já existe')) return { campo: 'codigo', mensagem: 'Esse código já existe nesta loja. Escolha outro.' };
  if (p.code === 'campanha-encerrada' || p.code === 'campanha-fora-da-marca' || p.code === 'plataforma-sem-cupom') return { campo: 'campanha', mensagem: p.detail ?? p.title };
  if (p.code === 'escrita-desligada') return { mensagem: 'A criação de cupons está desligada para a sua empresa. Crie o cupom no Regem: ele aparece aqui na próxima leitura.' };
  return { mensagem: p.detail ?? p.title };
}

/** Como o pedido aparece na lista: esperando quem aprova, sendo criado no Regem, ou encerrado sem cupom. */
export type SituacaoPedido = 'aguardando' | 'criando' | 'falhou' | 'expirou';

export function situacaoDoPedido(p: CouponRequest): SituacaoPedido {
  if (p.status === 'aguardando_aprovacao') return 'aguardando';
  if (p.status === 'expirada') return 'expirou';
  if (p.status === 'falhou') return 'falhou';
  return 'criando';
}

/** Os pedidos que viram linha na tabela: o cupom ainda vai existir. */
export function pedidosEmAndamento(pedidos: CouponRequest[]): CouponRequest[] {
  return pedidos.filter((p) => ['aguardando', 'criando'].includes(situacaoDoPedido(p)));
}

/** "15% · mín. R$ 50", como a regra de um cupom que já existe. */
export function regraDoPedido(p: CouponRequest): string {
  return textoDaRegra(p);
}

const diaMes = (d: string) => d.split('-').reverse().slice(0, 2).join('/');

/** "02/10 a 31/10": a validade pedida, em dias da loja. */
export function validadeDoPedido(p: CouponRequest): string {
  return `${diaMes(p.valid_from)} a ${diaMes(p.valid_until)}`;
}

/** A faixa dos pedidos que esperam aprovação (protótipo P3); nula sem nenhum. */
export function faixaAguardando(pedidos: CouponRequest[]): { titulo: string; texto: string } | null {
  const esperando = pedidos.filter((p) => situacaoDoPedido(p) === 'aguardando');
  if (!esperando.length) return null;
  return {
    titulo: esperando.length === 1 ? `O cupom ${esperando[0]!.code} está aguardando aprovação` : `${esperando.length} cupons estão aguardando aprovação`,
    texto: 'Quem pode aprovar recebe o pedido. Depois de aprovado, o Liame cria o cupom no Regem e ele aparece aqui, já ligado à campanha.',
  };
}

/** O motivo de o cupom não ter sido criado, em palavras de gente (o do Regem já vem assim do servidor). */
function motivoDaFalha(motivo: string | null): string {
  if (!motivo) return 'O Regem não criou o cupom.';
  if (motivo.startsWith('escrita em')) return 'A criação de cupons foi desligada antes de o cupom ser criado.';
  if (motivo.startsWith('trava ativa')) return 'A parada de segurança estava ligada na hora de criar o cupom.';
  if (motivo.startsWith('sem aprovação')) return 'A aprovação não valia mais para este pedido.';
  if (motivo.startsWith('o recurso mudou')) return 'A situação do cupom mudou depois do pedido.';
  return motivo;
}

/** A faixa do pedido que terminou sem cupom: falhou (com o motivo) ou expirou sem aprovação. */
export function faixaDoPedidoEncerrado(p: CouponRequest): { titulo: string; texto: string } {
  if (situacaoDoPedido(p) === 'expirou') {
    return { titulo: `O pedido do cupom ${p.code} expirou sem aprovação`, texto: 'Ninguém aprovou no prazo de 3 dias, e nada foi criado no Regem. Se ainda quiser o cupom, peça de novo.' };
  }
  return { titulo: `O cupom ${p.code} não foi criado`, texto: `${motivoDaFalha(p.status_reason)} Nada mudou no Regem.` };
}

/** Por que a loja não pode pedir cupom, quando a criação está ligada para a empresa; nulo quando pode. */
export function bloqueioDaCriacao(loja: CouponStore): { titulo: string; texto: string } | null {
  if (!loja.unit) return { titulo: 'Ligue a loja para criar cupons por aqui', texto: 'Esta loja do Regem ainda não está ligada a uma loja do Liame. Ligue em Contas conectadas.' };
  if (!loja.can_create) {
    return {
      titulo: 'A loja não liberou a criação de cupons no Regem',
      texto: 'Para criar cupons por aqui, o dono da loja autoriza o Liame de novo no Regem com a chave "Criar cupom de campanha" ligada, em Contas conectadas. Enquanto isso, crie o cupom direto no Regem.',
    };
  }
  return null;
}

/** Campanhas ativas sem cupom exclusivo da loja (em vigor ou agendado): na loja de outra plataforma, é o que falta. */
export function campanhasSemCupom(campanhas: CouponCampaign[], itens: CouponItem[]): CouponCampaign[] {
  const cobertas = new Set(itens.filter((c) => c.link?.exclusive).map((c) => c.link!.campaign.id));
  return campanhas.filter((c) => c.status === 'ativa' && !cobertas.has(c.id));
}

/** A frase de onde vêm os cupons, no topo da aba. */
export function fonteDosCupons(loja: CouponStore, p: PlataformaDaLoja, agora: Date): { ponto: 'ok' | 'atraso' | 'off'; texto: string } {
  const nome = nomeDaLoja(loja);
  if (loja.coupons_error === 'sem_permissao') return { ponto: 'off', texto: `Cupons do Regem · ${nome} · a loja não liberou a leitura dos cupons no Regem.` };
  if (loja.coupons_error) return { ponto: 'atraso', texto: `Cupons do Regem · ${nome} · a última leitura falhou.` };
  const lidos = loja.coupons_read_at ? ` · lidos ${quandoComHora(loja.coupons_read_at, agora)}` : '';
  if (p.info.cupomExterno) return { ponto: 'ok', texto: `Cupons do Regem e os informados ${p.info.de} · ${nome}${lidos}. O cupom ${p.info.de} vive lá; aqui você informa o código e liga a uma campanha.` };
  if (!p.info.integrado) return { ponto: 'ok', texto: `Cupons do Regem · ${nome}${lidos}. Cupom ${p.info.de} ainda não conta: os pedidos de lá não chegam ao Regem.` };
  return { ponto: 'ok', texto: `Cupons do Regem · ${nome}${lidos}. Os cupons vivem no Regem; aqui você liga cada um a uma campanha.` };
}
