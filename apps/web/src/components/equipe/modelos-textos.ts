import type { TeamModelOption, TeamModelPurposeState, TeamModelsResponse } from '@liame/contracts';
import { custoNaTela, diaMesDe } from './textos';

// Os modelos de IA da empresa no Pro (mockups/prototipo-equipe.html, P7 aprovado em 03/10/2026; A3, I13; D-A3-12 e
// D-A3-25 a D-A3-28): os textos do bloco, puros, a partir de `/v1/team/models`.

/** O que chega de `/v1/team/models`, como a tela guarda. */
export type CargaDosModelos = { tipo: 'carregando' } | { tipo: 'ok'; dados: TeamModelsResponse } | { tipo: 'erro' };

const VELOCIDADE: Record<string, string> = { mais_rapido: 'mais rápido', rapido: 'rápido', medio: 'médio', mais_lento: 'mais lento' };

/** A velocidade em palavra; a que a tela ainda não conhece vira o texto do código, sem sublinhado. */
export function velocidadeDe(speed: string): string {
  return VELOCIDADE[speed] ?? speed.replaceAll('_', ' ');
}

/** A nota da rodada de confirmação, em porcentagem inteira: "0.9600" → "nota 96% no teste". */
export function notaDe(score: string): string {
  return `nota ${Math.round(Number(score) * 100)}% no teste`;
}

/** A chave de uma opção no formulário (o automático é `auto`). */
export const chaveDoModelo = (m: { provider: string; model: string }): string => `${m.provider}/${m.model}`;

type Cotacao = TeamModelsResponse['usd_brl'];

/** O custo estimado de uma opção nos 30 dias da janela; sem preço cadastrado, a tela não inventa número. */
export function estimativaDe(o: TeamModelOption, cotacao: Cotacao): string {
  return o.estimated_usd_micros === null ? 'sem estimativa de custo' : `${custoNaTela(o.estimated_usd_micros, cotacao)} estimados em 30 dias`;
}

/** A base da estimativa: as respostas entregues na janela, com as datas. */
export function baseDaEstimativa(p: TeamModelPurposeState, janela: TeamModelsResponse['window']): string {
  const n = p.answered;
  return `${n === 0 ? 'nenhuma resposta' : `${n.toLocaleString('pt-BR')} ${n === 1 ? 'resposta' : 'respostas'}`} de ${diaMesDe(janela.from)} a ${diaMesDe(janela.to)}`;
}

/** Quem usa a finalidade, por extenso: "LIA"; "Analista de dados, Estrategista e Compliance". */
export function quemUsaTexto(members: readonly string[]): string {
  if (members.length <= 1) return members[0] ?? '';
  return `${members.slice(0, -1).join(', ')} e ${members[members.length - 1]}`;
}

/** O resumo da lista ("Configuração da equipe"): quantas finalidades a empresa escolheu. */
export function resumoDosModelos(m: TeamModelsResponse): string {
  const escolhidas = m.purposes.filter((p) => p.choice?.offered).length;
  if (!escolhidas) return 'Automático em todas as finalidades';
  return `${escolhidas} de ${m.purposes.length} com modelo escolhido`;
}

/** O que vale agora numa finalidade: o automático, ou o escolhido por alguém (com quem e quando). */
export function atualDe(p: TeamModelPurposeState, cotacao: Cotacao): { titulo: string; nota: string } {
  const gasto = `${custoNaTela(p.spent_usd_micros, cotacao)} nos últimos 30 dias`;
  if (p.choice?.offered) {
    const o = p.options.find((x) => chaveDoModelo(x) === chaveDoModelo(p.choice!));
    const quem = p.choice.by?.name ? `, escolhido por ${p.choice.by.name}` : '';
    return { titulo: `${p.choice.label}${quem} em ${diaMesDe(p.choice.at.slice(0, 10))}`, nota: o ? `${estimativaDe(o, cotacao)} · ${velocidadeDe(o.speed)} · ${notaDe(o.eval_score)}` : gasto };
  }
  const nome = p.automatic ? p.automatic.label : 'o modelo de cada tarefa';
  return { titulo: `Automático (recomendado): ${nome}`, nota: gasto };
}

/** Quando o escolhido saiu do catálogo: as respostas voltaram ao automático, e a escolha fica guardada (D-A3-27). */
export function avisoDoRetirado(p: TeamModelPurposeState): string | null {
  if (!p.choice || p.choice.offered) return null;
  return `${p.choice.label} saiu do catálogo do Liame. As respostas voltaram ao automático; escolha de novo quando quiser.`;
}

/** As regras do catálogo, como o P7 escreve. */
export const REGRAS_DO_CATALOGO = [
  'Um modelo só entra numa finalidade depois de passar no teste de todas as tarefas dela, com contrato que proíbe treinar com os seus dados.',
  'Se o modelo escolhido falhar, a resposta sai pelo automático.',
  'O custo entra no teto de uso de IA da empresa.',
  'Sem chave própria: a conta com o fornecedor é do Liame. Só o Dono e o Administrador trocam o modelo, e a troca vale para todas as marcas.',
] as const;
