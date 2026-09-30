import type { LinkCampaignOption, LinkDestination, LinkSource, TrackingCheckResponse, TrackingLink } from '@liame/contracts';
import { quandoComHora } from '@/lib/formato';

// Regras e textos da tela "Links e cupons" (mockups/prototipo-links-cupons.html, P3 aprovado em
// 29/09/2026), aba Links: o link do cardápio com rastreio de cada campanha e os parâmetros para colar
// no anúncio. O Liame não escreve na Meta nem no Google; quem decide o que vale é o servidor.

const ROTULO_PLATAFORMA: Record<string, string> = { meta_ads: 'Meta Ads', google_ads: 'Google Ads' };

export function rotuloPlataforma(provider: string): string {
  return ROTULO_PLATAFORMA[provider] ?? provider;
}

/** Classe da etiqueta da plataforma (`plat--meta`, `plat--google`). */
export function classePlataforma(provider: string): string {
  return provider === 'google_ads' ? 'plat plat--google' : provider === 'meta_ads' ? 'plat plat--meta' : 'plat';
}

/** Onde colar os parâmetros, pelo campo que a API manda (base de conhecimento §2 e §3). */
export function ondeColar(field: string, provider: string, cardapio: string) {
  if (field === 'url_tags') {
    return {
      titulo: 'No anúncio, no campo “Parâmetros de URL”, cole:',
      copiado: 'Parâmetros da Meta copiados. Cole no campo “Parâmetros de URL” do anúncio.',
      dica: `O endereço do anúncio continua sendo o do cardápio (${cardapio}). A Meta troca o que está entre chaves pelo nome e pelos números da campanha, do conjunto e do anúncio.`,
    };
  }
  if (field === 'final_url_suffix') {
    return {
      titulo: 'No campo “Sufixo do URL final”, cole:',
      copiado: 'Sufixo do Google Ads copiado. Cole no campo “Sufixo do URL final”.',
      dica: `O URL final continua sendo o do cardápio (${cardapio}). O Google Ads troca o que está entre chaves pelos números da campanha, do grupo e do anúncio.`,
    };
  }
  return {
    titulo: `No anúncio do ${rotuloPlataforma(provider)}, cole:`,
    copiado: 'Parâmetros copiados.',
    dica: `O endereço do anúncio continua sendo o do cardápio (${cardapio}).`,
  };
}

/** "Meta e Google Ads", "Meta" ou "Google Ads", pelas contas lidas. */
function plataformasLidas(sources: LinkSource[]): string {
  const meta = sources.some((s) => s.provider === 'meta_ads');
  const google = sources.some((s) => s.provider === 'google_ads');
  if (meta && google) return 'da Meta e do Google Ads';
  if (google) return 'do Google Ads';
  return 'da Meta';
}

/** Quando a conferência vale: a leitura mais antiga entre as contas (a conferência é tão nova quanto ela). */
export function conferidoEm(sources: LinkSource[], agora: Date): string | null {
  const lidas = sources.map((s) => s.read_at).filter((r): r is string => !!r);
  if (!lidas.length) return null;
  const antiga = lidas.reduce((a, b) => (new Date(a).getTime() <= new Date(b).getTime() ? a : b));
  return quandoComHora(antiga, agora);
}

export type FaixaRastreio = {
  tipo: 'acao' | 'atencao' | undefined;
  icone: 'check' | 'alert' | 'info';
  titulo: string;
  texto: string;
  /** Há lista para abrir (anúncios sem rastreio ou não conferidos). */
  lista: boolean;
  botao: string;
};

/** A faixa da conferência dos anúncios ativos; `null` sem conta de anúncio lida. */
export function faixaRastreio(check: TrackingCheckResponse, agora: Date): FaixaRastreio | null {
  if (!check.sources.length) return null;
  const s = check.summary;
  const n = check.items.length;
  const botao = n === 1 ? 'Ver o anúncio' : `Ver os ${n} anúncios`;
  const quando = conferidoEm(check.sources, agora);
  const conferido = quando
    ? `Conferido ${quando}, com os anúncios ativos ${plataformasLidas(check.sources)}.`
    : `Os anúncios ${plataformasLidas(check.sources)} ainda não foram lidos.`;
  if (s.without_tracking > 0) {
    const sem = s.without_tracking;
    return {
      tipo: 'atencao',
      icone: 'alert',
      titulo: `${sem} ${sem === 1 ? 'anúncio ativo' : 'anúncios ativos'} sem os parâmetros do Liame — as vendas ${sem === 1 ? 'dele ficam' : 'deles ficam'} sem origem.`,
      texto: `${conferido} O Liame não mexe nos anúncios: cole os parâmetros em cada um.`,
      lista: n > 0,
      botao,
    };
  }
  if (s.not_verifiable > 0) {
    const nv = s.not_verifiable;
    const outros = !s.with_tracking
      ? ''
      : s.with_tracking === 1
        ? ' O outro anúncio ativo tem os parâmetros do Liame.'
        : ` Os outros ${s.with_tracking} têm os parâmetros do Liame.`;
    return {
      tipo: undefined,
      icone: 'info',
      titulo: `${nv} ${nv === 1 ? 'anúncio ativo ainda não foi conferido' : 'anúncios ativos ainda não foram conferidos'}.`,
      texto: `${conferido}${outros}`,
      lista: n > 0,
      botao,
    };
  }
  if (s.active_ads === 0) {
    return {
      tipo: undefined,
      icone: 'info',
      titulo: 'Nenhum anúncio ativo na última leitura',
      texto: `${conferido} Quando houver anúncio no ar, o Liame confere se ele leva os parâmetros.`,
      lista: false,
      botao: '',
    };
  }
  return {
    tipo: 'acao',
    icone: 'check',
    titulo: 'Todos os anúncios ativos têm os parâmetros do Liame',
    texto: `${conferido} Os pedidos que vierem deles chegam com a campanha.`,
    lista: false,
    botao: '',
  };
}

/** Sem o `https://`, para caber na linha da tabela (o endereço inteiro fica no título). */
export function enderecoCurto(url: string): string {
  return url.replace(/^https:\/\//, '');
}

/** "criado hoje", "criado ontem" ou "criado em 22/09". */
export function criadoEm(iso: string, agora: Date): string {
  const q = quandoComHora(iso, agora);
  if (q.startsWith('hoje')) return 'criado hoje';
  if (q.startsWith('ontem')) return 'criado ontem';
  return `criado em ${q.split(',')[0]}`;
}

export function textoAnuncio(link: Pick<TrackingLink, 'ad'>): string {
  return link.ad ? `Anúncio: ${link.ad.name}` : 'Todos os anúncios';
}

// ─────────────────────────── criar link ───────────────────────────

/** Campanha que leva link do cardápio: a de mensagens abre o WhatsApp e fica de fora. */
export function campanhaAceitaLink(c: LinkCampaignOption): boolean {
  return c.destination_kind !== 'mensagens' && c.destination_kind !== 'outro';
}

export function motivoCampanhaSemLink(c: LinkCampaignOption): string | null {
  if (c.destination_kind === 'mensagens') return 'mensagens: o anúncio abre o WhatsApp';
  if (c.destination_kind === 'outro') return 'o anúncio não leva a um site';
  return null;
}

/** As campanhas por plataforma, na ordem da API (Meta, depois Google). */
export function gruposDeCampanhas(campanhas: LinkCampaignOption[]): { provider: string; titulo: string; campanhas: LinkCampaignOption[] }[] {
  const grupos: { provider: string; titulo: string; campanhas: LinkCampaignOption[] }[] = [];
  for (const c of campanhas) {
    let g = grupos.find((x) => x.provider === c.provider);
    if (!g) {
      g = { provider: c.provider, titulo: rotuloPlataforma(c.provider), campanhas: [] };
      grupos.push(g);
    }
    g.campanhas.push(c);
  }
  return grupos;
}

/** Por que a loja não serve de destino (a API manda o motivo). */
export function motivoDestino(d: LinkDestination): string | null {
  if (d.usable) return null;
  if (d.reason === 'sem_loja') return 'ligue a loja do Regem a uma loja do Liame em Contas conectadas';
  if (d.reason === 'sem_cardapio') return 'o Regem não informou o cardápio online desta loja';
  return 'não serve de destino agora';
}

export function rotuloDestino(d: LinkDestination): string {
  return `Cardápio online · ${d.unit?.name ?? d.store_name}`;
}

export type ErrosDoLink = { nome?: string; campanha?: string; destino?: string };

/** Confere o formulário antes de enviar (o servidor confere de novo). */
export function errosDoLink(v: { nome: string; campanha: string; destino: string }): ErrosDoLink {
  const e: ErrosDoLink = {};
  const nome = v.nome.trim();
  if (!nome) e.nome = 'Dê um nome ao link, para achar depois.';
  else if (nome.length > 60) e.nome = 'Use até 60 caracteres.';
  if (!v.campanha) e.campanha = 'Escolha a campanha.';
  if (!v.destino) e.destino = 'Escolha o cardápio de destino.';
  return e;
}

/** O aviso depois de criar: o link novo ou o mesmo que já existia (a API devolve `created`). */
export function avisoDoLink(link: Pick<TrackingLink, 'code'>, criado: boolean): string {
  return criado
    ? 'Link criado. Copie os parâmetros e cole no anúncio.'
    : `Esse link já existia (código ${link.code}): os parâmetros e o QR são os mesmos.`;
}

/** Nome do arquivo do QR: o código do link, sem acento nem espaço. */
export function arquivoDoQr(link: Pick<TrackingLink, 'code' | 'name'>, extensao: 'png' | 'svg'): string {
  const nome = link.name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `qr-${nome || 'link'}-${link.code}.${extensao}`;
}
