import type { CouponCampaign, CouponItem, CouponListResponse, CouponStore, OrderPlatform } from '@liame/contracts';
import { dia, quandoComHora, reaisDeMicros } from '@/lib/formato';

// Regras e textos da aba Cupons e da plataforma de pedidos da loja (mockups/prototipo-links-cupons-
// plataforma.html, aprovado em 30/09/2026). Só o cupom exclusivo prova de onde veio o pedido; o Liame não
// cria nem muda nada no Regem nem na plataforma de pedidos (a criação no Regem, com aprovação, vem depois).

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

/** "15% · mín. R$ 50", "R$ 5 · sem mínimo", "Entrega grátis · mín. R$ 40"; o informado mostra de onde veio. */
export function regraDoCupom(c: CouponItem, agora: Date): string {
  if (c.origin === 'externo' && c.platform) {
    const quando = dia(c.first_seen_at, agora);
    return `Cupom ${infoPlataforma(c.platform as OrderPlatform).de} · informado ${quando === 'hoje' ? 'hoje' : `em ${quando}`}`;
  }
  let base: string;
  if (c.kind === 'percentual' && c.percent !== null) base = `${c.percent.toLocaleString('pt-BR')}%${c.max_discount_micros ? ` até ${valor(c.max_discount_micros)}` : ''}`;
  else if (c.kind === 'valor' && c.value_micros) base = `${valor(c.value_micros)} de desconto`;
  else if (c.kind === 'frete_gratis') base = 'Entrega grátis';
  else base = 'Regra no Regem';
  const minimo = c.min_order_micros && BigInt(c.min_order_micros) > 0n ? `mín. ${valor(c.min_order_micros)}` : 'sem mínimo';
  return `${base} · ${minimo}`;
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
