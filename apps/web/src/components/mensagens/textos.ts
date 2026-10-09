import type { MessagingAccount, MessagingBudgetPeriod, MessagingCampaign, MessagingCampaignDetailResponse, MessagingResponse } from '@liame/contracts';
import type { NomeIcone } from '@/components/ui/icone';
import { inteiro, quandoComHora, reaisDeMicros } from '@/lib/formato';

// Textos e contas da tela "Mensagens" (mockups/prototipo-mensagens.html, P15 aprovado em 09/10/2026; Y4 da A5).
// Tudo vem de `GET /v1/messaging` e `GET /v1/messaging/campaigns/:id`, que leem o RegemCast na hora: a tela só
// escreve o que o servidor devolve. Só números e textos da loja ou do RegemCast; nenhum nome e nenhum telefone.
// O que o protótipo mostra por causa do cupom da mensagem (os pedidos, o caixa e o que voltou) entra com o pedido
// de mensagem (Y5): hoje nenhuma mensagem leva cupom criado pelo Liame.

const MICROS_POR_CENTAVO = 10_000n;

/** Centavos inteiros (como o RegemCast informa) em reais: "R$ 127,36". */
export function centavos(c: number): string {
  return reaisDeMicros(BigInt(c) * MICROS_POR_CENTAVO);
}

/** Quanto `parte` é de `todo`, em por cento inteiro (0 sem `todo`). */
export function porCento(parte: number, todo: number): number {
  return todo > 0 ? Math.round((parte / todo) * 100) : 0;
}

const plural = (n: number, um: string, varios: string) => `${inteiro(n)} ${n === 1 ? um : varios}`;

/** Fecha a frase com ponto, sem dobrar a pontuação que o RegemCast já escreveu. */
function ponto(texto: string): string {
  const t = texto.trim();
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

export type Selo = { classe: 'concluido' | 'perigo' | 'espera' | 'aguardando' | 'info'; rotulo: string; ponto: boolean };

const SELOS_DA_CAMPANHA: Record<string, Selo> = {
  rascunho: { classe: 'espera', rotulo: 'Rascunho', ponto: false },
  agendada: { classe: 'info', rotulo: 'Agendada', ponto: false },
  enviando: { classe: 'info', rotulo: 'Enviando', ponto: true },
  pausada: { classe: 'aguardando', rotulo: 'Pausada', ponto: true },
  concluida: { classe: 'concluido', rotulo: 'Enviada', ponto: true },
  cancelada: { classe: 'espera', rotulo: 'Cancelada', ponto: false },
};

export function seloDaCampanha(status: string): Selo {
  return SELOS_DA_CAMPANHA[status] ?? { classe: 'espera', rotulo: 'Situação não informada', ponto: false };
}

/** A campanha entra em "O que foi enviado": alguma mensagem saiu, ou o envio começou. Rascunho e agendada ficam no RegemCast. */
export function jaSaiu(c: MessagingCampaign): boolean {
  return c.sent > 0 || c.status === 'enviando' || c.status === 'pausada' || c.status === 'concluida';
}

// ---------------------------------------------------------------- a tela

export type TelaDasMensagens =
  | { tipo: 'desligada' }
  | { tipo: 'sem_regemcast' }
  | { tipo: 'contas'; lido: string; contas: { id: string; nome: string }[] };

/** O que a tela mostra para a resposta do servidor: a função desligada, o RegemCast sem conexão, ou as contas lidas. */
export function telaDasMensagens(r: MessagingResponse, agora: Date): TelaDasMensagens {
  if (!r.enabled) return { tipo: 'desligada' };
  if (!r.accounts.length) return { tipo: 'sem_regemcast' };
  return { tipo: 'contas', lido: `Lido do RegemCast ${quandoComHora(r.read_at, agora)}`, contas: r.accounts.map((a) => ({ id: a.connected_account_id, nome: a.name })) };
}

export interface Aviso {
  chave: string;
  tipo: 'perigo' | 'atencao';
  icone: NomeIcone;
  titulo: string;
  texto: string;
}

export interface CaixaDaConta {
  selo: Selo | null;
  /** Sem selo: o que escrever no lugar ("Sem permissão para ler"). */
  titulo: string | null;
  sub: string;
}

export interface PeriodoDoTeto {
  chave: string;
  /** "Teto de gasto de outubro". */
  rotulo: string;
  /** "R$ 96,00 de R$ 300,00". */
  valor: string;
  /** De 0 a 100, para a barra. */
  largura: number;
  cheio: boolean;
  /** O que a barra diz para quem não a vê. */
  descricao: string;
}

export type CaixaDoTeto = { tipo: 'periodos'; periodos: PeriodoDoTeto[]; sub: string; notas: string[] } | { tipo: 'texto'; titulo: string; sub: string };

export interface CaixaDoPronto {
  titulo: string;
  sub: string;
}

export interface MensagemDaLista {
  id: string;
  nome: string;
  selo: Selo;
  /** "08/10, 11:19 · Clientes de domingo": quando o envio começou e para quem. */
  sob: string;
  receberam: number;
  leram: number;
  /** De quem recebeu, quantos por cento leram. */
  leramPct: number;
  responderam: number;
  falharam: number;
}

export interface Trecho {
  t: string;
  forte?: boolean;
}

export type Enviadas =
  | { tipo: 'sem_permissao' }
  | { tipo: 'indisponivel' }
  | { tipo: 'vazia'; fora: string | null }
  | { tipo: 'lista'; frase: Trecho[]; itens: MensagemDaLista[]; fora: string | null; mais: string | null };

export type ContaDaTela =
  /** O RegemCast recusou a conexão desta conta: é conectar de novo. */
  | { tipo: 'sem_autorizacao' }
  /** A conexão não inclui nenhuma das leituras da tela. */
  | { tipo: 'sem_permissao' }
  /** Nenhuma leitura respondeu agora. */
  | { tipo: 'fora_do_ar' }
  | { tipo: 'ok'; avisos: Aviso[]; conta: CaixaDaConta; teto: CaixaDoTeto; pronto: CaixaDoPronto; enviadas: Enviadas };

const SEM_PERMISSAO = 'a conexão com o RegemCast não inclui esta leitura';
const SEM_RESPOSTA = 'o RegemCast não respondeu agora';

function partesDe(a: MessagingAccount): string[] {
  return [a.whatsapp.status, a.budget.status, a.ready.templates_status, a.ready.audiences_status, a.campaigns.status];
}

export function contaDaTela(a: MessagingAccount, agora: Date): ContaDaTela {
  if (a.status === 'sem_autorizacao') return { tipo: 'sem_autorizacao' };
  const partes = partesDe(a);
  if (a.status !== 'ok' || !partes.includes('ok')) return partes.every((p) => p === 'sem_permissao') && a.status === 'ok' ? { tipo: 'sem_permissao' } : { tipo: 'fora_do_ar' };
  const cheio = a.budget.status === 'ok' ? (a.budget.periods.find((p) => p.signal === 'cheio') ?? null) : null;
  const avisos: Aviso[] = [];
  const doWhatsapp = avisoDoWhatsapp(a);
  if (doWhatsapp) avisos.push(doWhatsapp);
  if (cheio) avisos.push(avisoDoTeto(cheio, a.budget.notices));
  return { tipo: 'ok', avisos, conta: caixaDaConta(a, agora), teto: caixaDoTeto(a, cheio !== null), pronto: caixaDoPronto(a), enviadas: enviadasDe(a, agora) };
}

// ---------------------------------------------------------------- a conta do WhatsApp

const SELOS_DO_WHATSAPP: Record<string, Selo> = {
  pode_enviar: { classe: 'concluido', rotulo: 'Pode enviar', ponto: true },
  com_restricao: { classe: 'perigo', rotulo: 'Com restrição', ponto: true },
  bloqueado: { classe: 'perigo', rotulo: 'Bloqueada', ponto: true },
};

function caixaDaConta(a: MessagingAccount, agora: Date): CaixaDaConta {
  const w = a.whatsapp;
  if (w.status !== 'ok') return { selo: null, titulo: w.status === 'sem_permissao' ? 'Sem permissão para ler' : 'Não foi possível ler agora', sub: w.status === 'sem_permissao' ? SEM_PERMISSAO : SEM_RESPOSTA };
  if (w.connected === false) return { selo: { classe: 'espera', rotulo: 'Sem número conectado', ponto: false }, titulo: null, sub: 'o número do WhatsApp é conectado no RegemCast' };
  const selo = (w.signal ? SELOS_DO_WHATSAPP[w.signal] : undefined) ?? { classe: 'espera', rotulo: 'Sem leitura da Meta', ponto: false };
  return { selo, titulo: null, sub: w.checked_at ? `lido da Meta ${quandoComHora(w.checked_at, agora)}` : 'o RegemCast ainda não leu a situação na Meta' };
}

/** A faixa da conta que não pode enviar: o que o RegemCast informa, com as palavras dele. */
function avisoDoWhatsapp(a: MessagingAccount): Aviso | null {
  const w = a.whatsapp;
  if (w.status !== 'ok') return null;
  if (w.connected === false) {
    return {
      chave: 'sem-numero',
      tipo: 'atencao',
      icone: 'plug',
      titulo: 'Nenhum número de WhatsApp está conectado no RegemCast',
      texto: 'Sem o número conectado, nenhuma mensagem sai. A conexão do número é feita no RegemCast.',
    };
  }
  if (w.signal !== 'com_restricao' && w.signal !== 'bloqueado') return null;
  const frases: string[] = [];
  const resumo = w.summary ?? w.title;
  if (resumo) frases.push(`O que o RegemCast informa: ${ponto(resumo)}`);
  if (w.problems.length) frases.push(`O que a Meta aponta: ${ponto(w.problems.map((p) => p.title).join('; '))}`);
  const acao = w.problems.find((p) => p.action)?.action;
  if (acao) frases.push(`O que fazer: ${ponto(acao)}`);
  frases.push('O que resolve fica no RegemCast.');
  return {
    chave: 'conta',
    tipo: 'perigo',
    icone: 'alert',
    titulo: w.signal === 'bloqueado' ? 'A conta do WhatsApp está bloqueada na Meta: nenhuma mensagem sai agora' : 'A conta do WhatsApp está com restrição na Meta',
    texto: frases.join(' '),
  };
}

// ---------------------------------------------------------------- o teto de gasto

/** "de outubro", "de hoje", "da semana": o período do teto, para completar "Teto de gasto …". */
function doPeriodo(p: MessagingBudgetPeriod): string {
  if (p.period === 'mes') return `de ${p.label.toLowerCase()}`;
  if (p.period === 'dia') return 'de hoje';
  if (p.period === 'semana') return 'da semana';
  return `(${p.label})`;
}

const VOLTA: Record<string, string> = {
  dia: 'O RegemCast pausa os envios e volta sozinho amanhã.',
  semana: 'O RegemCast pausa os envios e volta sozinho na virada da semana.',
  mes: 'O RegemCast pausa os envios e volta sozinho na virada do mês.',
};

function avisoDoTeto(p: MessagingBudgetPeriod, avisos: string[]): Aviso {
  const oQueAcontece = avisos.length ? avisos.map(ponto).join(' ') : (VOLTA[p.period] ?? 'O RegemCast pausa os envios enquanto o teto estiver cheio.');
  return {
    chave: 'teto',
    tipo: 'atencao',
    icone: 'wallet',
    titulo: `O teto de gasto de mensagens ${doPeriodo(p)} foi atingido`,
    texto: `Já saíram ${centavos(p.spent_cents)} de ${centavos(p.limit_cents)}. ${oQueAcontece} Quem muda o teto é você, no RegemCast.`,
  };
}

function caixaDoTeto(a: MessagingAccount, temFaixa: boolean): CaixaDoTeto {
  const b = a.budget;
  if (b.status !== 'ok') return { tipo: 'texto', titulo: b.status === 'sem_permissao' ? 'Sem permissão para ler' : 'Não foi possível ler agora', sub: b.status === 'sem_permissao' ? SEM_PERMISSAO : SEM_RESPOSTA };
  if (!b.periods.length) return { tipo: 'texto', titulo: 'Sem teto definido', sub: 'o teto de gasto de mensagens é definido por você no RegemCast' };
  return {
    tipo: 'periodos',
    periodos: b.periods.map((p) => {
      const pct = Math.round(p.percent);
      return {
        chave: p.period,
        rotulo: `Teto de gasto ${doPeriodo(p)}`,
        valor: `${centavos(p.spent_cents)} de ${centavos(p.limit_cents)}`,
        largura: Math.max(0, Math.min(100, pct)),
        cheio: p.signal === 'cheio',
        descricao: `${pct}% do teto de gasto de mensagens ${doPeriodo(p)} usado`,
      };
    }),
    sub: 'definido por você no RegemCast',
    // Com o teto cheio, o que o RegemCast avisa já está na faixa do topo.
    notas: temFaixa ? [] : b.notices,
  };
}

// ---------------------------------------------------------------- o que há pronto

function caixaDoPronto(a: MessagingAccount): CaixaDoPronto {
  const r = a.ready;
  const modelos = r.templates_status === 'ok' && r.approved_templates !== null ? r.approved_templates : null;
  const publicos = r.audiences_status === 'ok' && r.audiences !== null ? r.audiences : null;
  const partes: string[] = [];
  if (modelos !== null) partes.push(plural(modelos, 'modelo aprovado', 'modelos aprovados'));
  if (publicos !== null) partes.push(plural(publicos, 'público', 'públicos'));
  if (!partes.length) {
    const semPermissao = r.templates_status === 'sem_permissao' && r.audiences_status === 'sem_permissao';
    return { titulo: semPermissao ? 'Sem permissão para ler' : 'Não foi possível ler agora', sub: semPermissao ? 'a conexão com o RegemCast não inclui os modelos nem os públicos' : SEM_RESPOSTA };
  }
  const faltou = (status: string, oQue: string) => (status === 'sem_permissao' ? `a conexão com o RegemCast não inclui ${oQue}` : `${oQue} não foram lidos agora`);
  let sub: string;
  if (modelos === null) sub = faltou(r.templates_status, 'os modelos');
  else if (publicos === null) sub = faltou(r.audiences_status, 'os públicos');
  else if (modelos === 0) sub = 'sem modelo aprovado pela Meta, nenhuma mensagem pode sair';
  else if (publicos === 0) sub = 'nenhum público ainda: eles são montados no RegemCast';
  else if (r.largest_audience !== null) sub = `o maior público tem ${plural(r.largest_audience, 'pessoa que pode', 'pessoas que podem')} receber`;
  else sub = 'modelos aprovados pela Meta e públicos montados no RegemCast';
  return { titulo: partes.join(' · '), sub };
}

// ---------------------------------------------------------------- o que foi enviado

function mensagemDaLista(c: MessagingCampaign, agora: Date): MensagemDaLista {
  const comecou = c.started_at ?? c.created_at;
  return {
    id: c.id,
    nome: c.name,
    selo: seloDaCampanha(c.status),
    sob: [comecou ? quandoComHora(comecou, agora) : null, c.audience].filter(Boolean).join(' · '),
    receberam: c.delivered,
    leram: c.read,
    leramPct: porCento(c.read, c.delivered),
    responderam: c.replied,
    falharam: c.failed,
  };
}

/** A frase do modo simples: o que as mensagens da lista somam. */
export function fraseDasEnviadas(itens: MensagemDaLista[]): Trecho[] {
  const soma = itens.reduce((s, m) => ({ receberam: s.receberam + m.receberam, leram: s.leram + m.leram, responderam: s.responderam + m.responderam }), { receberam: 0, leram: 0, responderam: 0 });
  if (soma.receberam === 0) return [{ t: itens.length === 1 ? 'A mensagem ainda não chegou a ninguém.' : `As ${inteiro(itens.length)} mensagens ainda não chegaram a ninguém.` }];
  const uma = itens.length === 1;
  return [
    { t: uma ? 'A mensagem foi entregue ' : `As ${inteiro(itens.length)} mensagens foram entregues ` },
    { t: plural(soma.receberam, 'vez', 'vezes'), forte: true },
    { t: uma ? ', foi lida ' : ', foram lidas ' },
    { t: plural(soma.leram, 'vez', 'vezes'), forte: true },
    { t: uma ? ' e teve ' : ' e tiveram ' },
    { t: plural(soma.responderam, 'resposta', 'respostas'), forte: true },
    { t: '.' },
  ];
}

function enviadasDe(a: MessagingAccount, agora: Date): Enviadas {
  const c = a.campaigns;
  if (c.status === 'sem_permissao') return { tipo: 'sem_permissao' };
  if (c.status !== 'ok') return { tipo: 'indisponivel' };
  const saiu = c.items.filter(jaSaiu);
  const naoSaiu = c.items.length - saiu.length;
  const fora = naoSaiu > 0 ? `${naoSaiu === 1 ? 'Mais 1 campanha não aparece aqui porque nada saiu dela' : `Mais ${inteiro(naoSaiu)} campanhas não aparecem aqui porque nada saiu delas`} (rascunho, agendada ou cancelada antes do envio). O RegemCast mostra todas.` : null;
  if (!saiu.length) return { tipo: 'vazia', fora };
  const itens = saiu.map((m) => mensagemDaLista(m, agora));
  const mais = c.total !== null && c.total > c.items.length ? `A leitura traz só as campanhas mais novas: ${inteiro(c.items.length)} de ${inteiro(c.total)} que estão no RegemCast.` : null;
  return { tipo: 'lista', frase: fraseDasEnviadas(itens), itens, fora, mais };
}

// ---------------------------------------------------------------- uma mensagem de perto

const PAUSAS: Record<string, string> = {
  manual: 'Pausada por uma pessoa',
  orcamento: 'Pausada: o teto de gasto de mensagens foi atingido',
  teto_plano: 'Pausada: o plano do RegemCast chegou ao limite de mensagens',
  inadimplencia: 'Pausada: a assinatura do RegemCast tem pagamento pendente',
  modelo: 'Pausada: a Meta recusou o modelo da mensagem',
  conta_meta: 'Pausada: a Meta limitou a conta do WhatsApp',
  conexao: 'Pausada: o WhatsApp perdeu a conexão no RegemCast',
};

const ESPERAS: Record<string, string> = {
  limite_meta: 'Esperando: o limite de envios que a Meta dá ao número foi atingido',
  ritmo: 'Esperando: o RegemCast segurou o envio por um tempo',
};

export interface Porque {
  titulo: string;
  texto: string | null;
  /** "Volta hoje, 14:00." */
  volta: string | null;
}

export interface DetalheDaMensagem {
  dados: { rotulo: string; valor: string }[];
  pausa: Porque | null;
  espera: Porque | null;
  falhas: { titulo: string; itens: { chave: string; quantas: string; titulo: string; explicacao: string; acao: string | null }[]; semMotivo: boolean } | null;
  custo: { linhas: { rotulo: string; valor: string; detalhe: string | null }[]; avisos: string[] } | null;
  descanso: string | null;
}

/** Os números de uma campanha, na ordem em que a mensagem anda: saiu, chegou, foi lida, teve resposta, falhou. */
export function numerosDa(c: MessagingCampaign): { chave: string; valor: string; rotulo: string }[] {
  const n = [
    { chave: 'enviadas', valor: inteiro(c.sent), rotulo: 'enviadas' },
    { chave: 'entregues', valor: inteiro(c.delivered), rotulo: 'entregues' },
    { chave: 'lidas', valor: inteiro(c.read), rotulo: 'lidas' },
    { chave: 'responderam', valor: inteiro(c.replied), rotulo: 'responderam' },
    { chave: 'falharam', valor: inteiro(c.failed), rotulo: 'falharam' },
  ];
  if (c.queued > 0) n.push({ chave: 'fila', valor: inteiro(c.queued), rotulo: 'na fila' });
  return n;
}

/** O que a lista já sabe da campanha, para a gaveta abrir sem esperar o RegemCast. */
export function dadosDa(c: MessagingCampaign, agora: Date): { rotulo: string; valor: string }[] {
  const dados = [
    { rotulo: 'Situação', valor: seloDaCampanha(c.status).rotulo },
    { rotulo: 'Para quantas pessoas', valor: inteiro(c.recipients) },
    { rotulo: 'Modelo', valor: c.category ? `${c.template} (${c.category})` : c.template },
    { rotulo: 'Público', valor: c.audience ?? 'Não informado' },
  ];
  if (c.started_at) dados.push({ rotulo: 'Começou', valor: quandoComHora(c.started_at, agora) });
  if (c.finished_at) dados.push({ rotulo: 'Terminou', valor: quandoComHora(c.finished_at, agora) });
  return dados;
}

export function detalheDaMensagem(d: MessagingCampaignDetailResponse, agora: Date): DetalheDaMensagem {
  const c = d.campaign;
  const pausa: Porque | null = d.pause
    ? { titulo: PAUSAS[d.pause.reason] ?? 'Pausada', texto: d.pause.explanation ? ponto(d.pause.explanation) : null, volta: d.pause.resumes_at ? `Volta ${quandoComHora(d.pause.resumes_at, agora)}.` : null }
    : null;
  const espera: Porque | null = d.waiting ? { titulo: ESPERAS[d.waiting.reason] ?? 'Esperando para continuar', texto: null, volta: d.waiting.until ? `Continua ${quandoComHora(d.waiting.until, agora)}.` : null } : null;
  const falhas =
    c.failed > 0 || d.failures.length
      ? {
          titulo: c.failed > 0 ? `Por que ${plural(c.failed, 'falhou', 'falharam')}` : 'Por que falharam',
          itens: d.failures.map((f, i) => ({ chave: `${i}-${f.title}`, quantas: inteiro(f.messages), titulo: f.title, explicacao: ponto(f.explanation), acao: f.action ? ponto(f.action) : null })),
          semMotivo: !d.failures.length,
        }
      : null;
  let custo: DetalheDaMensagem['custo'] = null;
  if (d.cost) {
    const linhas = d.cost.lines.map((l) => ({ rotulo: l.label, valor: l.value, detalhe: l.detail }));
    // Sem as linhas do RegemCast, a tela escreve o que ele informou em número.
    if (!linhas.length) {
      if (d.cost.spent_cents !== null) linhas.push({ rotulo: 'Já gasto na Meta', valor: centavos(d.cost.spent_cents), detalhe: null });
      if (d.cost.to_spend_cents !== null && d.cost.to_spend_cents > 0) linhas.push({ rotulo: 'Ainda pode sair', valor: `até ${centavos(d.cost.to_spend_cents)}`, detalhe: null });
    }
    custo = { linhas, avisos: d.cost.notices.map(ponto) };
  }
  const descanso = d.rest_days === null ? null : d.rest_days === 0 ? 'Esta conta não tem descanso entre mensagens de marketing no RegemCast.' : `No RegemCast, quem recebe uma mensagem de marketing só recebe outra depois de ${plural(d.rest_days, 'dia', 'dias')}.`;
  return { dados: dadosDa(c, agora), pausa, espera, falhas, custo, descanso };
}
