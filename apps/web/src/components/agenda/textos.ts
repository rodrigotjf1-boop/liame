import { PACKAGE_CHANNELS, POST_TEXT_LIMITS, type PostChannelResponse, type PostListResponse, type PostResponse } from '@liame/contracts';
import type { NomeIcone } from '@/components/ui/icone';

// A Agenda (mockups/prototipo-post.html, P19 aprovado em 21/10/2026; Z5c da A6): os posts da marca na semana, dia a
// dia, no fuso da empresa (que vem do servidor: a janela das 8h às 22h é nele). Funções puras: a semana, o dia e a hora
// de cada post, a situação dele e a de cada canal. O que o P19 mostra e o servidor ainda não faz (a pauta e a data
// comercial do dia, mudar a hora, apagar das redes, tentar de novo, o link do post) fica fora, como divergência
// (`decisoes-design.md`, 29/10/2026). O pacote pronto (mockups/prototipo-pacote.html, P22 aprovado em 21/10/2026; Z8
// da A6): no TikTok e no YouTube o Liame não publica; ele monta o texto, a foto e a hora, e quem publica é a pessoa.

export const DIAS_CURTOS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'] as const;
export const DIAS_LONGOS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'] as const;

/** Os canais em que o Liame publica, depois de aprovado, na ordem do post. */
export const CANAIS_DO_LIAME = ['instagram', 'facebook'] as const;
/** Os canais do pacote pronto (P22): o Liame monta, a pessoa publica. */
export const CANAIS_DO_PACOTE: readonly string[] = PACKAGE_CHANNELS;
/** O canal é do pacote (a pessoa publica), e não do Liame. */
export const ehDoPacote = (canal: string): boolean => CANAIS_DO_PACOTE.includes(canal);

/** O nome de cada canal nas frases e nas abas. */
export const NOME_DO_CANAL: Record<string, string> = { instagram: 'Instagram', facebook: 'Página do Facebook', tiktok: 'TikTok', youtube: 'YouTube' };
/** O nome curto, no cartão do dia. */
const NOME_CURTO: Record<string, string> = { instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok', youtube: 'YouTube' };
/** "no Instagram", "na Página do Facebook" (V121: a preposição vai com o nome). */
export const NO_CANAL: Record<string, string> = { instagram: 'no Instagram', facebook: 'na Página do Facebook', tiktok: 'no TikTok', youtube: 'no YouTube' };
/** "do TikTok", "do YouTube": o pacote de cada rede, na frase. */
const DO_CANAL: Record<string, string> = { tiktok: 'do TikTok', youtube: 'do YouTube' };

/** Os nomes na frase, com "e" antes do último: "do TikTok e do YouTube". */
const emFrase = (partes: string[]): string => (partes.length > 1 ? `${partes.slice(0, -1).join(', ')} e ${partes[partes.length - 1]}` : (partes[0] ?? ''));

const ehDiaIso = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);

/** `AAAA-MM-DD` mais `n` dias (pelo calendário, sem fuso). */
export function somaDias(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** O dia da semana de `AAAA-MM-DD` (0 = domingo). */
export const diaDaSemana = (iso: string): number => new Date(`${iso}T12:00:00Z`).getUTCDay();

/** A segunda-feira da semana do dia (a semana da Agenda vai de segunda a domingo, como o P19). */
export function inicioDaSemana(iso: string): string {
  return somaDias(iso, -((diaDaSemana(iso) + 6) % 7));
}

/** O dia e a hora (`HH:MM`) de um instante, no fuso da empresa. */
export function noFuso(instante: Date, fuso: string): { dia: string; hora: string } {
  const partes = new Intl.DateTimeFormat('en-CA', { timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(instante);
  const p = (t: string) => partes.find((x) => x.type === t)?.value ?? '';
  return { dia: `${p('year')}-${p('month')}-${p('day')}`, hora: `${p('hour')}:${p('minute')}` };
}

/** `30/10` de `AAAA-MM-DD`. */
export const ddmm = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/** "hoje, às 19:00", "amanhã, às 08:30", "sexta, 30/10, às 19:00". */
export function quando(dia: string, hora: string, hoje: string): string {
  const qual = dia === hoje ? 'hoje' : dia === somaDias(hoje, 1) ? 'amanhã' : dia === somaDias(hoje, -1) ? 'ontem' : `${DIAS_LONGOS[diaDaSemana(dia)]}, ${ddmm(dia)}`;
  return `${qual}, às ${hora}`;
}

/** A situação do post como a Agenda a mostra: o rótulo, o ícone e o tom. */
export type SituacaoNaTela = { rotulo: string; icone: NomeIcone; tom: 'ok' | 'espera' | 'falha' | '' };
const SITUACAO: Record<string, SituacaoNaTela> = {
  esperando_aprovacao: { rotulo: 'Espera aprovação', icone: 'alert', tom: 'espera' },
  agendado: { rotulo: 'Agendado', icone: 'clock', tom: '' },
  publicando: { rotulo: 'Publicando', icone: 'clock', tom: '' },
  publicado: { rotulo: 'Publicado', icone: 'check-circle', tom: 'ok' },
  em_parte: { rotulo: 'Saiu em parte', icone: 'alert-circle', tom: 'falha' },
  nao_saiu: { rotulo: 'Não saiu', icone: 'alert-circle', tom: 'falha' },
  cancelado: { rotulo: 'Cancelado', icone: 'x', tom: '' },
  recusado: { rotulo: 'Recusado', icone: 'x', tom: '' },
  expirado: { rotulo: 'Expirou sem aprovação', icone: 'x', tom: '' },
  // O pacote pronto (P22): a pessoa publica e marca "Publiquei".
  pacote_pronto: { rotulo: 'Você publica', icone: 'send', tom: '' },
  pacote_publicado: { rotulo: 'Você publicou', icone: 'check-circle', tom: 'ok' },
};
/** A situação que o servidor manda; a desconhecida (a lista pode crescer) fica neutra, com o próprio nome. */
export function situacaoDoPost(status: string): SituacaoNaTela {
  return SITUACAO[status] ?? { rotulo: status.replace(/_/g, ' '), icone: 'info', tom: '' };
}

/** O que sai da semana: o cancelado, o recusado e o que expirou sem aprovação não vão ao ar (o P19 também os tira). */
const FORA_DA_SEMANA = new Set(['cancelado', 'recusado', 'expirado']);

export type PostNoDia = { post: PostResponse; dia: string; hora: string; canais: string; situacao: SituacaoNaTela; rotulo: string };
export type DiaDaAgenda = { iso: string; curto: string; longo: string; num: string; hoje: boolean; passado: boolean; posts: PostNoDia[] };

export type TelaDaAgenda =
  | { tipo: 'desligada' }
  /**
   * A semana. `faltam`: os canais do Liame sem conta conectada; `semConta`: nenhum deles tem conta (o Liame não publica
   * nada, e o pacote pronto, que não precisa de conta, segue; D-A6-44).
   */
  | { tipo: 'semana'; dias: DiaDaAgenda[]; faltam: string[]; semConta: boolean };

/** O post é um pacote pronto (P22): quem publica é a pessoa. */
export const ehPacote = (p: Pick<PostResponse, 'kind'>): boolean => p.kind === 'pacote';

/** Os nomes dos canais do post, no cartão: "Instagram · Facebook". */
const canaisDoPost = (p: PostResponse) => p.channels.map((c) => NOME_CURTO[c.channel] ?? c.channel).join(' · ');

/** A semana da Agenda: os sete dias de `inicio` (segunda), cada um com os posts dele, na hora do fuso da empresa. */
export function telaDaAgenda(dados: PostListResponse, inicio: string, hoje: string): TelaDaAgenda {
  if (!dados.enabled) return { tipo: 'desligada' };
  const porDia = new Map<string, PostNoDia[]>();
  for (const post of dados.items) {
    if (FORA_DA_SEMANA.has(post.status)) continue;
    const { dia, hora } = noFuso(new Date(post.publish_at), dados.timezone);
    const situacao = situacaoDoPost(post.status);
    const canais = canaisDoPost(post);
    const nomes = post.channels.map((c) => NOME_DO_CANAL[c.channel] ?? c.channel).join(' e ');
    const item: PostNoDia = { post, dia, hora, canais, situacao, rotulo: `${ehPacote(post) ? 'Pacote' : 'Post'} de ${quando(dia, hora, hoje)}, ${nomes}: ${situacao.rotulo.toLowerCase()}` };
    porDia.set(dia, [...(porDia.get(dia) ?? []), item]);
  }
  const dias: DiaDaAgenda[] = Array.from({ length: 7 }, (_, i) => {
    const iso = somaDias(inicio, i);
    const posts = (porDia.get(iso) ?? []).sort((a, b) => a.hora.localeCompare(b.hora) || a.post.id.localeCompare(b.post.id));
    return { iso, curto: DIAS_CURTOS[diaDaSemana(iso)]!, longo: DIAS_LONGOS[diaDaSemana(iso)]!, num: iso.slice(8, 10), hoje: iso === hoje, passado: iso < hoje, posts };
  });
  const semConta = dados.channels.filter((c) => c.accounts.length === 0).map((c) => c.channel);
  return { tipo: 'semana', dias, faltam: semConta.map((c) => NOME_DO_CANAL[c] ?? c), semConta: dados.channels.length > 0 && semConta.length === dados.channels.length };
}

/** "26/10 a 01/11". */
export const periodo = (inicio: string): string => `${ddmm(inicio)} a ${ddmm(somaDias(inicio, 6))}`;

/** A linha de um canal na gaveta do post ("Em cada canal"). */
export type LinhaDoCanal = { canal: string; nome: string; icone: NomeIcone; tom: 'ok' | 'espera' | 'falha' | ''; frase: string; endereco: string | null; rotuloDoEndereco: string };

/** O que aconteceu em cada canal do post, como o servidor guarda, em palavras (a hora no fuso da empresa). */
export function linhaDoCanal(c: PostChannelResponse, post: PostResponse, fuso: string, hoje: string): LinhaDoCanal {
  const nome = NOME_DO_CANAL[c.channel] ?? c.channel;
  const base = { canal: c.channel, nome, endereco: null as string | null, rotuloDoEndereco: c.channel === 'instagram' ? 'Ver no Instagram' : 'Ver na Página' };
  if (c.status === 'publicado') {
    const em = c.published_at ? noFuso(new Date(c.published_at), fuso) : null;
    const frase = em ? `publicado ${em.dia === hoje ? 'hoje' : `em ${ddmm(em.dia)}`}, às ${em.hora}.` : 'publicado.';
    return { ...base, icone: 'check-circle', tom: 'ok', frase, endereco: enderecoSeguro(c.permalink) };
  }
  if (c.status === 'falhou') return { ...base, icone: 'alert-circle', tom: 'falha', frase: `não saiu. ${c.error ?? ''}`.trim() };
  if (c.status === 'cancelado') return { ...base, icone: 'x', tom: '', frase: 'cancelado: não saiu.' };
  if (c.status === 'apagado') return { ...base, icone: 'undo', tom: '', frase: 'apagado.' };
  // Esperando ou publicando: o pedido que espera a aprovação não tem hora certa para sair.
  const marcado = noFuso(new Date(post.publish_at), fuso);
  if (post.status === 'esperando_aprovacao') return { ...base, icone: 'clock', tom: 'espera', frase: `sai ${quando(marcado.dia, marcado.hora, hoje)}, depois de aprovado.` };
  if (c.status === 'publicando' || post.status === 'publicando') return { ...base, icone: 'clock', tom: 'espera', frase: 'publicando agora.' };
  // O pedido terminou com o canal ainda esperando (uma trava barrou a execução, por exemplo): ele não saiu.
  if (['cancelado', 'recusado', 'expirado', 'em_parte', 'nao_saiu'].includes(post.status)) return { ...base, icone: 'x', tom: '', frase: 'não saiu.' };
  return { ...base, icone: 'clock', tom: 'espera', frase: `sai ${quando(marcado.dia, marcado.hora, hoje)}.` };
}

/**
 * Dá para "Tentar de novo" neste canal agora (A6, Z5d; P19; D-A6-54)? O servidor diz até quando (`retry_until`: o post
 * saiu no outro canal, o motivo pode passar, e faz menos de 24 horas); a tela só confere que o prazo não passou.
 */
export function podeTentarDeNovo(c: Pick<PostChannelResponse, 'retry_until'>, agora: Date): boolean {
  return c.retry_until !== null && new Date(c.retry_until).getTime() > agora.getTime();
}

/** O endereço do post na rede, só `https` (o servidor já confere o domínio; a tela não abre outra coisa). */
export function enderecoSeguro(v: string | null): string | null {
  if (!v) return null;
  try {
    return new URL(v).protocol === 'https:' ? v : null;
  } catch {
    return null;
  }
}

/** A frase do topo da gaveta: a situação, com o que ela quer dizer. */
export function fraseDaSituacao(post: PostResponse, fuso: string, hoje: string): string {
  const s = situacaoDoPost(post.status);
  const { dia, hora } = noFuso(new Date(post.publish_at), fuso);
  if (post.status === 'esperando_aprovacao') return `${s.rotulo}: o post só sai depois de aprovado, com o código do app.`;
  if (post.status === 'agendado') return `${s.rotulo}: aprovado, sai ${quando(dia, hora, hoje)}.`;
  if (post.status === 'em_parte') return `${s.rotulo}: veja abaixo onde saiu e onde não saiu.`;
  if (post.status === 'expirado') return `${s.rotulo}: ninguém aprovou no prazo, e o post não saiu.`;
  return s.rotulo;
}

/**
 * O formato da foto na prévia (como o P19): no Instagram, o recorte que ele pede (4:5 na foto alta demais, 1,91:1 na
 * larga demais); a que cabe, e a da Página, inteira.
 */
export function formatoDaPrevia(canal: string, largura: number, altura: number): 'alta' | 'larga' | 'inteira' {
  if (canal !== 'instagram' || !(largura > 0) || !(altura > 0)) return 'inteira';
  const r = largura / altura;
  if (r < 4 / 5 - 0.001) return 'alta';
  if (r > 1.91 + 0.001) return 'larga';
  return 'inteira';
}

/** Onde o quadro do recorte fica (`object-position`): na foto alta, de cima para baixo; na larga, da esquerda para a direita. */
export function posicaoDoRecorte(formato: 'alta' | 'larga' | 'inteira', pos: number | null): string {
  const p = Math.min(100, Math.max(0, pos ?? 50));
  return formato === 'larga' ? `${p}% 50%` : `50% ${p}%`;
}

/** `AAAA-MM-DD` válido (o que vem do endereço ou do seletor de semana). */
export const ehDia = ehDiaIso;

// ---- o novo post (P19; Z5c, parte 3) ------------------------------------------------------------------------------

/** O limite do texto de cada canal, o mesmo do servidor: a legenda do Instagram até 2.200; a Página, até 10.000. */
export const LIMITE_DO_TEXTO: Record<string, number> = { ...POST_TEXT_LIMITS };
/** Com quanta antecedência mínima o post pode ser marcado (a tela; o servidor aceita até agora). */
export const ANTECEDENCIA_MINIMA_MIN = 15;
/** Até quantos dias o post pode ser marcado (D-A6-34). */
export const DIAS_DE_ANTECEDENCIA = 60;

/** O instante da hora `HH:MM` do dia `AAAA-MM-DD` no fuso da empresa (o relógio da parede de lá, em UTC). */
export function instanteNoFuso(dia: string, hora: string, fuso: string): Date {
  const alvo = Date.parse(`${dia}T${hora}:00Z`);
  // A diferença do fuso naquele instante, conferida duas vezes (a troca de horário de verão muda a diferença).
  let palpite = alvo;
  for (let i = 0; i < 2; i++) {
    const v = noFuso(new Date(palpite), fuso);
    palpite += alvo - Date.parse(`${v.dia}T${v.hora}:00Z`);
  }
  return new Date(palpite);
}

/** O que a pessoa monta no novo post. */
export type NovoPost = { foto: string | null; canais: string[]; textos: Record<string, string>; dia: string; hora: string; recorte: number };
/** O erro de cada campo (o texto, por canal: `texto-instagram`, `texto-facebook`). */
export type ErrosDoNovo = Record<string, string>;

const numero = (n: number) => n.toLocaleString('pt-BR');
/** O texto de cada canal, no rótulo do campo e no erro: "Escreva o texto da legenda no Instagram." */
export const DO_TEXTO: Record<string, string> = { instagram: 'da legenda no Instagram', facebook: 'na Página do Facebook', tiktok: 'no TikTok', youtube: 'no YouTube' };

/** O que a tela confere antes de mandar (o servidor confere de novo, com as mesmas regras). */
export function conferirNovo(n: NovoPost, agora: Date, fuso: string): ErrosDoNovo {
  const e: ErrosDoNovo = {};
  if (!n.foto) e.foto = 'Escolha a foto do post.';
  if (!n.canais.length) e.canais = 'Escolha pelo menos um canal.';
  for (const c of n.canais) {
    const t = (n.textos[c] ?? '').trim();
    const lim = LIMITE_DO_TEXTO[c];
    if (!t) e[`texto-${c}`] = `Escreva o texto ${DO_TEXTO[c] ?? `em ${c}`}.`;
    else if (lim && t.length > lim) e[`texto-${c}`] = `${NO_CANAL[c]?.replace(/^./, (x) => x.toUpperCase()) ?? c}, o texto passa de ${numero(lim)} caracteres (tem ${numero(t.length)}).`;
  }
  const m = /^(\d{2}):(\d{2})$/.exec(n.hora);
  const minutos = m ? Number(m[1]) * 60 + Number(m[2]) : Number.NaN;
  if (!ehDiaIso(n.dia) || Number.isNaN(minutos)) e.hora = 'Escolha o dia e a hora.';
  else if (minutos < 8 * 60 || minutos > 22 * 60) e.hora = 'Escolha uma hora entre 8h e 22h.';
  else {
    const instante = instanteNoFuso(n.dia, n.hora, fuso).getTime();
    if (instante < agora.getTime() + ANTECEDENCIA_MINIMA_MIN * 60_000) e.hora = `Escolha uma hora daqui a pelo menos ${ANTECEDENCIA_MINIMA_MIN} minutos.`;
    else if (instante > agora.getTime() + DIAS_DE_ANTECEDENCIA * 86_400_000) e.hora = `O post pode ser marcado para até ${DIAS_DE_ANTECEDENCIA} dias.`;
  }
  return e;
}

/**
 * O que o botão do novo post diz (P22): com canal do Liame, vai para aprovação; só canal do pacote, o pacote fica pronto
 * na Agenda; com os dois, as duas coisas.
 */
export function textoDoBotao(canais: readonly string[]): string {
  const doPacote = canais.filter(ehDoPacote).length;
  if (doPacote && doPacote === canais.length) return 'Montar o pacote';
  return doPacote ? 'Mandar para aprovação e montar o pacote' : 'Mandar para aprovação';
}

/** A dica da hora no novo post: o que acontece nela, para o post e para o pacote. */
export function dicaDaHora(canais: readonly string[]): string {
  const doPacote = canais.filter(ehDoPacote).length;
  if (doPacote && doPacote === canais.length) return 'Entre 8h e 22h. O pacote aparece na Agenda nessa hora, para você publicar.';
  if (doPacote) return 'Entre 8h e 22h. O Liame publica na hora marcada, só depois de aprovado; o pacote fica pronto na Agenda, na mesma hora.';
  return 'Entre 8h e 22h. O Liame publica na hora marcada, só depois de aprovado.';
}

/**
 * O aviso depois de mandar: o post que foi para aprovação e o pacote que ficou pronto (na hora do fuso da empresa).
 * `canais` são os que a pessoa escolheu; a resposta do servidor é o post do Liame ou, sem ele, o primeiro pacote.
 */
export function avisoDoNovo(post: Pick<PostResponse, 'publish_at'>, canais: readonly string[], fuso: string, hoje: string): string {
  const { dia, hora } = noFuso(new Date(post.publish_at), fuso);
  const em = quando(dia, hora, hoje);
  const doPacote = CANAIS_DO_PACOTE.filter((c) => canais.includes(c));
  const doLiame = canais.some((c) => !ehDoPacote(c));
  if (!doPacote.length) return `Mandado para aprovação. O post sai ${em}, depois de aprovado.`;
  const de = emFrase(doPacote.map((c) => DO_CANAL[c] ?? c));
  const no = emFrase(doPacote.map((c) => NO_CANAL[c] ?? c));
  const um = doPacote.length === 1;
  if (doLiame) return `Mandado para aprovação, e ${um ? 'o pacote' : 'os pacotes'} ${de} ${um ? 'está' : 'estão'} na Agenda ${em}, para você publicar.`;
  return um ? `Pacote pronto. Ele aparece na Agenda ${em}, para você publicar ${no}.` : `Pacotes prontos. Eles aparecem na Agenda ${em}, para você publicar ${no}.`;
}

/** A dica do texto de cada canal no novo post (o que o canal faz com o link e quem publica; na Página, o link do post). */
export function dicaDoTexto(canal: string, postLink?: { ok: boolean; reason: string | null }): string {
  if (canal === 'instagram') return 'No Instagram, a legenda não tem link que abre: diga onde pedir (“Peça pelo link da bio”).';
  if (canal === 'tiktok') return 'No TikTok, a legenda não tem link que abre: diga onde pedir (“Peça pelo link da bio”). Quem publica é você: o Liame monta o pacote.';
  if (canal === 'youtube') return 'Quem publica é você: o Liame monta o pacote com o texto e a foto.';
  return `O texto que sai na Página, com a foto. ${dicaDoLinkDoPost(postLink)}`;
}

/** O link do post como a tela o mostra: o cardápio sem os parâmetros ("cardapio.regem.com/casa-brasa"). */
export function linkCurto(link: string): string {
  try {
    const u = new URL(link);
    return `${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return link;
  }
}

/**
 * O que o novo post diz do link do post na Página (D-A6-46 e D-A6-47): que ele entra no fim do texto, ou por que o post
 * sai sem ele (a marca sem loja com o cardápio, ou com mais de uma). Sem a resposta (o servidor antigo), como o P19.
 */
export function dicaDoLinkDoPost(postLink: { ok: boolean; reason: string | null } | undefined): string {
  if (!postLink || postLink.ok) return 'O link do post entra no fim, com o código só deste post.';
  if (postLink.reason === 'varias_lojas') return 'A marca tem mais de uma loja com o cardápio ligado: por enquanto, o post sai sem o link.';
  return 'Sem o cardápio do Regem ligado a uma loja desta marca, o post sai sem o link.';
}

/** A frase do topo da gaveta do pacote: para quando é, ou quando a pessoa marcou "Publiquei". */
export function fraseDoPacote(post: PostResponse, fuso: string, hoje: string): string {
  const c = post.channels[0];
  if (post.status === 'pacote_publicado') {
    const em = c?.published_at ? noFuso(new Date(c.published_at), fuso) : null;
    return em ? `Você marcou como publicado ${quando(em.dia, em.hora, hoje)}.` : 'Você marcou como publicado.';
  }
  const { dia, hora } = noFuso(new Date(post.publish_at), fuso);
  return `Você publica: ${NOME_DO_CANAL[c?.channel ?? ''] ?? c?.channel ?? ''}, ${quando(dia, hora, hoje)}.`;
}

/** O campo da recusa do servidor (o código do problema), para o erro aparecer no lugar certo; o resto vai para o topo. */
export function campoDaRecusa(code: string): 'foto' | 'canais' | 'hora' | 'texto' | null {
  if (code.startsWith('hora-')) return 'hora';
  if (code.startsWith('foto-')) return 'foto';
  if (code.startsWith('canal-')) return 'canais';
  if (code.startsWith('texto-')) return 'texto';
  return null;
}

/**
 * O quadro do recorte do Instagram sobre a foto inteira, em porcentagem: 4:5 na foto alta (anda para cima e para
 * baixo), 1,91:1 na larga (para os lados). Nulo quando a foto cabe.
 */
export function quadroDoRecorte(largura: number, altura: number, pos: number): { top: number; left: number; width: number; height: number } | null {
  const formato = formatoDaPrevia('instagram', largura, altura);
  if (formato === 'inteira') return null;
  const p = Math.min(100, Math.max(0, pos));
  if (formato === 'alta') {
    const h = Math.min(100, ((largura * 5) / 4 / altura) * 100);
    return { top: ((100 - h) * p) / 100, left: 0, width: 100, height: h };
  }
  const w = Math.min(100, ((altura * 1.91) / largura) * 100);
  return { top: 0, left: ((100 - w) * p) / 100, width: w, height: 100 };
}

/** As contas de um canal no novo post: a que vale (uma só) ou o porquê de não dar (nenhuma, ou mais de uma; D-A6-36). */
export function contaDoCanal(accounts: { id: string; name: string }[]): { conta: { id: string; name: string } | null; fora: string | null } {
  if (accounts.length === 1) return { conta: accounts[0]!, fora: null };
  if (accounts.length === 0) return { conta: null, fora: 'Não conectado: ligue em Contas conectadas para publicar aqui.' };
  return { conta: null, fora: 'Mais de uma conta ligada à marca: deixe uma só em Contas conectadas.' };
}
