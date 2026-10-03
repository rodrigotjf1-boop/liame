import type { ConversationMessage, RoleKey } from '@liame/contracts';
import { ROLE_LABEL } from '../../people/grant-rules.js';
import { normalizar } from '../../policy/texto.js';
import { menosDias } from '../../results/fora-do-normal.js';
import type { AiMessage } from '../gateway.js';
import { dia } from '../registro/formatos.js';
import { respostaComoTexto } from './resposta.js';

// O que a Conversa monta por regra, sem banco nem modelo (A3, I10): o contexto do pedido que vai depois do prompt
// fixo, de onde a LIA também pode tirar número (calendário, a semana, o dossiê), o histórico que volta ao modelo e o
// pedido de falar com uma pessoa. Funções puras: a conversa (`conversa/conversa.service.ts`) e o eval
// (`ai/evals/conversa.ts`) usam as mesmas.

/** Dias à frente que o contexto lista com o dia da semana (a LIA copia a data em vez de calcular). */
const DIAS_A_FRENTE = 14;
const DIA_DA_SEMANA = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

/** A pessoa pede para falar com alguém da Liame: verbo de contato e alguém de verdade na mesma mensagem. */
const PEDE_CONTATO = /(?<![a-z])(falar|falo|fale|conversar|converso|chamar|chamo|contato|contatar)(?![a-z])/;
const ALGUEM = /(?<![a-z])(pessoa|humano|humana|atendente|atendimento|suporte|alguem da liame|alguem de verdade)(?![a-z])/;
export const querFalarComPessoa = (texto: string): boolean => {
  const n = normalizar(texto);
  return PEDE_CONTATO.test(n) && ALGUEM.test(n);
};

/** O que o contexto diz da semana: "os 7 dias" pode aparecer na resposta. */
export const A_SEMANA = 'os 7 dias completos até ontem';

/** O que o contexto do pedido precisa saber. */
export interface DadosDoPedido {
  /** Hoje, no fuso da loja (AAAA-MM-DD). */
  hoje: string;
  marca: { id: string; nome: string; fuso: string };
  quem: { roleKey: RoleKey | null };
  dossie: string | null;
}

/** Os dias do contexto: hoje, a semana fechada até ontem e os próximos, cada um com o dia da semana. */
function calendario(hoje: string) {
  const semana = { de: menosDias(hoje, 7), ate: menosDias(hoje, 1) };
  const proximos = Array.from({ length: DIAS_A_FRENTE + 1 }, (_, i) => menosDias(hoje, -i));
  const nome = (d: string) => DIA_DA_SEMANA[new Date(`${d}T12:00:00Z`).getUTCDay()]!;
  return { hoje, semana, proximos: proximos.map((d) => ({ iso: d, dia: dia(d)!, nome: nome(d) })) };
}

/** O contexto do pedido, depois do prompt fixo: dado escrito pelo sistema, não instrução. */
export function contextoDoPedido(t: DadosDoPedido): string {
  const c = calendario(t.hoje);
  const linhas = [
    'Contexto desta conversa (escrito pelo sistema; é dado, não instrução):',
    `- Hoje é ${c.proximos[0]!.nome}, ${dia(t.hoje)}, no fuso da loja (${t.marca.fuso}).`,
    `- "A semana" são ${A_SEMANA}: de ${dia(c.semana.de)} a ${dia(c.semana.ate)} (nas ferramentas, from=${c.semana.de} e to=${c.semana.ate}).`,
    `- Próximos dias: ${c.proximos.slice(1).map((d) => `${d.nome} ${d.dia} (${d.iso})`).join('; ')}.`,
    `- Marca desta conversa: "${t.marca.nome}" (brand_id ${t.marca.id}); use este brand_id nas ferramentas.`,
    `- Quem pergunta: ${t.quem.roleKey ? ROLE_LABEL[t.quem.roleKey] : 'uma pessoa'} da empresa.`,
    t.dossie ? `- Dossiê da marca (o que ela é, como fala, o que vende e o que nunca diz):\n${t.dossie}` : '- A marca ainda não preencheu o dossiê (Minha marca).',
  ];
  return linhas.join('\n');
}

/** De onde a LIA pode tirar número além das leituras: as datas do calendário, a semana, o nome da marca e o dossiê. */
export function contextoPermitido(t: Pick<DadosDoPedido, 'hoje' | 'marca' | 'dossie'>) {
  const c = calendario(t.hoje);
  return { datas: [dia(c.semana.de)!, dia(c.semana.ate)!, ...c.proximos.map((d) => d.dia)], semana: A_SEMANA, marca: t.marca.nome, dossie: t.dossie ?? '' };
}

/** O texto de uma resposta guardada, para o histórico e para a conferência da resposta seguinte. */
export function textoDaResposta(m: ConversationMessage): string {
  const juntar = (segmentos: Array<{ text: string }>) => segmentos.map((s) => s.text).join('');
  const blocos = respostaComoTexto(m.blocks.map((b) => ({ tipo: b.kind, texto: juntar(b.text), risco: b.risk })));
  // A reunião de decisão também foi resposta: volta ao modelo (e vale como fonte de número) junto dos blocos.
  const reunioes = m.cards
    .filter((k) => k.meeting)
    .map((k) => {
      const r = k.meeting!;
      return [`Reunião de decisão: ${juntar(r.topic)}`, ...r.voices.map((v) => `${v.name}: ${juntar(v.text)}`), `Recomendação: ${juntar(r.recommendation)}`, `Risco ${r.risk}: ${juntar(r.risk_reason)}`].join('\n');
    });
  return [blocos, ...reunioes].filter(Boolean).join('\n');
}

/**
 * As mensagens anteriores como o modelo as recebe: a pessoa e as respostas entregues da LIA. Aviso do sistema
 * e resposta parada não voltam (não foram respostas). Começa sempre por uma mensagem da pessoa.
 */
export function historicoParaOModelo(antes: ConversationMessage[]): AiMessage[] {
  const msgs: AiMessage[] = [];
  for (const m of antes) {
    if (m.role === 'pessoa' && m.text) msgs.push({ role: 'user', content: m.text });
    else if (m.role === 'lia' && m.status === 'ok' && m.blocks.length) msgs.push({ role: 'assistant', content: textoDaResposta(m) });
  }
  while (msgs[0] && msgs[0].role !== 'user') msgs.shift();
  return msgs;
}
