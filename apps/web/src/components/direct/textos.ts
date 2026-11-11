import { DIRECT_AUTO_REPLY_NOTICE, type DIRECT_AUTO_REPLY_KINDS, type DirectAutoReplyResponse, type DirectConversation, type DirectMessage, type DirectSettingsResponse } from '@liame/contracts';
import { mensagemDe, type Problema } from '@/lib/api';
import { dataCompleta, diasAte, horaDe, quandoComHora } from '@/lib/formato';

// ------------------------------------------------------------------ o atendimento automático (parte 5b; P39 versão 2)

/** Os tipos que o automático do Direct responde sozinho, nesta versão (a pergunta entra com o Social media, na 4b). */
export const TIPOS_DO_AUTOMATICO_DO_DIRECT: ReadonlyArray<{ id: (typeof DIRECT_AUTO_REPLY_KINDS)[number]; rotulo: string; texto: string }> = [
  { id: 'pronta', rotulo: 'Elogios, respostas ao story e menções', texto: 'Um agradecimento curto, com a resposta pronta, sem IA, com variação.' },
];

/** O aviso no fim de cada resposta automática, como a pessoa lê no Instagram (sem as quebras de linha do começo). */
export const AVISO_DO_DIRECT = DIRECT_AUTO_REPLY_NOTICE.trim();

/** A mensagem da marca que saiu pelo atendimento automático (pelo aviso no fim; a Meta pode mexer nos espaços). */
export function saiuSozinha(texto: string): boolean {
  return texto.trimEnd().endsWith(AVISO_DO_DIRECT);
}

/** A linha do topo da caixa: o que está valendo agora. */
export function resumoDoAutomaticoDoDirect(r: DirectAutoReplyResponse): string {
  if (!r.enabled) {
    return 'Desligado: nenhuma resposta sai sem uma pessoa da equipe. Ligado, o Liame responde sozinho os elogios, as respostas ao story e as menções.';
  }
  if (r.last_hour >= r.hourly_limit) return `Chegou a ${r.hourly_limit} respostas sozinho nesta hora, o teto: o resto fica com você.`;
  const n = r.last_hour === 1 ? '1 resposta' : `${r.last_hour} respostas`;
  return `${n} sozinho nesta hora (no máximo ${r.hourly_limit}). Perguntas, reclamações e quem pede alguém esperam você.`;
}

/** O botão da linha: ajustar (ligado), ver e ligar (quem liga) ou ver como funciona (os outros). */
export function botaoDoAutomaticoDoDirect(r: DirectAutoReplyResponse): string {
  if (r.enabled) return 'Ajustar';
  return r.can_enable ? 'Ver e ligar' : 'Ver como funciona';
}

/** O estado, no topo da gaveta: quem ligou e quando, ou desligado. */
export function estadoDoAutomaticoDoDirect(r: DirectAutoReplyResponse): string {
  if (!r.enabled) return 'Desligado: nenhuma resposta sai sem uma pessoa da equipe.';
  const quem = r.updated_by ? ` por ${r.updated_by.name}` : '';
  const quando = r.updated_at ? ` em ${dataCompleta(r.updated_at)}, às ${horaDe(r.updated_at)}` : '';
  return `Ligado${quem}${quando}. Desligar vale na hora, sem código, para quem aprova.`;
}

/** Ligar, ou somar um tipo com ele ligado, pede a confirmação; desligar e tirar um tipo, não. */
export function pedeConfirmacaoDoDirect(antes: { enabled: boolean; kinds: readonly string[] }, depois: { enabled: boolean; kinds: readonly string[] }): boolean {
  if (!depois.enabled) return false;
  return !antes.enabled || depois.kinds.some((k) => !antes.kinds.includes(k));
}

/** A recusa da mudança, nas palavras da gaveta; o resto, nas do servidor. */
export function erroDoAutomaticoDoDirect(p: Problema): string {
  if (p.code === 'so-dono-ou-administrador') return 'Só o Dono ou um Administrador liga o atendimento automático ou soma um tipo. Você pode desligar ou tirar um tipo.';
  if (p.code === 'funcao-desligada') return 'O atendimento automático do Direct ainda não está liberado para esta empresa.';
  if (p.code === 'direct-desligado') return 'O Direct está desligado nesta marca: ligue o Direct antes do atendimento automático.';
  if (p.code === 'sem-tipo') return 'Para ligar, marque pelo menos um tipo de conversa.';
  return mensagemDe(p);
}

// Os textos e as regras da tela Direct (A6, Z12, parte 3; mockups/prototipo-direct.html, P39 aprovado em 11/11/2026):
// o que a tela mostra para cada estado do ajuste da marca, as situações que filtram, a janela da Meta de cada conversa,
// as mensagens que o Liame não guarda (foto, vídeo, story) e o espaço da resposta (a Meta aceita até 1.000 bytes).

export type FiltroDoDirect = 'espera' | 'fechando' | 'respondida' | 'fora' | 'todas';

/** O que o leitor de tela ouve depois de "Direct" no menu (P39). */
export function conversasFaladas(n: number): string {
  return n === 1 ? ', 1 espera resposta' : `, ${n} esperam resposta`;
}

/** As situações que filtram, na ordem do protótipo. */
export const FILTROS_DO_DIRECT: [FiltroDoDirect, string][] = [
  ['espera', 'Esperam resposta'],
  ['fechando', 'Janela fechando'],
  ['respondida', 'Respondidas'],
  ['fora', 'Fora da janela'],
  ['todas', 'Todas'],
];

/** A Meta aceita até 1.000 bytes em UTF-8 por mensagem de texto (a letra com acento ocupa 2). */
export const ESPACO_DA_RESPOSTA = 1000;

export function bytesDoTexto(texto: string): number {
  return new TextEncoder().encode(texto).length;
}

/** O que impede mandar a resposta (antes de ir ao servidor), ou nulo. */
export function recusaDaResposta(texto: string): string | null {
  const t = texto.trim();
  if (!t) return 'Escreva a resposta.';
  if (bytesDoTexto(t) > ESPACO_DA_RESPOSTA) return 'A resposta passou do espaço da Meta (1.000). Encurte o texto.';
  return null;
}

/** O @ com a arroba, ou "Quem escreveu" quando a Meta não mandou. */
export function quemEscreveu(username: string | null): string {
  return username ? `@${username}` : 'Quem escreveu';
}

/** As iniciais do @ para o círculo da lista ("ana.paula_rj" → "AP"). */
export function iniciaisDoArroba(username: string | null): string {
  if (!username) return '?';
  const partes = username.split(/[._\-\d]+/).filter(Boolean);
  return (partes.length > 1 ? `${partes[0]![0]}${partes[1]![0]}` : username.slice(0, 2)).toUpperCase();
}

/** "faltam 23 h 53 min", "faltam 40 min". */
export function falta(ate: string, agora: Date): string {
  const min = Math.max(0, Math.round((new Date(ate).getTime() - agora.getTime()) / 60_000));
  if (min < 60) return `faltam ${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `faltam ${h} h ${m} min` : `faltam ${h} h`;
}

/** "hoje, às 14:45", "amanhã, às 13:58" ou "13/11, às 09:00". */
function diaEHora(iso: string, agora: Date): string {
  const dias = diasAte(iso, agora);
  if (dias === 0) return `hoje, às ${horaDe(iso)}`;
  if (dias === 1) return `amanhã, às ${horaDe(iso)}`;
  if (dias === -1) return `ontem, às ${horaDe(iso)}`;
  return quandoComHora(iso, agora).replace(', ', ', às ');
}

export type Janela = { nivel: 'ok' | 'atencao' | 'fechada'; texto: string };

/** A linha da janela da Meta, no alto da conversa. */
export function janelaDaConversa(c: Pick<DirectConversation, 'status' | 'closing' | 'window_until'>, agora: Date): Janela {
  if (c.status === 'respondida') return { nivel: 'ok', texto: 'Respondida. Se a pessoa escrever de novo, a janela abre outra vez.' };
  if (!c.window_until) return { nivel: 'ok', texto: 'A pessoa ainda não escreveu nesta conversa: o Instagram só deixa a marca responder depois.' };
  if (c.status === 'fora') return { nivel: 'fechada', texto: `A janela fechou ${diaEHora(c.window_until, agora)}: 24 horas depois da última mensagem da pessoa.` };
  if (c.closing) {
    return { nivel: 'atencao', texto: `A janela fecha ${diaEHora(c.window_until, agora)} (${falta(c.window_until, agora)}). Depois, só quando a pessoa escrever de novo.` };
  }
  return { nivel: 'ok', texto: `Dá para responder até ${diaEHora(c.window_until, agora)} (${falta(c.window_until, agora)}).` };
}

/** O selo da situação na lista (o que esperam não leva selo: o filtro já diz). */
export function seloDaSituacao(
  c: Pick<DirectConversation, 'status' | 'closing' | 'window_until'> & Partial<Pick<DirectConversation, 'last_message'>>,
  agora: Date,
): { texto: string; classe: string } | null {
  if (c.status === 'espera' && c.closing && c.window_until) return { texto: `Janela fecha em ${falta(c.window_until, agora).replace('faltam ', '')}`, classe: 'st--perigo' };
  if (c.status === 'fora') return { texto: 'Fora da janela', classe: 'st--espera' };
  if (c.status === 'respondida') {
    // A resposta que saiu pelo atendimento automático (parte 5b; P39 versão 2).
    const m = c.last_message;
    if (m?.direction === 'saida' && saiuSozinha(m.text)) return { texto: 'Respondida sozinho', classe: 'st--concluido' };
    return { texto: 'Respondida', classe: 'st--espera' };
  }
  return null;
}

/** O tipo da conversa (parte 4a: a regra dos comentários, pelo que a pessoa escreveu desde a última resposta da marca). */
const TIPOS_NO_DIRECT: Record<string, { rotulo: string; classe: string }> = {
  pergunta: { rotulo: 'Pergunta', classe: 'st--info' },
  reclamacao: { rotulo: 'Reclamação', classe: 'st--aguardando' },
  elogio: { rotulo: 'Elogio', classe: 'st--concluido' },
  mencao: { rotulo: 'Menção no story', classe: 'st--concluido' },
  golpe: { rotulo: 'Golpe', classe: 'st--perigo' },
  ofensivo: { rotulo: 'Ofensa', classe: 'st--perigo' },
};

/** O selo do tipo, ou nulo (sem tipo, ou um tipo que esta versão da tela não conhece). */
export function tipoDaConversa(kind: string | null): { rotulo: string; classe: string } | null {
  return kind ? (TIPOS_NO_DIRECT[kind] ?? null) : null;
}

/** O que só a Meta guarda: a frase no lugar da mensagem. */
const SO_NA_META: Record<string, string> = {
  imagem: 'Foto',
  video: 'Vídeo',
  audio: 'Áudio',
  arquivo: 'Arquivo',
  compartilhamento: 'Um post compartilhado',
  story_resposta: 'Respondeu ao seu story',
  story_mencao: 'Marcou a marca no story',
  reel: 'Um Reels compartilhado',
  sem_suporte: 'Uma mensagem que a API da Meta não mostra',
};

/** A mensagem que o Liame não guarda (foto, vídeo, story): a frase e se é do story. Nula para o texto. */
export function anexoDaMensagem(m: Pick<DirectMessage, 'kind'>): { texto: string; story: boolean } | null {
  if (m.kind === 'texto') return null;
  return { texto: SO_NA_META[m.kind] ?? 'Uma mensagem que só o Instagram mostra', story: m.kind === 'story_resposta' || m.kind === 'story_mencao' };
}

/** A prévia da última mensagem na lista. */
export function previaDaConversa(c: Pick<DirectConversation, 'last_message'>): string {
  const m = c.last_message;
  if (!m) return 'Sem mensagem guardada';
  const anexo = anexoDaMensagem(m);
  const texto = anexo ? (m.text ? `${anexo.texto}: ${m.text}` : anexo.texto) : m.text;
  if (m.direction !== 'saida') return texto;
  // A resposta automática aparece sem o aviso, que a lista já diz no selo.
  return saiuSozinha(texto) ? `Você: ${texto.trimEnd().slice(0, -AVISO_DO_DIRECT.length).trimEnd()}` : `Você: ${texto}`;
}

/** O vazio de cada situação (com busca, a frase da busca). */
export function vazioDoDirect(filtro: FiltroDoDirect, busca: string): { titulo: string; texto: string } {
  if (busca) return { titulo: 'Nada com essa busca', texto: `Nenhuma conversa com "${busca}" nesta situação.` };
  if (filtro === 'espera') return { titulo: 'Tudo respondido', texto: 'Nenhuma conversa espera resposta. Quando alguém mandar uma mensagem para o Instagram da marca, ela aparece aqui.' };
  return { titulo: 'Nenhuma conversa aqui', texto: 'Quando uma conversa entrar nesta situação, ela aparece nesta lista.' };
}

/** O que a tela mostra, pelo ajuste da marca (na ordem do protótipo). */
export type EstadoDoDirect =
  | 'desligada' // sem a função liberada para a empresa
  | 'sem_instagram'
  | 'regem' // a Central do Regem atende o Direct desta conta (D-A6-107)
  | 'ligar' // a função liberada e o Instagram conectado, mas o Direct desligado na marca
  | 'primeira' // ligado, a primeira leitura ainda não veio
  | 'caixa';

export function estadoDoDirect(s: Pick<DirectSettingsResponse, 'available' | 'account' | 'regem' | 'enabled' | 'reading'>): EstadoDoDirect {
  if (!s.available) return 'desligada';
  if (!s.account) return 'sem_instagram';
  if (s.regem === 'atende') return 'regem';
  if (!s.enabled) return 'ligar';
  if (s.reading === 'nunca') return 'primeira';
  return 'caixa';
}

/** A faixa de cima da caixa: a leitura sem permissão, a que falhou e o Regem que não deu para conferir. */
export function avisoDaLeitura(s: Pick<DirectSettingsResponse, 'reading' | 'regem' | 'read_at'>, conta: string, agora: Date): { tipo: 'atencao' | 'perigo'; titulo: string; texto: string; contas: boolean } | null {
  if (s.regem === 'nao_conferido') {
    return {
      tipo: 'atencao',
      titulo: 'Não deu para conferir com o Regem',
      texto:
        'A sua empresa usa o Regem, e a autorização dele ainda não deixa o Liame conferir se a Central de atendimento responde este Direct. Para ninguém receber duas respostas, o Liame não lê até conferir. Conecte o Regem de novo em Contas conectadas.',
      contas: true,
    };
  }
  if (s.reading === 'sem_permissao') {
    return {
      tipo: 'atencao',
      titulo: 'Falta a permissão de mensagens',
      texto: `A Meta não deixa o Liame ler o Direct do ${conta}. Conecte a Meta de novo e confirme a Página e o Instagram em "Escolher contas". Se já conectou, confira no Instagram da marca se a opção que libera as mensagens para as ferramentas conectadas está ligada.`,
      contas: true,
    };
  }
  if (s.reading === 'falhou') {
    const desde = s.read_at ? ` As conversas abaixo são as da leitura de ${quandoComHora(s.read_at, agora)}.` : '';
    return { tipo: 'perigo', titulo: 'A Meta não respondeu na última leitura', texto: `${desde} O Liame tenta de novo sozinho em alguns minutos.`.trim(), contas: false };
  }
  return null;
}

/** "Lido há 1 min: o Liame lê a cada minuto." */
export function lidoDoDirect(readAt: string | null, agora: Date): string {
  if (!readAt) return 'Ainda não lido';
  const min = Math.max(0, Math.round((agora.getTime() - new Date(readAt).getTime()) / 60_000));
  const ha = min < 1 ? 'agora há pouco' : min < 60 ? `há ${min} min` : `às ${horaDe(readAt)}`;
  return `Lido ${ha}: o Liame lê a cada minuto`;
}

/** A frase do atendimento aberto ("Atendimento aberto até 22:05"). */
export function textoDoAtendimento(ate: string | null, agora: Date): string {
  if (!ate) return 'Atendimento fechado: mandar pede a sua confirmação uma vez';
  const d = diasAte(ate, agora);
  return `Atendimento aberto até ${d === 0 ? horaDe(ate) : `amanhã, às ${horaDe(ate)}`}`;
}

/** A recusa de mandar, em frase (o 409 do atendimento fechado é tratado pela tela, que pede a confirmação). */
export function erroDaResposta(p: Problema): string {
  if (p.code === 'direct-desligado') return 'O Direct está desligado nesta marca. Ligue de novo para responder.';
  if (p.code === 'plano-recusado' && p.detail) return p.detail;
  if (p.status === 404) return 'A conversa não está mais no Liame. A lista foi lida de novo.';
  if (p.status === 403) return 'Responder no Direct é do Dono, dos Administradores e de quem aprova.';
  return mensagemDe(p);
}

/** A situação do pedido depois de mandar, em frase. */
export function situacaoDoEnvio(status: string, motivo: string | null): { fim: boolean; ok: boolean; texto: string } {
  if (status === 'executada') return { fim: true, ok: true, texto: 'enviada' };
  if (status === 'falhou' || status === 'cancelada' || status === 'expirada') {
    return { fim: true, ok: false, texto: motivo ? `Não saiu: ${motivo}` : 'Não saiu. Tente de novo.' };
  }
  return { fim: false, ok: false, texto: 'enviando…' };
}
