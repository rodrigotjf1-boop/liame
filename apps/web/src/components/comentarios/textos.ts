import type { CommentsResponse, SocialComment } from '@liame/contracts';
import { haQuanto } from '@/components/avaliacoes/textos';
import { horaDe } from '@/lib/formato';

// A tela Comentários (mockups/prototipo-comentarios.html, P38 aprovado em 07/11/2026; A6, Z11, parte 3b): os comentários
// dos posts da marca no Instagram e na Página, como o Liame os guardou (`GET /v1/comments`), com as situações que
// filtram, o canal e a busca. Decidir a resposta ou o ocultar é em Aprovações (parte 3a); uma pessoa pede a resposta
// ou o ocultar na própria linha (parte 3c); o "Pedir outra" sugestão vem depois. Funções puras.

export type Filtro = 'pedem' | 'ocultar' | 'respondidos' | 'ocultos' | 'todos';
/** As situações que filtram, na ordem da tela, com o rótulo e a contagem que o servidor manda. */
export const FILTROS: ReadonlyArray<readonly [Filtro, string]> = [
  ['pedem', 'Pedem resposta'],
  ['ocultar', 'Para ocultar'],
  ['respondidos', 'Respondidos'],
  ['ocultos', 'Ocultos'],
  ['todos', 'Todos'],
];

/** A situação de cada comentário, na linha da lista. */
export const ROTULO_DA_SITUACAO: Record<string, { rotulo: string; classe: 'concluido' | 'espera' | 'perigo' | 'neutro' }> = {
  pede_resposta: { rotulo: 'Pede resposta', classe: 'espera' },
  para_ocultar: { rotulo: 'Para ocultar', classe: 'perigo' },
  respondido: { rotulo: 'Respondido', classe: 'concluido' },
  oculto: { rotulo: 'Oculto', classe: 'neutro' },
  sem_resposta: { rotulo: 'Sem resposta', classe: 'neutro' },
};

/** Quem comentou, como a rede mostra: no Instagram, o @; na Página, o nome. Nulo quando a rede não mandou. */
export function autorDoComentario(c: Pick<SocialComment, 'author' | 'channel'>): string | null {
  const a = c.author?.trim();
  if (!a) return null;
  return c.channel === 'instagram' && !a.startsWith('@') ? `@${a}` : a;
}

/** O que espera em Aprovações sobre o comentário, no botão da linha; nulo sem pedido. */
export function pedidoDoComentario(c: Pick<SocialComment, 'request'>): { rotulo: string; href: string } | null {
  const p = c.request;
  if (!p) return null;
  const oQue = p.tool === 'comentario_ocultar' ? 'Ocultar' : p.tool === 'comentario_mostrar' ? 'Mostrar de novo' : p.tool === 'comentario_apagar_resposta' ? 'Apagar a resposta' : 'Resposta';
  const situacao = p.status === 'aguardando_aprovacao' ? 'espera aprovação' : 'saindo';
  return { rotulo: `${oQue} ${situacao}`, href: `/aprovacoes?pedido=${p.id}` };
}

/** A legenda do post do comentário, curta (até 120 caracteres, com reticências). */
export function legendaDoPost(posts: CommentsResponse['posts'], c: Pick<SocialComment, 'post_id' | 'channel'>): string | null {
  const p = posts.find((x) => x.id === c.post_id && x.channel === c.channel);
  if (!p) return null;
  const t = p.caption.replace(/\s+/g, ' ').trim();
  if (!t) return 'post sem legenda';
  const letras = [...t];
  return letras.length > 120 ? `${letras.slice(0, 119).join('')}…` : t;
}

/** "Lido há 12 min" pela conta lida há mais tempo (a que manda na frase); sem leitura, nulo. */
export function lidoHa(accounts: CommentsResponse['accounts'], agora: Date): string | null {
  const lidas = accounts.map((a) => a.read_at).filter((x): x is string => Boolean(x));
  if (!lidas.length) return null;
  const mais = lidas.reduce((m, x) => (x < m ? x : m));
  const min = Math.max(0, Math.round((agora.getTime() - new Date(mais).getTime()) / 60_000));
  if (min < 1) return 'Lido agora';
  if (min < 60) return `Lido há ${min} min`;
  const h = Math.floor(min / 60);
  return h < 24 ? `Lido há ${h} h` : `Lido ${haQuanto(mais, agora)}`;
}

/** O aviso de cada conta que não leu (a permissão, a falha, a primeira leitura); vazio quando todas leram. */
export type AvisoDaConta = { conta: string; tom: 'aviso' | 'perigo' | 'info'; texto: string; contas: boolean };
export function avisosDasContas(accounts: CommentsResponse['accounts']): AvisoDaConta[] {
  const onde = (canal: string) => (canal === 'facebook' ? 'da Página' : 'do Instagram');
  const avisos: AvisoDaConta[] = [];
  for (const a of accounts) {
    if (a.situation === 'sem_permissao')
      avisos.push({ conta: a.name, tom: 'perigo', contas: true, texto: `A autorização da Meta não deixa o Liame ler os comentários ${onde(a.channel)} ${a.name}. Conecte a Meta de novo em Contas conectadas e confirme a conta.` });
    else if (a.situation === 'falhou') avisos.push({ conta: a.name, tom: 'aviso', contas: false, texto: `A última leitura dos comentários ${onde(a.channel)} ${a.name} não deu certo. O Liame tenta de novo sozinho.` });
    else if (a.situation === 'primeira_leitura') avisos.push({ conta: a.name, tom: 'info', contas: false, texto: `A primeira leitura dos comentários ${onde(a.channel)} ${a.name} ainda não terminou. Leva alguns minutos.` });
  }
  return avisos;
}

/** O que o leitor de tela ouve depois de "Comentários" no menu (P38): ", 1 pede resposta" ou ", 3 pedem resposta". */
export function comentariosFalados(n: number): string {
  return n === 1 ? ', 1 pede resposta' : `, ${n} pedem resposta`;
}

/** A recusa do pedido de uma pessoa (responder, ocultar, mostrar), nas palavras da tela; o resto, nas do servidor. */
export function erroDoPedido(p: { code: string; detail?: string; title: string }): string {
  if (p.code === 'acao-duplicada') return 'Já há um pedido em aberto para este comentário. Abra a lista de novo e siga para Aprovações.';
  if (p.code === 'escrita-desligada') return 'Responder e ocultar comentários pelo Liame ainda não estão ligados para esta empresa.';
  if (p.code === 'sem-permissao-na-plataforma') return 'A autorização da Meta não deixa o Liame responder ou ocultar este comentário. Conecte a Meta de novo em Contas conectadas.';
  return p.detail ?? p.title;
}

/** O "Ler agora": disponível, ou a hora em que fica. */
export function lerAgora(r: CommentsResponse['refresh']): { pode: boolean; dica: string | null } {
  if (r.available) return { pode: true, dica: null };
  return { pode: false, dica: r.next_at ? `Dá para ler de novo às ${horaDe(r.next_at)}.` : 'O Liame já está lendo os comentários.' };
}

/** O que a lista vazia diz, pelo filtro escolhido (com a busca, a frase é a da busca). */
export function vazioDoFiltro(filtro: Filtro, busca: string): { titulo: string; texto: string } {
  if (busca.trim()) return { titulo: 'Nenhum comentário com essa busca', texto: 'Tente outra palavra, ou limpe a busca para ver todos.' };
  const porFiltro: Record<Filtro, { titulo: string; texto: string }> = {
    pedem: { titulo: 'Nenhum comentário pede resposta agora', texto: 'As perguntas e as reclamações sem resposta da marca aparecem aqui, das mais antigas para as mais novas.' },
    ocultar: { titulo: 'Nenhum comentário para ocultar', texto: 'O que tem cara de golpe ou é ofensivo aparece aqui, com o pedido de ocultar em Aprovações.' },
    respondidos: { titulo: 'Nenhum comentário respondido ainda', texto: 'Os comentários com resposta da marca, pelo Liame ou direto na rede, aparecem aqui.' },
    ocultos: { titulo: 'Nenhum comentário oculto', texto: 'Os comentários ocultos, pelo Liame ou direto na rede, aparecem aqui.' },
    todos: { titulo: 'Nenhum comentário nos posts dos últimos 30 dias', texto: 'Quando alguém comentar num post da marca, o comentário aparece aqui na próxima leitura.' },
  };
  return porFiltro[filtro];
}
