import type { RiskLevel } from '@liame/contracts';
import { z } from 'zod';
import { TOOLS } from '../../actions/tools.js';
import { canonicalJson, sha256 } from '../../audit/audit.js';
import { PROPOR_CUPOM } from '../conversa/cupom.defs.js';
import { ABRIR_DEMANDA } from '../conversa/demanda.defs.js';
import { LIA, PROMPT_CONVERSA_LIA } from '../conversa/prompt.js';
import { CRIATIVO, PROMPT_CRIATIVO_TEXTO } from '../criativo/prompt.js';
import { ESTRATEGISTA, PROMPT_ESTRATEGISTA } from '../estrategista/prompt.js';
import { ANALISTA, PROMPT_EXPLICAR_RESULTADOS } from '../explicar/prompt.js';
import { PESQUISADOR, PROMPT_PESQUISADOR } from '../pesquisador/prompt.js';
import { PROMPT_REVISOR } from '../revisor/prompt.js';
import { LEITURAS } from './leituras.defs.js';

// Registros da IA (arquitetura §3, `ai-architecture.md` §1 e §8): ferramenta, prompt e funcionário são
// definições com versão, escritas aqui e revisadas em PR. Mudou a descrição, os parâmetros ou o texto?
// Sobe a versão: o teste do registro (`ia-registro.lock.json`) reprova mudança sem versão nova, e o
// worker grava cada versão que foi ao ar em `tool_registry`, `prompt_version` e `agent_definition`.

export interface FerramentaDef {
  name: string;
  version: number;
  description: string;
  /** R0 leitura · R1 escrita reversível · R2 irreversível ou mensagem a clientes · R3 financeira. */
  risk: RiskLevel;
  /** Permissão que a pessoa precisa ter para a ferramenta ser oferecida; nula nas de escrita (quem decide é o Action Service). */
  permission: string | null;
  owner: string;
  input: z.ZodType;
}

export interface PromptDef {
  key: string;
  version: number;
  /** Tarefa que o prompt atende: a mesma da rota de modelo. */
  task: string;
  content: string;
}

export interface FuncionarioDef {
  key: string;
  version: number;
  name: string;
  cargo: string;
  responsabilidades: string[];
  /** Subconjunto do registro de ferramentas (pelo nome). */
  ferramentas: string[];
  /** O que ele faz: tarefa (rota de modelo) e o prompt de cada uma. */
  tarefas: Array<{ task: string; prompt: string }>;
  /** Vale para a empresa que não tem linha em `agent_activation`. */
  ativoPorPadrao: boolean;
}

/**
 * Os prompts e os funcionários entram com o primeiro uso real de cada um. Estar aqui não põe ninguém para
 * trabalhar: sem rota de modelo ativa para a tarefa (publicada só depois do eval, I3), a tela usa o texto sem IA.
 * O revisor de IA do Compliance tem prompt e não é funcionário do registro: o Compliance trabalha por regra e não
 * desliga; o revisor é o segundo olhar dele, para a empresa com a flag `revisor` (I9). O Criativo (A4, X6) está no
 * registro e ainda não trabalha para ninguém: falta a rota de modelo da tarefa dele e o serviço que o chama.
 */
export const PROMPTS: PromptDef[] = [PROMPT_EXPLICAR_RESULTADOS, PROMPT_CONVERSA_LIA, PROMPT_ESTRATEGISTA, PROMPT_PESQUISADOR, PROMPT_REVISOR, PROMPT_CRIATIVO_TEXTO];
export const FUNCIONARIOS: FuncionarioDef[] = [ANALISTA, LIA, ESTRATEGISTA, PESQUISADOR, CRIATIVO];

/**
 * Todas as ferramentas: as de escrita em plataforma (Action Service), as de leitura dos funcionários de IA e as
 * escritas da conversa (abrir uma demanda, I10; propor um cupom, que vira pedido no Action Service, I10b), que a
 * conversa oferece pela permissão da pessoa.
 */
export function ferramentas(): FerramentaDef[] {
  const escrita = Object.values(TOOLS).map((t): FerramentaDef => ({ name: t.name, version: t.version, description: t.description, risk: t.risk, permission: null, owner: t.owner, input: t.params }));
  return [...escrita, ...LEITURAS, ABRIR_DEMANDA, PROPOR_CUPOM];
}

export interface Registro {
  ferramentas: FerramentaDef[];
  prompts: PromptDef[];
  funcionarios: FuncionarioDef[];
}

export function registroAtual(): Registro {
  return { ferramentas: ferramentas(), prompts: PROMPTS, funcionarios: FUNCIONARIOS };
}

/** O formato dos parâmetros como o modelo e o MCP o recebem (JSON Schema); a entrada é a que o código valida. */
export function schemaDaFerramenta(f: FerramentaDef): Record<string, unknown> {
  return z.toJSONSchema(f.input, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
}

// O hash é do conteúdo, sem a versão: conteúdo diferente com a mesma versão é o que o registro recusa.
export const hashDaFerramenta = (f: FerramentaDef): string =>
  sha256(canonicalJson({ description: f.description, risk: f.risk, permission: f.permission, owner: f.owner, input: schemaDaFerramenta(f) }));
export const hashDoPrompt = (p: PromptDef): string => sha256(canonicalJson({ task: p.task, content: p.content }));
export const conteudoDoFuncionario = (f: FuncionarioDef): Record<string, unknown> => ({
  cargo: f.cargo,
  responsabilidades: f.responsabilidades,
  ferramentas: f.ferramentas,
  tarefas: f.tarefas,
  ativo_por_padrao: f.ativoPorPadrao,
});
export const hashDoFuncionario = (f: FuncionarioDef): string => sha256(canonicalJson({ name: f.name, ...conteudoDoFuncionario(f) }));

export interface Trava {
  ferramentas: Record<string, { version: number; hash: string }>;
  prompts: Record<string, { version: number; hash: string }>;
  funcionarios: Record<string, { version: number; hash: string }>;
}

const ordenado = <T>(pares: Array<[string, T]>): Record<string, T> => Object.fromEntries(pares.sort(([a], [b]) => a.localeCompare(b)));

/** O que o arquivo `ia-registro.lock.json` precisa dizer para este código. */
export function travaDe(r: Registro): Trava {
  return {
    ferramentas: ordenado(r.ferramentas.map((f) => [f.name, { version: f.version, hash: hashDaFerramenta(f) }])),
    prompts: ordenado(r.prompts.map((p) => [p.key, { version: p.version, hash: hashDoPrompt(p) }])),
    funcionarios: ordenado(r.funcionarios.map((f) => [f.key, { version: f.version, hash: hashDoFuncionario(f) }])),
  };
}

/**
 * O que está errado entre o código e a trava. Conteúdo mudou com a mesma versão: sobe a versão. Versão
 * nova ou item novo: a trava precisa ser atualizada no mesmo PR (`pnpm --filter @liame/server ia:lock`).
 */
export function conferirTrava(atual: Trava, gravada: Trava): string[] {
  const problemas: string[] = [];
  for (const grupo of ['ferramentas', 'prompts', 'funcionarios'] as const) {
    for (const [nome, a] of Object.entries(atual[grupo])) {
      const g = gravada[grupo][nome];
      if (!g) problemas.push(`${grupo}.${nome}: novo, falta na trava`);
      else if (a.version === g.version && a.hash !== g.hash) problemas.push(`${grupo}.${nome}: o conteúdo mudou sem subir a versão (segue ${a.version})`);
      else if (a.version < g.version) problemas.push(`${grupo}.${nome}: a versão voltou de ${g.version} para ${a.version}`);
      else if (a.version > g.version) problemas.push(`${grupo}.${nome}: versão ${a.version} no código, ${g.version} na trava`);
    }
    for (const nome of Object.keys(gravada[grupo])) {
      if (!atual[grupo][nome]) problemas.push(`${grupo}.${nome}: está na trava e saiu do código`);
    }
  }
  return problemas;
}

/** Nomes repetidos e referências a ferramenta, prompt ou tarefa que não existem. */
export function conferirRegistro(r: Registro): string[] {
  const problemas: string[] = [];
  const repetidos = (nomes: string[]) => nomes.filter((n, i) => nomes.indexOf(n) !== i);
  for (const n of repetidos(r.ferramentas.map((f) => f.name))) problemas.push(`ferramenta repetida: ${n}`);
  for (const n of repetidos(r.prompts.map((p) => p.key))) problemas.push(`prompt repetido: ${n}`);
  for (const n of repetidos(r.funcionarios.map((f) => f.key))) problemas.push(`funcionário repetido: ${n}`);
  const nomes = new Set(r.ferramentas.map((f) => f.name));
  const prompts = new Map(r.prompts.map((p) => [p.key, p]));
  for (const f of r.ferramentas) {
    if (f.risk === 'R0' && !f.permission) problemas.push(`ferramenta ${f.name}: leitura sem permissão declarada`);
  }
  for (const f of r.funcionarios) {
    for (const t of f.ferramentas) if (!nomes.has(t)) problemas.push(`funcionário ${f.key}: ferramenta desconhecida ${t}`);
    for (const t of f.tarefas) {
      const p = prompts.get(t.prompt);
      if (!p) problemas.push(`funcionário ${f.key}: prompt desconhecido ${t.prompt}`);
      else if (p.task !== t.task) problemas.push(`funcionário ${f.key}: o prompt ${t.prompt} é da tarefa ${p.task}, não de ${t.task}`);
    }
  }
  return problemas;
}
