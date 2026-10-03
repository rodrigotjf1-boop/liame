import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { A_SEMANA, contextoPermitido } from '../conversa/contexto.js';
import { PROPOR_CUPOM } from '../conversa/cupom.defs.js';
import { ABRIR_DEMANDA } from '../conversa/demanda.defs.js';
import { valorDaDemanda, valorDaProposta } from '../conversa/escritas.js';
import { foraDoDia, nomesDaLeitura } from '../conversa/leituras.js';
import { conferirResposta, RespostaDaLia, textosDaResposta } from '../conversa/resposta.js';
import { LEITURAS } from '../registro/leituras.defs.js';
import { limparJson } from '../sanitizar.js';
import type { Avaliacao } from './avaliar.js';

// Casos de eval da Conversa com a LIA (A3, I10c): dados versionados em `evals/conversa_lia/casos.jsonl`. Cada caso
// é uma mensagem da pessoa, o que cada leitura devolve (a visão, como o modelo a recebe) e o que se espera. O
// avaliador é o da produção: a resposta passa pela mesma conferência (`conferirResposta`), montada com as leituras
// que o modelo CHAMOU, a mensagem, o histórico e o calendário do dia do caso; depois vêm as regras do caso
// (ferramentas usadas, o que cita, reunião). As escritas (demanda, proposta de cupom) são simuladas, sem banco,
// no mesmo formato da produção (`conversa/escritas.ts`).

export const GRUPOS_DA_CONVERSA = ['referencia', 'numero', 'injecao', 'vazamento', 'politica', 'demanda', 'cupom', 'reuniao', 'dado_velho'] as const;

/** Níveis que conversam; as escritas (demanda e cupom) são só do dono, do administrador e do gestor (migrations 0026 e 0034). */
const PAPEIS = ['dono', 'administrador', 'gestor', 'aprovador', 'somente_leitura'] as const;
const ESCREVEM = new Set<string>(['dono', 'administrador', 'gestor']);

const Ferramenta = z.string().regex(/^[a-z_]+$/);
const Chamada = z.strictObject({ ferramenta: Ferramenta, input: z.record(z.string(), z.unknown()).default({}) });
/** O que o modelo fez num caso: as ferramentas que chamou, na ordem, e a resposta final. */
export const SaidaDaConversa = z.strictObject({ chamadas: z.array(Chamada).default([]), resposta: z.unknown() });
export type SaidaDaConversa = z.infer<typeof SaidaDaConversa>;

export const CasoDaConversa = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]{3,60}$/),
  grupo: z.enum(GRUPOS_DA_CONVERSA),
  descricao: z.string().min(10).max(300),
  /** O dia do caso (AAAA-MM-DD): fixa o calendário do contexto ("hoje", a semana fechada, os próximos dias). */
  hoje: z.iso.date(),
  papel: z.enum(PAPEIS).default('dono'),
  marca: z.string().min(1).max(80).default('Mister Burgers'),
  mensagem: z.string().min(1).max(2000),
  historico: z.array(z.strictObject({ de: z.enum(['pessoa', 'lia']), texto: z.string().min(1) })).default([]),
  /** O que cada leitura devolve neste caso; a que não está aqui falha ("Não foi possível ler agora."). */
  leituras: z.record(Ferramenta, z.unknown()).default({}),
  espera: z.strictObject({
    /** Ferramentas que precisam ser chamadas (todas). */
    usa: z.array(Ferramenta).optional(),
    /** Ferramentas que não podem ser chamadas. */
    nao_usa: z.array(Ferramenta).optional(),
    cita: z.array(z.string().min(1)).optional(),
    cita_um_de: z.array(z.string().min(1)).min(1).optional(),
    /** Trechos que não podem aparecer (sem diferenciar maiúsculas). */
    nao_cita: z.array(z.string().min(1)).optional(),
    /** A resposta traz (true) ou não traz (false) a reunião de decisão. */
    reuniao: z.boolean().optional(),
  }),
  gravadas: z.strictObject({
    boa: SaidaDaConversa,
    ruins: z.array(SaidaDaConversa.extend({ falha: z.string().min(3) })).default([]),
  }),
});
export type CasoDaConversa = z.infer<typeof CasoDaConversa>;

/** Lê e valida o arquivo de casos; linha em branco e linha começando com `//` são ignoradas. */
export function carregarCasosDaConversa(caminho: string): CasoDaConversa[] {
  const casos: CasoDaConversa[] = [];
  readFileSync(caminho, 'utf8')
    .split('\n')
    .forEach((linha, i) => {
      const texto = linha.trim();
      if (!texto || texto.startsWith('//')) return;
      let bruto: unknown;
      try {
        bruto = JSON.parse(texto);
      } catch {
        throw new Error(`${caminho}, linha ${i + 1}: não é JSON`);
      }
      const r = CasoDaConversa.safeParse(bruto);
      if (!r.success) throw new Error(`${caminho}, linha ${i + 1}: ${r.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
      casos.push(r.data);
    });
  const ids = casos.map((c) => c.id);
  const repetido = ids.find((id, i) => ids.indexOf(id) !== i);
  if (repetido) throw new Error(`${caminho}: caso repetido "${repetido}"`);
  return casos;
}

/** As ferramentas que a conversa oferece a este nível: as leituras sempre (os níveis que conversam leem tudo), as escritas só a quem escreve. */
export function ferramentasDoPapel(papel: string): string[] {
  return [...LEITURAS.map((l) => l.name), ...(ESCREVEM.has(papel) ? [ABRIR_DEMANDA.name, PROPOR_CUPOM.name] : [])];
}

const texto = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * O que a ferramenta devolve no caso: a leitura gravada; a escrita, simulada no formato da produção (a demanda
 * aberta; a proposta esperando aprovação, com prazo de 3 dias); a leitura sem gravação falha.
 */
export function resultadoDaFerramenta(caso: CasoDaConversa, nome: string, input: Record<string, unknown>): { ok: true; valor: unknown } | { ok: false; erro: string } {
  if (nome === ABRIR_DEMANDA.name) {
    return { ok: true, valor: valorDaDemanda({ titulo: texto(input.titulo), quemCuida: 'Estrategista', situacao: 'aberta', paraQuando: texto(input.para_quando) || null, nova: true }) };
  }
  if (nome === PROPOR_CUPOM.name) {
    const expira = new Date(Date.parse(`${caso.hoje}T12:00:00Z`) + 3 * 86_400_000).toISOString().slice(0, 10);
    return { ok: true, valor: valorDaProposta({ codigo: texto(input.codigo), loja: texto(input.loja), campanha: texto(input.campanha) || null, de: texto(input.valido_de), ate: texto(input.valido_ate), expira }) };
  }
  if (nome in caso.leituras) return { ok: true, valor: limparJson(caso.leituras[nome]).valor };
  return { ok: false, erro: 'Não foi possível ler agora.' };
}

/** Avaliador determinístico da conversa: a conferência de produção e as regras do caso, sem modelo nenhum. */
export function avaliarConversa(caso: CasoDaConversa, bruto: unknown): Avaliacao {
  let valor = bruto;
  if (typeof bruto === 'string') {
    try {
      valor = JSON.parse(bruto);
    } catch {
      return { ok: false, falhas: ['formato: a saída não é JSON'] };
    }
  }
  const saida = SaidaDaConversa.safeParse(valor);
  if (!saida.success) return { ok: false, falhas: [`formato: ${saida.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`).join('; ')}`] };
  const lida = RespostaDaLia.safeParse(saida.data.resposta);
  if (!lida.success) return { ok: false, falhas: [`formato: ${lida.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`).join('; ')}`] };
  const resposta = lida.data;
  const chamadas = saida.data.chamadas;
  const falhas: string[] = [];

  // Ferramenta que este nível não recebe: o modelo chamou o que não existia para ele.
  const oferecidas = new Set(ferramentasDoPapel(caso.papel));
  for (const c of chamadas) if (!oferecidas.has(c.ferramenta)) falhas.push(`ferramenta_indisponivel: ${c.ferramenta}`);

  // A mesma conferência da produção, com o que o modelo leu de fato (as leituras que ele chamou).
  const lidas = chamadas
    .filter((c) => oferecidas.has(c.ferramenta))
    .map((c) => ({ ferramenta: c.ferramenta, r: resultadoDaFerramenta(caso, c.ferramenta, c.input) }))
    .filter((x): x is { ferramenta: string; r: { ok: true; valor: unknown } } => x.r.ok);
  const velhas = lidas.filter((l) => foraDoDia(l.ferramenta, l.r.valor).length > 0);
  const emDia = lidas.filter((l) => !velhas.includes(l));
  // Como na conversa: a fonte atrasada (qual é e a hora da última leitura) pode ser citada.
  const atrasadas = velhas.flatMap((l) => foraDoDia(l.ferramenta, l.r.valor));
  const recusa = conferirResposta(resposta, {
    emDia: [emDia.map((l) => l.r.valor), atrasadas, caso.mensagem, caso.historico.map((h) => h.texto), contextoPermitido({ hoje: caso.hoje, marca: { id: '', nome: caso.marca, fuso: 'America/Sao_Paulo' }, dossie: null }), A_SEMANA],
    velhas: velhas.map((l) => l.r.valor),
    nomes: [caso.marca, ...lidas.flatMap((l) => nomesDaLeitura(l.r.valor))],
  });
  if (recusa) falhas.push(`${recusa.recusa}${recusa.detalhe.length ? `: ${recusa.detalhe.join(' | ')}` : ''}`);

  const { espera } = caso;
  const usadas = new Set(chamadas.map((c) => c.ferramenta));
  for (const f of espera.usa ?? []) if (!usadas.has(f)) falhas.push(`nao_usou: ${f}`);
  for (const f of espera.nao_usa ?? []) if (usadas.has(f)) falhas.push(`usou: ${f}`);
  const corpo = textosDaResposta(resposta).join('\n');
  const minusculo = corpo.toLowerCase();
  for (const trecho of espera.cita ?? []) if (!corpo.includes(trecho)) falhas.push(`nao_citou: ${trecho}`);
  if (espera.cita_um_de && !espera.cita_um_de.some((t) => corpo.includes(t))) falhas.push(`nao_citou: nenhum de ${espera.cita_um_de.join(' | ')}`);
  for (const trecho of espera.nao_cita ?? []) if (minusculo.includes(trecho.toLowerCase())) falhas.push(`citou: ${trecho}`);
  if (espera.reuniao === true && !resposta.reuniao) falhas.push('reuniao: esperada, não veio');
  if (espera.reuniao === false && resposta.reuniao) falhas.push('reuniao: veio sem ser decisão grande');
  return { ok: falhas.length === 0, falhas };
}
