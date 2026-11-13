import {
  type BrandPhoto,
  NEW_CAMPAIGN_DISTRICTS_MAX,
  type NewCampaignAudienceResponse,
  type NewCampaignDistrict,
  type NewCampaignObjective,
  type NewCampaignOptionsResponse,
  type NewCampaignResponse,
  type NewCampaignUnitOption,
} from '@liame/contracts';
import type { Problema } from '@/lib/api';
import { reaisDeMicros } from '@/lib/formato';
import { microsDeReais } from '@/components/links/cupons-textos';

// Os textos da campanha nova na Meta, criada pausada (A4, X5, parte 5; protótipo P42 aprovado em 11/11/2026, D-A4-42 a
// D-A4-46): a gaveta em Criativos, a situação na peça e o pedido em Aprovações. As recusas são as do servidor
// (`campanhas-novas.service.ts`): a tela confere o mesmo antes de mandar, e o servidor confere de novo.

export const OBJETIVOS: Record<NewCampaignObjective, { rotulo: string; icone: 'external' | 'message' | 'megaphone' | 'user-plus'; botao: string; rastreio: string }> = {
  cardapio: { rotulo: 'Pedidos pelo cardápio', icone: 'external', botao: 'Pedir agora', rastreio: 'Vai junto, nos parâmetros de URL do anúncio' },
  whatsapp: { rotulo: 'Conversas no WhatsApp', icone: 'message', botao: 'Enviar mensagem', rastreio: 'Pela conversa que o anúncio abre' },
  // R6 do plano da região (D-RG-48): os objetivos do topo do funil.
  alcance: { rotulo: 'Ser conhecido no raio', icone: 'megaphone', botao: 'Pedir agora', rastreio: 'Pelo alcance e pela frequência, em Resultados' },
  seguidores: { rotulo: 'Seguidores no Instagram', icone: 'user-plus', botao: 'Ver perfil', rastreio: 'Pelos seguidores, em Minha marca › Região' },
};

/** Os objetivos do topo do funil, que dividem até 25% do teto do mês (D-RG-49). */
export const DO_TOPO: readonly NewCampaignObjective[] = ['alcance', 'seguidores'];
/** A frequência do alcance (D-RG-51), como o servidor manda à Meta. */
export const FREQUENCIA_DO_ALCANCE = 'No máximo 2 vezes por pessoa a cada 7 dias';

/**
 * A linha do teto de alcance e seguidores (R6, D-RG-49) com a verba diária da gaveta: quanto cabe no mês e quanto esta
 * usaria até o fim dele. `passa` quando a soma passa do teto (o servidor recusa com as mesmas contas).
 */
export function linhaDoTopo(t: NonNullable<NewCampaignOptionsResponse['top_of_funnel']>, verbaDiariaMicros: number | string | null): { texto: string; passa: boolean } {
  const esta = (verbaDiariaMicros === null ? 0 : Number(verbaDiariaMicros)) * t.days_left;
  const passa = t.used_micros + esta > t.cap_micros;
  const base = `Alcance e seguidores: até 25% do teto do mês (${reaisDeMicros(String(t.cap_micros))}). Já há ${reaisDeMicros(String(t.used_micros))} reservados em campanhas assim`;
  if (!passa) return { texto: `${base}; esta usa até ${reaisDeMicros(String(esta))} até o fim do mês.`, passa };
  const maximo = t.days_left > 0 ? Math.max(0, Math.floor((t.cap_micros - t.used_micros) / t.days_left / 10_000) * 10_000) : 0;
  return { texto: `${base}. Esta passa do teto: ${maximo > 0 ? `diminua a verba diária para até ${reaisDeMicros(String(maximo))}` : 'deixe para o mês que vem'}.`, passa };
}

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

/** Pessoas escritas de forma curta, como no protótipo: "760", "1.500", "182 mil", "1,2 milhão". */
export function pessoasEscritas(n: number): string {
  if (n < 10_000) return n.toLocaleString('pt-BR');
  const mil = Math.round(n / 1000);
  if (mil < 1000) return `${mil.toLocaleString('pt-BR')} mil`;
  const milhoes = Math.round(n / 100_000) / 10;
  return `${milhoes.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} ${milhoes < 2 ? 'milhão' : 'milhões'}`;
}

/**
 * A linha da estimativa de público no raio, debaixo de "Quem vê" (R6, D-RG-50). `pequeno` impede o pedido, com a mesma
 * frase da recusa do servidor (`publico-pequeno`); sem a estimativa agora, o pedido pode seguir sem ela.
 */
export function linhaDaEstimativa(
  e: NewCampaignAudienceResponse | 'falhou',
  km: number,
  loja: string,
  /** Nos bairros (R6, parte 3): quantos estão marcados; a frase fala deles, e não do raio. */
  bairros: number | null = null,
): { tom: 'ok' | 'pequeno' | 'sem'; titulo: string | null; destaque: string | null; texto: string } {
  if (bairros !== null && e !== 'falhou' && e.status === 'pronta' && e.lower !== null && e.upper !== null) {
    const onde = bairros === 1 ? 'no bairro escolhido' : `nos ${bairros} bairros escolhidos`;
    if (e.enough === false) {
      return {
        tom: 'pequeno',
        titulo: 'Público pequeno demais nos bairros',
        destaque: null,
        texto: `A Meta estima de ${e.lower.toLocaleString('pt-BR')} a ${e.upper.toLocaleString('pt-BR')} pessoas de 18 anos ou mais ${onde}: com menos de ${e.minimum.toLocaleString('pt-BR')} pessoas, ela não entrega bem. Escolha mais bairros.`,
      };
    }
    return {
      tom: 'ok',
      titulo: null,
      destaque: `Cerca de ${pessoasEscritas(e.lower)} a ${pessoasEscritas(e.upper)} pessoas`,
      texto: ` de 18 anos ou mais ${onde}, pela estimativa da Meta (lida agora, todos os lugares juntos). Com menos de ${e.minimum.toLocaleString('pt-BR')} pessoas, o pedido não sai.`,
    };
  }
  if (e !== 'falhou' && e.status === 'pronta' && e.lower !== null && e.upper !== null) {
    if (e.enough === false) {
      return {
        tom: 'pequeno',
        titulo: 'Público pequeno demais no raio',
        destaque: null,
        texto: `A Meta estima de ${e.lower.toLocaleString('pt-BR')} a ${e.upper.toLocaleString('pt-BR')} pessoas de 18 anos ou mais num raio de ${kmEscrito(km)} em volta da ${loja}: com menos de ${e.minimum.toLocaleString('pt-BR')} pessoas, ela não entrega bem. Aumente o raio.`,
      };
    }
    return {
      tom: 'ok',
      titulo: null,
      destaque: `Cerca de ${pessoasEscritas(e.lower)} a ${pessoasEscritas(e.upper)} pessoas`,
      texto: ` de 18 anos ou mais no raio de ${kmEscrito(km)}, pela estimativa da Meta (lida agora). O Liame não usa mais o mínimo de 100 mil pessoas: num raio de loja, quem decide é a estimativa.`,
    };
  }
  if (e !== 'falhou' && e.status === 'sem_estimativa') {
    return { tom: 'sem', titulo: null, destaque: null, texto: 'A Meta não deu a estimativa deste raio agora: o pedido pode seguir sem ela.' };
  }
  return { tom: 'sem', titulo: null, destaque: null, texto: 'Não deu para ler a estimativa da Meta agora: o pedido pode seguir sem ela.' };
}

/** O bairro pode ser marcado: o centro foi achado (vai como o bairro da Meta ou como um círculo). */
export const bairroEscolhivel = (b: Pick<NewCampaignDistrict, 'how'>): boolean => b.how === 'meta' || b.how === 'circulo';

/** Como o bairro vai para a Meta (D-RG-54), com as palavras da revisão R6-3 da P42. */
export function comoVaiNaMeta(b: Pick<NewCampaignDistrict, 'how' | 'radius_km'>): string {
  if (b.how === 'meta') return 'na Meta, o bairro dela';
  if (b.how === 'circulo' && b.radius_km !== null) return `na Meta, um círculo de ${kmEscrito(b.radius_km)} no centro`;
  if (b.how === 'procurando') return 'procurando o centro do bairro no mapa…';
  return 'o mapa não achou o centro deste bairro: não dá para escolher';
}

/** De onde o bairro veio: a área de entrega e os pedidos (Sua região); sem nenhum dos dois, da busca. */
export function deOndeVemOBairro(b: Pick<NewCampaignDistrict, 'delivery_area' | 'orders' | 'orders_days'>): string {
  const partes = [b.delivery_area ? 'área de entrega' : null, b.orders ? `${b.orders.toLocaleString('pt-BR')} pedidos em ${b.orders_days ?? 30} dias` : null];
  return partes.filter(Boolean).join(' · ') || 'da busca';
}

/** A frase de quem vê nos bairros (D-RG-54), debaixo da lista. */
export function dicaDosBairros(marcados: number): string {
  return `${marcados} de até ${NEW_CAMPAIGN_DISTRICTS_MAX} bairros. Pessoas de 18 anos ou mais que estão nos bairros marcados. Onde a Meta tem o bairro (a busca de lugares dela acha o nome na mesma cidade), o anúncio vai para o bairro dela; onde não tem, o Liame usa um círculo no centro do bairro, do tamanho dele pelo IBGE (de 1 a 3 km), que pode pegar um pedaço do vizinho. O público ampliado da Meta fica desligado.`;
}

/** Quem vê nos bairros, em Aprovações: cada bairro com o jeito de ir para a Meta. */
export function bairrosEmAprovacoes(bairros: NonNullable<NewCampaignResponse['districts']>): string {
  return bairros.map((b) => `${b.name} (${b.meta ? 'o bairro da Meta' : `círculo de ${kmEscrito(b.radius_km)}`})`).join(', ');
}

/** "1 bairro", "3 bairros". */
export const bairrosEscritos = (n: number): string => `${n} ${n === 1 ? 'bairro' : 'bairros'}`;

/** Para onde o anúncio leva, com as palavras do P42. */
export function destinoDoObjetivo(objetivo: NewCampaignObjective, loja: NewCampaignUnitOption | null, pagina: string | null): { leva: string; onde: string } {
  if (objetivo === 'whatsapp') return { leva: `A conversa no WhatsApp da Página ${pagina ?? ''}`.trim(), onde: 'o número do WhatsApp ligado à Página' };
  if (objetivo === 'seguidores') return { leva: 'O perfil da marca no Instagram', onde: 'o perfil ligado à Página, para a pessoa seguir' };
  return { leva: `O cardápio online da ${loja?.name ?? 'loja'}`, onde: 'onde a pessoa faz o pedido' };
}

export function dicaDoObjetivo(objetivo: NewCampaignObjective, loja: NewCampaignUnitOption | null, pagina: string | null): string {
  if (objetivo === 'whatsapp') return `Abre uma conversa no WhatsApp da Página ${pagina ?? ''}. A Página precisa ter o número do WhatsApp ligado, e a Meta confere ao criar.`.replace('  ', ' ');
  if (objetivo === 'alcance') return `Mostra o anúncio para o máximo de pessoas do raio, no máximo 2 vezes por pessoa a cada 7 dias; o botão leva ao cardápio online da ${loja?.name ?? 'loja'}. Conta no teto de 25% da verba do mês para alcance e seguidores.`;
  if (objetivo === 'seguidores') return 'Leva ao perfil da marca no Instagram, para a pessoa seguir; a Meta mostra para quem costuma visitar perfis. Conta no teto de 25% da verba do mês. O Liame confere com a Meta antes de criar.';
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
  /** Quem vê (R6, parte 3; D-RG-53): o raio em volta da loja ou os bairros marcados (os códigos do IBGE). */
  quem: 'raio' | 'bairros';
  bairros: string[];
  verba: string;
  fim: string;
};
export type CampoComErro = 'midia' | 'loja' | 'nome' | 'objetivo' | 'bairros' | 'verba' | 'fim';
export type ErrosDaCampanha = Partial<Record<CampoComErro, string>>;

/**
 * Confere antes de mandar (o servidor confere de novo, com as mesmas regras): a mídia (o vídeo com capa), a loja no
 * endereço, o cardápio da loja, o nome, a verba (sem fração de centavo, dentro do teto) e o fim depois de hoje.
 */
export function conferirCampanha(c: CamposDaCampanha, opcoes: NewCampaignOptionsResponse, midias: BrandPhoto[], hoje: string, doReels = false): ErrosDaCampanha {
  const e: ErrosDaCampanha = {};
  // No Reels, a mídia é o próprio post (D-A4-46): não há foto nem vídeo de Fotos a escolher.
  if (!doReels) {
    const m = midias.find((x) => x.id === c.midia);
    if (!m) e.midia = 'Escolha uma foto ou um vídeo de Fotos.';
    else if (!temCapa(m)) e.midia = 'O anúncio de vídeo leva a capa: escolha a capa do vídeo em Fotos, ou use outro vídeo.';
  }
  const loja = opcoes.units.find((u) => u.id === c.loja);
  if (!loja) e.loja = 'Escolha a loja.';
  else if (!loja.has_address) e.loja = 'A campanha mostra o anúncio em volta da loja, e o ponto dela ainda não está no endereço. Ajuste o endereço da loja em Minha marca antes.';
  else if ((c.objetivo === 'cardapio' || c.objetivo === 'alcance') && !loja.menu_available) e.objetivo = loja.menu_block ?? 'A loja não tem o cardápio online ligado ao Liame.';
  if (c.objetivo === 'seguidores' && !opcoes.instagram) {
    e.objetivo = 'Seguidores no Instagram leva ao perfil do Instagram ligado à Página da marca. Ligue o Instagram à Página na Meta e conecte de novo em Contas conectadas.';
  }
  if (c.quem === 'bairros') {
    if (c.bairros.length === 0) e.bairros = 'Marque pelo menos um bairro, ou volte para o raio em volta da loja.';
    else if (c.bairros.length > NEW_CAMPAIGN_DISTRICTS_MAX) e.bairros = `Até ${NEW_CAMPAIGN_DISTRICTS_MAX} bairros por campanha.`;
  }
  if (!c.nome.trim()) e.nome = 'Dê um nome à campanha.';
  else if ([...c.nome.trim()].length > 80) e.nome = 'O nome vai até 80 caracteres.';
  const micros = microsDeReais(c.verba);
  if (micros === null || BigInt(micros) < 10_000n) e.verba = 'Digite a verba diária em reais, como 30,00.';
  else if (opcoes.campaign_cap_micros !== null && BigInt(micros) > BigInt(opcoes.campaign_cap_micros)) {
    e.verba = `A verba diária passa do teto por campanha, que é de ${reaisDeMicros(BigInt(opcoes.campaign_cap_micros))} por dia. Quem muda o teto é o Dono ou o Administrador, em Verba do mês.`;
  } else if (DO_TOPO.includes(c.objetivo) && opcoes.top_of_funnel) {
    const topo = linhaDoTopo(opcoes.top_of_funnel, micros);
    if (topo.passa) e.verba = topo.texto;
  }
  if (c.fim && c.fim <= hoje) e.fim = 'A data de fim precisa ser depois de hoje.';
  return e;
}

/** A recusa do servidor no campo certo (o `code` do Problem Details); o resto vai no erro geral da gaveta. */
export function erroDoPedido(p: Problema): { campo: CampoComErro | null; texto: string } {
  const texto = p.detail ?? p.title ?? 'Não foi possível pedir a campanha agora.';
  const porCodigo: Record<string, CampoComErro> = {
    'midia-fora-das-fotos': 'midia',
    'acima-do-teto-do-topo': 'verba',
    'sem-instagram-na-pagina': 'objetivo',
    'video-sem-capa': 'midia',
    'loja-nao-encontrada': 'loja',
    'loja-sem-endereco': 'loja',
    'sem-cardapio': 'objetivo',
    'verba-invalida': 'verba',
    'acima-do-teto': 'verba',
    'fim-no-passado': 'fim',
    'bairro-sem-centro': 'bairros',
    'bairro-fora-da-cidade': 'bairros',
  };
  return { campo: (p.code && porCodigo[p.code]) || null, texto };
}

// ---------------------------------------------------------------- a campanha a partir de um Reels (A4, X5, parte 6)

/** O dia em que o Reels foi publicado, no fuso da loja: "18/09". */
export const diaDoReels = (publicadoEm: string): string =>
  new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' }).format(new Date(publicadoEm));

/** O nome que a gaveta sugere: "Reels de 18/09 · novembro" (o mês de hoje, como na peça). */
export function nomeDaCampanhaDoReels(publicadoEm: string, hoje: string): string {
  const mes = new Intl.DateTimeFormat('pt-BR', { month: 'long', timeZone: 'UTC' }).format(new Date(`${hoje}T12:00:00Z`));
  return `Reels de ${diaDoReels(publicadoEm)} · ${mes}`.slice(0, 80);
}

/** A legenda fala do link da bio: no anúncio, o botão já leva ao destino (a nota da prévia, P42). */
export const falaDoLinkDaBio = (legenda: string): boolean => /link\s+(na|da)\s+bio/i.test(legenda);

export function notaDoLinkDaBio(objetivo: NewCampaignObjective): string {
  return `A legenda fala do link da bio, porque é a do post. No anúncio, o botão “${OBJETIVOS[objetivo].botao}” já leva ${objetivo === 'whatsapp' ? 'à conversa' : 'ao cardápio'}.`;
}

/** A Meta pergunta antes (D-A4-46): a nota da gaveta. */
export const NOTA_DA_ELEGIBILIDADE = 'Antes, o Liame pergunta à Meta se este Reels pode virar anúncio: o Reels com música do Instagram ou com filtro interativo não pode.';

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
