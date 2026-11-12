import type { BrandPhoto, NewCampaignObjective, NewCampaignOptionsResponse, NewCampaignResponse, NewCampaignUnitOption } from '@liame/contracts';
import type { Problema } from '@/lib/api';
import { reaisDeMicros } from '@/lib/formato';
import { microsDeReais } from '@/components/links/cupons-textos';

// Os textos da campanha nova na Meta, criada pausada (A4, X5, parte 5; protótipo P42 aprovado em 11/11/2026, D-A4-42 a
// D-A4-46): a gaveta em Criativos, a situação na peça e o pedido em Aprovações. As recusas são as do servidor
// (`campanhas-novas.service.ts`): a tela confere o mesmo antes de mandar, e o servidor confere de novo.

export const OBJETIVOS: Record<NewCampaignObjective, { rotulo: string; icone: 'external' | 'message'; botao: string; rastreio: string }> = {
  cardapio: { rotulo: 'Pedidos pelo cardápio', icone: 'external', botao: 'Pedir agora', rastreio: 'Vai junto, nos parâmetros de URL do anúncio' },
  whatsapp: { rotulo: 'Conversas no WhatsApp', icone: 'message', botao: 'Enviar mensagem', rastreio: 'Pela conversa que o anúncio abre' },
};

/** Os raios da gaveta: 3, 5 e 8 km, e o raio de entrega da loja quando ela informou (D-A4-43). */
export function raiosDaLoja(loja: NewCampaignUnitOption | null): { km: number; rotulo: string; entrega: boolean }[] {
  const fixos = [3, 5, 8].map((km) => ({ km, rotulo: `${km} km`, entrega: false }));
  const r = loja?.delivery_radius_km;
  if (!r || r < 1 || r > 15 || !Number.isInteger(r * 2) || [3, 5, 8].includes(r)) return fixos;
  return [...fixos, { km: r, rotulo: `Raio de entrega (${kmEscrito(r)})`, entrega: true }];
}

export const kmEscrito = (km: number): string => `${km.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} km`;

export function dicaDoRaio(km: number, loja: NewCampaignUnitOption): string {
  if (!loja.has_address) return `O raio sai do ponto da ${loja.name}, que ainda não está no endereço: ajuste o endereço antes.`;
  const onde = loja.address ? `${loja.name} (${loja.address})` : loja.name;
  return `Pessoas de 18 anos ou mais, num raio de ${kmEscrito(km)} em volta da ${onde}. O público ampliado da Meta fica desligado: dentro do raio, a Meta escolhe para quem mostrar.`;
}

/** Para onde o anúncio leva, com as palavras do P42. */
export function destinoDoObjetivo(objetivo: NewCampaignObjective, loja: NewCampaignUnitOption | null, pagina: string | null): { leva: string; onde: string } {
  if (objetivo === 'whatsapp') return { leva: `A conversa no WhatsApp da Página ${pagina ?? ''}`.trim(), onde: 'o número do WhatsApp ligado à Página' };
  return { leva: `O cardápio online da ${loja?.name ?? 'loja'}`, onde: 'onde a pessoa faz o pedido' };
}

export function dicaDoObjetivo(objetivo: NewCampaignObjective, loja: NewCampaignUnitOption | null, pagina: string | null): string {
  if (objetivo === 'whatsapp') return `Abre uma conversa no WhatsApp da Página ${pagina ?? ''}. A Página precisa ter o número do WhatsApp ligado, e a Meta confere ao criar.`.replace('  ', ' ');
  return `Leva ao cardápio online da ${loja?.name ?? 'loja'}, onde a pessoa faz o pedido.`;
}

export const ehVideo = (m: BrandPhoto): boolean => m.kind === 'video';
export const temCapa = (m: BrandPhoto): boolean => !ehVideo(m) || Boolean(m.video?.has_cover);

export function duracaoCurta(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export type CamposDaCampanha = {
  midia: string | null;
  loja: string | null;
  nome: string;
  objetivo: NewCampaignObjective;
  raio: number;
  verba: string;
  fim: string;
};
export type CampoComErro = 'midia' | 'loja' | 'nome' | 'objetivo' | 'verba' | 'fim';
export type ErrosDaCampanha = Partial<Record<CampoComErro, string>>;

/**
 * Confere antes de mandar (o servidor confere de novo, com as mesmas regras): a mídia (o vídeo com capa), a loja no
 * endereço, o cardápio da loja, o nome, a verba (sem fração de centavo, dentro do teto) e o fim depois de hoje.
 */
export function conferirCampanha(c: CamposDaCampanha, opcoes: NewCampaignOptionsResponse, midias: BrandPhoto[], hoje: string): ErrosDaCampanha {
  const e: ErrosDaCampanha = {};
  const m = midias.find((x) => x.id === c.midia);
  if (!m) e.midia = 'Escolha uma foto ou um vídeo de Fotos.';
  else if (!temCapa(m)) e.midia = 'O anúncio de vídeo leva a capa: escolha a capa do vídeo em Fotos, ou use outro vídeo.';
  const loja = opcoes.units.find((u) => u.id === c.loja);
  if (!loja) e.loja = 'Escolha a loja.';
  else if (!loja.has_address) e.loja = 'A campanha mostra o anúncio em volta da loja, e o ponto dela ainda não está no endereço. Ajuste o endereço da loja em Minha marca antes.';
  else if (c.objetivo === 'cardapio' && !loja.menu_available) e.objetivo = loja.menu_block ?? 'A loja não tem o cardápio online ligado ao Liame.';
  if (!c.nome.trim()) e.nome = 'Dê um nome à campanha.';
  else if ([...c.nome.trim()].length > 80) e.nome = 'O nome vai até 80 caracteres.';
  const micros = microsDeReais(c.verba);
  if (micros === null || BigInt(micros) < 10_000n) e.verba = 'Digite a verba diária em reais, como 30,00.';
  else if (opcoes.campaign_cap_micros !== null && BigInt(micros) > BigInt(opcoes.campaign_cap_micros)) {
    e.verba = `A verba diária passa do teto por campanha, que é de ${reaisDeMicros(BigInt(opcoes.campaign_cap_micros))} por dia. Quem muda o teto é o Dono ou o Administrador, em Verba do mês.`;
  }
  if (c.fim && c.fim <= hoje) e.fim = 'A data de fim precisa ser depois de hoje.';
  return e;
}

/** A recusa do servidor no campo certo (o `code` do Problem Details); o resto vai no erro geral da gaveta. */
export function erroDoPedido(p: Problema): { campo: CampoComErro | null; texto: string } {
  const texto = p.detail ?? p.title ?? 'Não foi possível pedir a campanha agora.';
  const porCodigo: Record<string, CampoComErro> = {
    'midia-fora-das-fotos': 'midia',
    'video-sem-capa': 'midia',
    'loja-nao-encontrada': 'loja',
    'loja-sem-endereco': 'loja',
    'sem-cardapio': 'objetivo',
    'verba-invalida': 'verba',
    'acima-do-teto': 'verba',
    'fim-no-passado': 'fim',
  };
  return { campo: (p.code && porCodigo[p.code]) || null, texto };
}

/** O que a campanha vai fazer, em palavras (o efeito do P10): nasce pausada; ativada, quanto gasta por dia. */
export function efeitoDaCampanha(verba: string): string {
  const base = 'A campanha nasce pausada: não aparece para ninguém e não gasta. Ativar é outro pedido, com outra aprovação.';
  const micros = microsDeReais(verba);
  if (micros === null || BigInt(micros) <= 0n) return `${base} Digite a verba diária para ver quanto ela gasta depois de ativada.`;
  return `${base} Ativada, ela gasta até ${reaisDeMicros(BigInt(micros))} por dia.`;
}

// ---------------------------------------------------------------- a situação da campanha (a peça e Aprovações)

/** O tom da etiqueta (as classes `st--*` que a tela já tem). */
export type Tom = 'aguardando' | 'trabalhando' | 'concluido' | 'pausado' | 'perigo' | 'neutro';

export function situacaoDaCampanha(c: Pick<NewCampaignResponse, 'status' | 'active'>): { rotulo: string; tom: Tom } {
  if (c.status === 'criada') return c.active ? { rotulo: 'Ativa na Meta', tom: 'concluido' } : { rotulo: 'Criada e pausada', tom: 'neutro' };
  if (c.status === 'criando') return { rotulo: 'Criando na Meta', tom: 'trabalhando' };
  if (c.status === 'nao_criada') return { rotulo: 'Não criada', tom: 'perigo' };
  if (c.status === 'cancelada') return { rotulo: 'Cancelada', tom: 'neutro' };
  return { rotulo: 'Espera a aprovação', tom: 'aguardando' };
}

export type Passo = { rotulo: string; estado: 'feito' | 'agora' | 'pendente'; detalhe: string };

/**
 * A criação passo a passo (D-A4-44): a campanha, o conjunto, o vídeo (só no vídeo), o criativo e o anúncio, na ordem em
 * que o Liame cria. O primeiro que falta é o de agora enquanto a campanha está `criando`.
 */
export function passosDaCriacao(c: NewCampaignResponse, video: boolean): Passo[] {
  // O rótulo, o id na Meta e o que diz quando já existe (a concordância de cada um).
  const lista: [string, string | null, string][] = [
    ['A campanha', c.meta.campaign_id, 'criada na Meta, pausada'],
    ['O conjunto', c.meta.adset_id, 'criado na Meta, pausado'],
    ...(video ? ([['O vídeo', c.meta.video_id, 'enviado à Meta']] as [string, string | null, string][]) : []),
    ['O criativo', c.meta.creative_id, 'criado na Meta'],
    ['O anúncio', c.meta.ad_id, 'criado na Meta, pausado'],
  ];
  let agoraMarcado = false;
  return lista.map(([rotulo, id, feito]) => {
    if (id) return { rotulo, estado: 'feito', detalhe: feito };
    if (c.status === 'criando' && !agoraMarcado) {
      agoraMarcado = true;
      return { rotulo, estado: 'agora', detalhe: rotulo === 'O vídeo' ? 'a Meta prepara o vídeo (até 15 minutos)' : 'o Liame cria agora' };
    }
    return { rotulo, estado: 'pendente', detalhe: c.status === 'nao_criada' ? 'não foi criado' : 'pendente' };
  });
}

/** O id da campanha nova a partir do recurso do pedido em Aprovações (`campanha_nova:<id>`). */
export function idDaCampanhaNova(resourceId: string | null | undefined): string | null {
  const m = /^campanha_nova:([0-9a-f-]{36})$/.exec(resourceId ?? '');
  return m ? m[1]! : null;
}

export const FERRAMENTAS_DA_CAMPANHA_NOVA = ['campanha_criar', 'campanha_nova_ativar', 'campanha_nova_pausar'] as const;

/**
 * O link da campanha no Gerenciador de Anúncios da Meta: a conta (`act`, sem o prefixo `act_`) e a campanha. Sem a
 * conta, a Meta abre na última conta usada por quem clica.
 */
export function linkDoGerenciador(campanha: string, conta: string | null): string {
  const act = conta ? `act=${encodeURIComponent(conta.replace(/^act_/, ''))}&` : '';
  return `https://adsmanager.facebook.com/adsmanager/manage/campaigns?${act}selected_campaign_ids=${encodeURIComponent(campanha)}`;
}
