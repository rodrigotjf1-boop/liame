import type { ConversationBlock, ConversationMessage, ConversationSummary, CouponRequest, DemandResponse, ExplanationSegment, SupportContact } from '@liame/contracts';
import type { NomeIcone } from '@/components/ui/icone';
import { diasAte, horaDe, inteiro, quandoComHora } from '@/lib/formato';
import type { Modo } from '@/lib/modo';

// Textos e regras da Conversa com a LIA (mockups/prototipo-conversa.html, P5 aprovado em 03/10/2026). O que a LIA
// escreve vem pronto e conferido da API, em blocos; aqui fica o que a tela diz em volta: a saudação, as sugestões,
// os avisos do sistema (nenhum deles é escrito por IA), as faixas de limite e os cartões do que ela registrou.

/** O tamanho máximo de uma mensagem (o mesmo do contrato) e a partir de quando a tela avisa que está perto. */
export const MENSAGEM_MAXIMA = 2000;
export const AVISAR_A_PARTIR_DE = 1800;

/** As perguntas prontas: de dono no Lite, de quem opera no Pro. Somem quando a conversa começa. */
export const SUGESTOES: Record<Modo, string[]> = {
  lite: ['Como foi a semana?', 'Por que tem pedido sem origem?', 'Quero uma promoção para sexta-feira', 'Vale pausar alguma campanha?'],
  pro: ['Compare Meta e Google em 7 dias', 'Por que tem pedido sem origem?', 'Proponha um cupom exclusivo para uma campanha', 'Vale pausar alguma campanha?'],
};

/** A saudação que abre toda conversa nova: escrita pela tela, não pela IA. */
export function saudacaoDa(nomeDaPessoa: string, nomeDaMarca: string): string[] {
  const primeiro = nomeDaPessoa.trim().split(/\s+/)[0] ?? '';
  return [
    `Oi${primeiro ? `, ${primeiro}` : ''}. Eu sou a LIA, a assistente de IA da Liame.`,
    `Leio os números da ${nomeDaMarca} (vendas confirmadas no caixa, campanhas, avisos, cupons e links) para explicar, comparar e propor. Também registro pedidos para a equipe.`,
    'Não mexo em campanha e não aprovo gasto: isso continua com você.',
  ];
}

/** "Faltam 120 caracteres…" a partir de 1.800; nulo antes disso. */
export function contaDaMensagem(n: number): string | null {
  if (n < AVISAR_A_PARTIR_DE) return null;
  return n >= MENSAGEM_MAXIMA ? 'A mensagem chegou ao limite de 2.000 caracteres.' : `Faltam ${inteiro(MENSAGEM_MAXIMA - n)} caracteres para o limite da mensagem.`;
}

/** O aviso embaixo da mensagem da pessoa quando algum dado pessoal saiu antes de ela ir para a LIA. */
export function notaDeDadoPessoal(retirados: number | null): string | null {
  if (!retirados) return null;
  return `${retirados === 1 ? 'Um dado pessoal foi retirado' : `${inteiro(retirados)} dados pessoais foram retirados`} antes de a mensagem ir para a LIA: dado de cliente não é enviado à IA.`;
}

/** "Hoje", "Ontem" ou "22/09": o dia que separa as mensagens. */
export function diaDaMensagem(iso: string, agora: Date): string {
  const dias = diasAte(iso, agora);
  if (dias === 0) return 'Hoje';
  if (dias === -1) return 'Ontem';
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ o corpo da resposta

export type Grupo =
  | { tipo: 'paragrafo'; texto: ExplanationSegment[] }
  | { tipo: 'lista'; itens: ExplanationSegment[][] }
  | { tipo: 'fazer'; itens: ExplanationSegment[][] }
  | { tipo: 'risco'; risco: string; texto: ExplanationSegment[] };

/** Os blocos na ordem da leitura, com os itens seguidos juntos numa lista. Bloco de tipo novo vira parágrafo (V23). */
export function gruposDe(blocos: ConversationBlock[]): Grupo[] {
  const grupos: Grupo[] = [];
  for (const b of blocos) {
    const ultimo = grupos[grupos.length - 1];
    if (b.kind === 'item') {
      if (ultimo?.tipo === 'lista') ultimo.itens.push(b.text);
      else grupos.push({ tipo: 'lista', itens: [b.text] });
    } else if (b.kind === 'fazer') {
      if (ultimo?.tipo === 'fazer') ultimo.itens.push(b.text);
      else grupos.push({ tipo: 'fazer', itens: [b.text] });
    } else if (b.kind === 'risco') grupos.push({ tipo: 'risco', risco: b.risk ?? 'medio', texto: b.text });
    else grupos.push({ tipo: 'paragrafo', texto: b.text });
  }
  return grupos;
}

const corrido = (t: ExplanationSegment[]) => t.map((s) => s.text).join('').replace(/\s+/g, ' ').trim();

/** A resposta em texto simples, para o "Copiar". */
export function textoDaResposta(m: Pick<ConversationMessage, 'blocks'>): string {
  const linhas: string[] = [];
  for (const g of gruposDe(m.blocks)) {
    if (g.tipo === 'paragrafo') linhas.push(corrido(g.texto));
    else if (g.tipo === 'risco') linhas.push(`Risco ${g.risco === 'medio' ? 'médio' : g.risco}: ${corrido(g.texto)}`);
    else {
      if (g.tipo === 'fazer') linhas.push('O que fazer:');
      for (const i of g.itens) linhas.push(`- ${corrido(i)}`);
    }
  }
  return linhas.filter(Boolean).join('\n');
}

/** Para onde a resposta pode levar, pelo que a LIA leu (no máximo dois caminhos, só para quem pode ver a tela). */
export function caminhosDa(lido: string[], pode: (permissao: string) => boolean): Array<{ href: string; rotulo: string }> {
  const caminhos: Array<{ href: string; rotulo: string }> = [];
  if (lido.some((l) => l.startsWith('Resultados')) && pode('vendas.ver')) caminhos.push({ href: '/resultados', rotulo: 'Ver em Resultados' });
  if (lido.some((l) => l.startsWith('Avisos')) && pode('campanhas.ver')) caminhos.push({ href: '/atencao', rotulo: 'Ver os avisos' });
  if (lido.some((l) => l.startsWith('Cupons') || l.startsWith('Links')) && pode('vendas.ver')) caminhos.push({ href: '/links', rotulo: 'Ver links e cupons' });
  return caminhos.slice(0, 2);
}

// ------------------------------------------------------------------ avisos do sistema (sem IA)

export interface AvisoDoSistema {
  icone: NomeIcone;
  /** O selo ao lado de "Aviso do sistema". */
  selo: string;
  titulo: string;
  paragrafos: string[];
  /** O que dá para fazer: tentar de novo, ver a conexão parada ou escrever para o atendimento. */
  acao: 'tentar' | 'ver-conexao' | 'contato' | null;
}

const fonteParada = (f: ConversationMessage['stale_sources'][number]) => {
  const nome = f.platform ? `${f.platform} · ${f.name}` : f.name;
  return f.last_read ? `${nome}: última leitura em ${f.last_read}` : `${nome}: ainda não foi lida`;
};

/** O aviso que o código escreveu no lugar da resposta. Aviso que a tela não conhece é tratado como "fora do ar". */
export function avisoDoSistema(m: Pick<ConversationMessage, 'notice' | 'retry_at' | 'budget_window' | 'stale_sources'>): AvisoDoSistema {
  switch (m.notice) {
    case 'pessoa':
      return {
        icone: 'users',
        selo: 'Sem IA',
        titulo: 'Falar com uma pessoa da Liame',
        paragrafos: ['A LIA é uma assistente de IA e não passa a conversa para ninguém. Para falar com o atendimento da Liame, escreva para:'],
        acao: 'contato',
      };
    case 'politico':
      return {
        icone: 'shield',
        selo: 'Recusado por regra',
        titulo: 'A Liame não faz conteúdo político ou eleitoral',
        paragrafos: ['A regra vale para todas as empresas. A LIA não recebeu esta mensagem.'],
        acao: null,
      };
    case 'desligada':
      return {
        icone: 'info',
        selo: 'Sem IA',
        titulo: 'A LIA está desligada nesta empresa',
        paragrafos: ['As telas, os avisos, o Explicar e a revisão da semana seguem funcionando, com os resumos montados pelo sistema, por regra. Quem liga a LIA é a Liame, a pedido do dono da empresa.'],
        acao: 'contato',
      };
    case 'pausada':
      return {
        icone: 'pause',
        selo: 'Sem IA',
        titulo: 'A LIA está parada agora',
        paragrafos: ['A IA desta empresa foi parada. A sua mensagem ficou guardada, e as telas, os avisos e o Explicar, com o resumo do sistema, seguem funcionando.'],
        acao: 'tentar',
      };
    case 'dado_velho': {
      const fontes = m.stale_sources.map(fonteParada);
      return {
        icone: 'clock',
        selo: 'Sem IA',
        titulo: 'Com dado velho a LIA não analisa',
        paragrafos: [`${fontes.length ? `${fontes.join('; ')}.` : 'Alguma fonte não está em dia.'} Para não explicar com número desatualizado, a resposta não foi mostrada.`],
        acao: 'ver-conexao',
      };
    }
    case 'recusada':
      return {
        icone: 'shield',
        selo: 'Sem IA',
        titulo: 'A resposta foi retirada na conferência',
        paragrafos: ['A LIA ia citar um número que não está nos dados que ela leu, ou escrever algo que as regras não deixam aparecer. O texto não é mostrado.'],
        acao: 'tentar',
      };
    case 'limite_pessoa':
      return {
        icone: 'clock',
        selo: 'Sem IA',
        titulo: 'Você chegou ao limite de mensagens por hora',
        paragrafos: [`${m.retry_at ? `A LIA volta a responder às ${horaDe(m.retry_at)}.` : 'A LIA volta a responder daqui a pouco.'} As telas e os avisos seguem funcionando.`],
        acao: null,
      };
    case 'teto':
      return {
        icone: 'clock',
        selo: 'Sem IA',
        titulo: m.budget_window === 'mes' ? 'O limite de uso de IA do mês foi atingido' : 'O limite de uso de IA de hoje foi atingido',
        paragrafos: [`A LIA volta a responder ${m.budget_window === 'mes' ? 'no mês que vem' : 'amanhã'}. As telas, os avisos e o Explicar, com o resumo do sistema, seguem funcionando.`],
        acao: null,
      };
    default:
      return {
        icone: 'alert-circle',
        selo: 'Sem IA',
        titulo: 'A LIA não respondeu agora',
        paragrafos: ['A sua mensagem ficou guardada. As telas, os avisos e o Explicar seguem funcionando.'],
        acao: 'tentar',
      };
  }
}

/** "O atendimento responde em até 1 dia útil, de segunda a sexta-feira, das 9h às 18h (horário de Brasília)." */
export function prazoDoAtendimento(c: SupportContact): string {
  return `O atendimento responde ${c.response_time}, ${c.hours}.`;
}

// ------------------------------------------------------------------ a faixa acima do campo

export interface FaixaDaConversa {
  chave: 'limite-conversa' | 'limite-pessoa' | 'teto' | 'economico';
  /** Só informa (as respostas mais curtas); as outras são de limite. */
  neutro: boolean;
  titulo: string;
  texto: string;
  /** A faixa oferece começar uma conversa nova. */
  novaConversa: boolean;
  /** Com ela, o campo de mensagem sai. */
  bloqueia: boolean;
}

const mesmoDia = (iso: string, agora: Date) => diasAte(iso, agora) === 0;
const mesmoMes = (iso: string, agora: Date) => {
  const d = new Date(iso);
  return d.getFullYear() === agora.getFullYear() && d.getMonth() === agora.getMonth();
};

/** O limite que vale agora, pelo estado da conversa e pelo último aviso. Nula quando a conversa segue normal. */
export function faixaDa(conversa: Pick<ConversationSummary, 'lia_answers' | 'max_lia_answers'> | null, mensagens: ConversationMessage[], agora: Date): FaixaDaConversa | null {
  if (conversa && conversa.lia_answers >= conversa.max_lia_answers) {
    return {
      chave: 'limite-conversa',
      neutro: false,
      titulo: 'Esta conversa chegou ao tamanho máximo',
      texto: 'Ela continua guardada em Suas conversas. Para seguir, comece uma nova.',
      novaConversa: true,
      bloqueia: true,
    };
  }
  const ultima = mensagens[mensagens.length - 1];
  if (ultima?.role === 'sistema' && ultima.notice === 'limite_pessoa' && ultima.retry_at && new Date(ultima.retry_at) > agora) {
    const a = avisoDoSistema(ultima);
    return { chave: 'limite-pessoa', neutro: false, titulo: a.titulo, texto: a.paragrafos[0]!, novaConversa: false, bloqueia: true };
  }
  if (ultima?.role === 'sistema' && ultima.notice === 'teto' && (ultima.budget_window === 'mes' ? mesmoMes(ultima.created_at, agora) : mesmoDia(ultima.created_at, agora))) {
    const a = avisoDoSistema(ultima);
    return { chave: 'teto', neutro: false, titulo: a.titulo, texto: a.paragrafos[0]!, novaConversa: false, bloqueia: true };
  }
  const daLia = [...mensagens].reverse().find((m) => m.role === 'lia');
  if (daLia?.economy && mesmoDia(daLia.created_at, agora)) {
    return {
      chave: 'economico',
      neutro: true,
      titulo: 'Hoje as respostas estão mais curtas',
      texto: 'O uso de IA da empresa está perto do limite. A LIA segue respondendo, com textos mais curtos.',
      novaConversa: false,
      bloqueia: false,
    };
  }
  return null;
}

// ------------------------------------------------------------------ cartões: o que a LIA registrou

export interface Cartao {
  icone: NomeIcone;
  titulo: string;
  selo: { classe: string; rotulo: string; ponto: boolean };
  linhas: Array<[string, string]>;
  nota: string;
}

const DIAS_DA_SEMANA = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

/** "sexta-feira, 02/10" de "2026-10-02" (dia do calendário, sem fuso). */
export function diaPorExtenso(dia: string): string {
  const [a, m, d] = dia.split('-').map(Number);
  const semana = DIAS_DA_SEMANA[new Date(Date.UTC(a!, m! - 1, d!)).getUTCDay()]!;
  return `${semana}, ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`;
}

const TIPO_DE_DEMANDA: Record<string, string> = { promocao: 'Promoção', plano: 'Plano', pauta: 'Pauta', analise: 'Análise', outro: 'Pedido' };

/** O cartão da demanda que a LIA registrou. */
export function cartaoDaDemanda(d: DemandResponse, euId: string, agora: Date): Cartao {
  const cancelada = d.status === 'cancelada';
  const selo =
    d.status === 'aberta'
      ? { classe: 'st st--info', rotulo: 'Aberta', ponto: true }
      : d.status === 'em_andamento'
        ? { classe: 'st st--aguardando', rotulo: 'Em andamento', ponto: true }
        : d.status === 'entregue'
          ? { classe: 'st st--concluido', rotulo: 'Entregue', ponto: false }
          : { classe: 'st st--espera', rotulo: 'Cancelada', ponto: false };
  const quem = d.requested_by ? (d.requested_by.id === euId ? 'você' : d.requested_by.name) : 'uma pessoa da empresa';
  const linhas: Array<[string, string]> = [
    ['Pedido', `${TIPO_DE_DEMANDA[d.kind] ?? 'Pedido'}: ${d.title}`],
    ['Quem cuida', `${d.assignee.name} (assistente de IA)`],
    ['Pedido por', `${quem}, ${quandoComHora(d.created_at, agora)}`],
  ];
  if (!cancelada) {
    if (d.due_on) linhas.push(['Para quando', diaPorExtenso(d.due_on)]);
    linhas.push(['Próximo passo', d.status === 'entregue' ? 'o plano está em Aprovações, para você decidir' : 'o plano chega em Aprovações, para você decidir']);
  }
  return {
    icone: 'file',
    titulo: cancelada ? 'Demanda cancelada' : d.status === 'entregue' ? 'Demanda entregue' : 'Demanda aberta',
    selo,
    linhas,
    nota: cancelada ? 'Nada foi feito. Se precisar, é só pedir de novo.' : 'Nada vai ao ar sem a sua aprovação.',
  };
}

/** A situação do pedido de cupom, do jeito que o cartão mostra. */
export function situacaoDaProposta(p: CouponRequest): { classe: string; rotulo: string; ponto: boolean; fim: boolean; nota: string } {
  switch (p.status) {
    case 'aguardando_aprovacao':
      return { classe: 'st st--aguardando', rotulo: 'Esperando aprovação', ponto: true, fim: false, nota: 'A LIA não aprova. Quem decide é uma pessoa com permissão, na tela Aprovações.' };
    case 'aprovada':
    case 'executando':
      return { classe: 'st st--info', rotulo: 'Aprovada: criando no Regem', ponto: true, fim: false, nota: 'O cupom aparece em Links e cupons quando o Regem confirmar.' };
    case 'executada':
      return { classe: 'st st--concluido', rotulo: 'Cupom criado', ponto: false, fim: true, nota: 'O cupom está em Links e cupons.' };
    case 'recusada':
      return { classe: 'st st--espera', rotulo: 'Recusada', ponto: false, fim: true, nota: 'Nada foi criado no Regem.' };
    case 'expirada':
      return { classe: 'st st--espera', rotulo: 'Expirou', ponto: false, fim: true, nota: 'Ninguém aprovou a tempo. Nada foi criado no Regem.' };
    case 'falhou':
      return { classe: 'st st--perigo', rotulo: 'Não deu certo', ponto: false, fim: true, nota: 'O Regem não criou o cupom. Veja o motivo em Links e cupons.' };
    default:
      return { classe: 'st st--espera', rotulo: 'Cancelada', ponto: false, fim: true, nota: 'Nada foi criado no Regem.' };
  }
}
