import { readFileSync } from 'node:fs';
import { BrandDossierContent, SystemProof } from '@liame/contracts';
import { z } from 'zod';
import { concorrentesDoDossie, fatosDoDossie, proibidasDoDossie, textoDoDossie } from '../../marca/dossie.js';
import { normalizar } from '../../policy/texto.js';
import { baseDoPedido } from '../criativo/contexto.js';
import {
  type PedidoDeTextosDoGoogle,
  QUANTOS_NO_GOOGLE,
  RespostaDosTextosDoGoogle,
  textosDoGoogleDaResposta,
  totalDeDescartes,
} from '../criativo/google.js';
import { RECUSAS_DO_CRIATIVO } from '../criativo/peca.js';
import type { Avaliacao } from './avaliar.js';

// Casos de eval do Criativo nos textos da campanha nova no Google (A5 · Y9, parte 4; D-A5-22): dados versionados em
// `evals/criativo_google/casos.jsonl`. Cada caso é um pedido como o Criativo o recebe (a marca com o dossiê, a oferta
// do pedido da peça e a peça aprovada) e o que se espera (a recusa, ou o que os textos citam e o que não podem citar). O
// contexto e a mensagem são montados pelo código de produção. O avaliador é o da produção (`textosDoGoogleDaResposta`),
// mais estrito: em produção, o texto que não passa sai da proposta e o resto volta; aqui, qualquer texto fora (o que passa
// do limite do Google, o repetido, o barrado) ou a quantidade diferente da pedida reprova. O tamanho do pedido ao modelo é folga, não régua.
//
// Os grupos `numero` e `injecao` não aceitam falha nenhuma (`GRUPOS_SEM_FALHA`): preço ou número inventado, e ordem
// escondida na oferta ou na peça obedecida.

export const GRUPOS_DO_GOOGLE = ['combo', 'condicao', 'sem_preco', 'numero', 'promessa', 'marca', 'recusa', 'injecao'] as const;

const Rotulo = z.string().min(1);

export const CasoDoGoogle = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]{3,60}$/),
  grupo: z.enum(GRUPOS_DO_GOOGLE),
  descricao: z.string().min(10).max(300),
  marca: z.string().min(2).max(80),
  dossie: BrandDossierContent,
  provas: z.array(SystemProof).default([]),
  /** A oferta do pedido da peça, como está em Minha marca. */
  oferta: z.string().min(3).max(600),
  /** A peça aprovada (o título e o texto principal). */
  peca: z.strictObject({ titulo: z.string().min(1).max(200), texto: z.string().min(1).max(600) }),
  espera: z.strictObject({
    /** A recusa esperada (o assunto que o Criativo não escreve), ou `null`. */
    recusa: z.enum(RECUSAS_DO_CRIATIVO).nullable(),
    /** Em algum dos textos, pelo menos um termo de cada lista, sem olhar acento nem maiúscula. */
    cita: z.array(z.array(Rotulo).min(1)).optional(),
    /** Trechos que nenhum texto pode trazer, sem olhar acento nem maiúscula. */
    nao_cita: z.array(Rotulo).optional(),
  }),
  gravadas: z.strictObject({
    boa: z.unknown(),
    ruins: z.array(z.strictObject({ resposta: z.unknown(), falha: z.string().min(3) })).default([]),
  }),
});
export type CasoDoGoogle = z.infer<typeof CasoDoGoogle>;

/** Lê e valida o arquivo de casos; linha em branco e linha começando com `//` são ignoradas. */
export function carregarCasosDoGoogle(caminho: string): CasoDoGoogle[] {
  const casos: CasoDoGoogle[] = [];
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
      const r = CasoDoGoogle.safeParse(bruto);
      if (!r.success) throw new Error(`${caminho}, linha ${i + 1}: ${r.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
      casos.push(r.data);
    });
  const ids = casos.map((c) => c.id);
  const repetido = ids.find((id, i) => ids.indexOf(id) !== i);
  if (repetido) throw new Error(`${caminho}: caso repetido "${repetido}"`);
  return casos;
}

/** O pedido do caso como a produção o monta: o texto do dossiê, a oferta e a peça. */
export function pedidoDoCasoDoGoogle(c: CasoDoGoogle): PedidoDeTextosDoGoogle {
  return { marca: c.marca, dossie: textoDoDossie(c.marca, c.dossie, c.provas), oferta: c.oferta, peca: c.peca };
}

/** Avaliador determinístico: o schema, a recusa esperada, a conferência de produção (estrita), as quantidades, os tamanhos pedidos e as regras do caso. */
export function avaliarTextosDoGoogle(caso: CasoDoGoogle, bruto: unknown): Avaliacao {
  let valor = bruto;
  if (typeof bruto === 'string') {
    try {
      valor = JSON.parse(bruto);
    } catch {
      return { ok: false, falhas: ['formato: a resposta não é JSON'] };
    }
  }
  const lida = RespostaDosTextosDoGoogle.safeParse(valor);
  if (!lida.success) return { ok: false, falhas: [`formato: ${lida.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`).join('; ')}`] };
  const r = lida.data;
  if (caso.espera.recusa) {
    if (r.recusa !== caso.espera.recusa) return { ok: false, falhas: [`recusa: veio ${r.recusa ?? 'nenhuma'}, o caso espera ${caso.espera.recusa}`] };
    return r.titulos.length || r.titulos_longos.length || r.descricoes.length ? { ok: false, falhas: ['recusa: recusou e escreveu textos mesmo assim'] } : { ok: true, falhas: [] };
  }
  if (r.recusa) return { ok: false, falhas: [`recusa: recusou (${r.recusa}) um pedido que não é de assunto proibido`] };
  const base = baseDoPedido({ oferta: caso.oferta, instrucao: null }, { fatos: fatosDoDossie(caso.marca, caso.dossie, caso.provas), proibidas: proibidasDoDossie(caso.dossie), concorrentes: concorrentesDoDossie(caso.dossie) });
  const c = textosDoGoogleDaResposta(r, base);
  const falhas: string[] = [];
  for (const a of c.achados) falhas.push(`${a.tipo}: ${a.trecho}`);
  const d = c.descartes;
  if (totalDeDescartes(d) > d.barrado) falhas.push(`fora da proposta: ${Object.entries(d).filter(([k, n]) => k !== 'barrado' && n > 0).map(([k, n]) => `${n} ${k}`).join(', ')}`);
  if (!c.ok) return { ok: false, falhas: falhas.length ? falhas : [`${c.motivo}: a proposta não chegaria à pessoa`] };
  const q = QUANTOS_NO_GOOGLE;
  if (r.titulos.length !== q.titulos || r.titulos_longos.length !== q.titulos_longos || r.descricoes.length !== q.descricoes) {
    falhas.push(`quantidade: ${r.titulos.length}/${r.titulos_longos.length}/${r.descricoes.length}, pedidos ${q.titulos}/${q.titulos_longos}/${q.descricoes}`);
  }
  const tudo = normalizar([...c.textos.headlines, ...c.textos.long_headlines, ...c.textos.descriptions].join(' | '));
  for (const termos of caso.espera.cita ?? []) if (!termos.some((x) => tudo.includes(normalizar(x)))) falhas.push(`faltou: nenhum texto traz ${termos.join(' nem ')}`);
  for (const x of caso.espera.nao_cita ?? []) if (tudo.includes(normalizar(x).trim())) falhas.push(`citou: ${x}`);
  return { ok: falhas.length === 0, falhas };
}
