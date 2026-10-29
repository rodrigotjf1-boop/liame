import type { PostChannelResponse, PostListResponse, PostResponse } from '@liame/contracts';
import type { NomeIcone } from '@/components/ui/icone';

// A Agenda (mockups/prototipo-post.html, P19 aprovado em 21/10/2026; Z5c da A6): os posts da marca na semana, dia a
// dia, no fuso da empresa (que vem do servidor: a janela das 8h às 22h é nele). Funções puras: a semana, o dia e a hora
// de cada post, a situação dele e a de cada canal. O que o P19 mostra e o servidor ainda não faz (a pauta e a data
// comercial do dia, mudar a hora, apagar das redes, tentar de novo, o link do post) fica fora, como divergência
// (`decisoes-design.md`, 29/10/2026).

export const DIAS_CURTOS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'] as const;
export const DIAS_LONGOS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'] as const;

/** O nome de cada canal nas frases e nas abas. */
export const NOME_DO_CANAL: Record<string, string> = { instagram: 'Instagram', facebook: 'Página do Facebook' };
/** O nome curto, no cartão do dia. */
const NOME_CURTO: Record<string, string> = { instagram: 'Instagram', facebook: 'Facebook' };
/** "no Instagram", "na Página do Facebook" (V121: a preposição vai com o nome). */
export const NO_CANAL: Record<string, string> = { instagram: 'no Instagram', facebook: 'na Página do Facebook' };

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
  /** A marca não tem conta conectada em nenhum canal: o post não tem onde sair. */
  | { tipo: 'sem-canal'; dias: DiaDaAgenda[] }
  | { tipo: 'semana'; dias: DiaDaAgenda[]; faltam: string[] };

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
    const item: PostNoDia = { post, dia, hora, canais, situacao, rotulo: `Post de ${quando(dia, hora, hoje)}, ${post.channels.map((c) => NOME_DO_CANAL[c.channel] ?? c.channel).join(' e ')}: ${situacao.rotulo.toLowerCase()}` };
    porDia.set(dia, [...(porDia.get(dia) ?? []), item]);
  }
  const dias: DiaDaAgenda[] = Array.from({ length: 7 }, (_, i) => {
    const iso = somaDias(inicio, i);
    const posts = (porDia.get(iso) ?? []).sort((a, b) => a.hora.localeCompare(b.hora) || a.post.id.localeCompare(b.post.id));
    return { iso, curto: DIAS_CURTOS[diaDaSemana(iso)]!, longo: DIAS_LONGOS[diaDaSemana(iso)]!, num: iso.slice(8, 10), hoje: iso === hoje, passado: iso < hoje, posts };
  });
  const semConta = dados.channels.filter((c) => c.accounts.length === 0).map((c) => c.channel);
  if (dados.channels.length > 0 && semConta.length === dados.channels.length) return { tipo: 'sem-canal', dias };
  return { tipo: 'semana', dias, faltam: semConta.map((c) => NOME_DO_CANAL[c] ?? c) };
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
  if (['cancelado', 'recusado', 'expirado'].includes(post.status)) return { ...base, icone: 'x', tom: '', frase: 'não saiu.' };
  return { ...base, icone: 'clock', tom: 'espera', frase: `sai ${quando(marcado.dia, marcado.hora, hoje)}.` };
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
