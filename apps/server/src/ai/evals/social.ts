import { readFileSync } from 'node:fs';
import { BrandDossierContent, SystemProof } from '@liame/contracts';
import { z } from 'zod';
import { concorrentesDoDossie, fatosDoDossie, proibidasDoDossie, textoDoDossie } from '../../marca/dossie.js';
import { normalizar } from '../../policy/texto.js';
import { baseDoPedidoDoSocial, type PedidoDoSocial, sugestoesPedidas } from '../social/contexto.js';
import { type BaseDaSugestao, estiloDaSugestao, RespostaDoSocial, sugestoesDaResposta } from '../social/resposta.js';
import type { Avaliacao } from './avaliar.js';

// Casos de eval do Social media nas respostas às avaliações (A6, Z6; critério A6-12, o portão da função; D-A6-26 a
// D-A6-28): dados versionados em `evals/social_resposta/casos.jsonl`. Cada caso é uma avaliação como o funcionário a
// recebe (a marca com o dossiê, a nota, o dia e o texto, e o canal de contato quando há) e o que se espera. O contexto e
// a mensagem são montados pelo código de produção. O avaliador é o da produção (`sugestoesDaResposta`), mais estrito:
// em produção o tamanho acima do recomendado só avisa e a sugestão a mais é descartada; no eval, os dois reprovam,
// porque o funcionário precisa entregar o que o pedido pede.
//
// Os grupos `numero`, `injecao` e `vazamento` não aceitam falha nenhuma (`GRUPOS_SEM_FALHA`): número inventado, ordem
// escondida na avaliação obedecida, e a resposta que repete o nome ou o dado de alguém.

/** O grupo `outras` é o "Pedir outras" (a segunda rodada, parte 3b): as novas não repetem as que a pessoa já viu. */
export const GRUPOS_DO_SOCIAL = ['boa', 'so_nota', 'media', 'ruim', 'compensacao', 'numero', 'marca', 'politica', 'injecao', 'vazamento', 'outras'] as const;

const Rotulo = z.string().min(1);

export const CasoDoSocial = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]{3,60}$/),
  grupo: z.enum(GRUPOS_DO_SOCIAL),
  descricao: z.string().min(10).max(300),
  marca: z.string().min(2).max(80),
  /** O dossiê da marca, no contrato de Minha marca: o texto que o modelo lê sai dele pelo código de produção. */
  dossie: BrandDossierContent,
  /** As provas que o sistema calcula (não ficam no dossiê). */
  provas: z.array(SystemProof).default([]),
  estrelas: z.int().min(1).max(5),
  /** O dia em que a avaliação foi feita, como a tela escreve. */
  feita_em: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/),
  /** O texto da avaliação; nulo quando ela é só a nota. */
  texto: z.string().min(1).max(4000).nullable(),
  /** Como a resposta chama para conversar, de Minha marca; nulo sem o campo (o caso de hoje). */
  canal: z.string().min(3).max(80).nullable().default(null),
  /** No "Pedir outras" (o grupo `outras`): as sugestões que a pessoa já viu e quer trocar. Vazio na primeira rodada. */
  anteriores: z
    .array(z.strictObject({ enfoque: z.string().min(1).max(60), texto: z.string().min(1).max(600) }))
    .max(4)
    .default([]),
  espera: z.strictObject({
    /** Em cada sugestão, pelo menos um termo de cada lista, sem olhar acento nem maiúscula ("desculpa" ou "sentimos"). */
    cada_uma: z.array(z.array(Rotulo).min(1)).optional(),
    /** Trechos que nenhuma sugestão (nem o enfoque) pode trazer, sem olhar acento nem maiúscula. */
    nao_cita: z.array(Rotulo).optional(),
  }),
  gravadas: z.strictObject({
    boa: z.unknown(),
    ruins: z.array(z.strictObject({ resposta: z.unknown(), falha: z.string().min(3) })).default([]),
  }),
});
export type CasoDoSocial = z.infer<typeof CasoDoSocial>;

/** Lê e valida o arquivo de casos; linha em branco e linha começando com `//` são ignoradas. */
export function carregarCasosDoSocial(caminho: string): CasoDoSocial[] {
  const casos: CasoDoSocial[] = [];
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
      const r = CasoDoSocial.safeParse(bruto);
      if (!r.success) throw new Error(`${caminho}, linha ${i + 1}: ${r.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
      casos.push(r.data);
    });
  const ids = casos.map((c) => c.id);
  const repetido = ids.find((id, i) => ids.indexOf(id) !== i);
  if (repetido) throw new Error(`${caminho}: caso repetido "${repetido}"`);
  return casos;
}

/** O pedido do caso como a produção o monta: o texto do dossiê, a nota, o dia, o texto da avaliação, o canal e, no "Pedir outras", as anteriores. */
export function pedidoDoCasoDoSocial(c: CasoDoSocial): PedidoDoSocial {
  return {
    marca: c.marca,
    dossie: textoDoDossie(c.marca, c.dossie, c.provas),
    estrelas: c.estrelas,
    feitaEm: c.feita_em,
    texto: c.texto,
    canal: c.canal,
    anteriores: c.anteriores.map((a) => a.texto),
  };
}

/** Do que a conferência das sugestões parte, no caso: a avaliação, os fatos do dossiê, o que a marca não diz e os concorrentes dela. */
export function baseDoCasoDoSocial(c: CasoDoSocial): BaseDaSugestao {
  return baseDoPedidoDoSocial({ estrelas: c.estrelas, texto: c.texto }, { fatos: fatosDoDossie(c.marca, c.dossie, c.provas), proibidas: proibidasDoDossie(c.dossie), concorrentes: concorrentesDoDossie(c.dossie) });
}

/** Avaliador determinístico das sugestões: o schema, a quantidade, a conferência de produção (estrita) e as regras do caso. */
export function avaliarSugestoes(caso: CasoDoSocial, bruto: unknown): Avaliacao {
  let valor = bruto;
  if (typeof bruto === 'string') {
    try {
      valor = JSON.parse(bruto);
    } catch {
      return { ok: false, falhas: ['formato: a resposta não é JSON'] };
    }
  }
  const lida = RespostaDoSocial.safeParse(valor);
  if (!lida.success) return { ok: false, falhas: [`formato: ${lida.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`).join('; ')}`] };
  const r = lida.data;
  const pedidas = sugestoesPedidas({ texto: caso.texto });
  const falhas: string[] = [];
  if (r.sugestoes.length !== pedidas) falhas.push(`quantidade: vieram ${r.sugestoes.length}, o pedido é de ${pedidas}`);
  const anteriores = caso.anteriores.map((a) => a.texto);
  const { sugestoes, descartes } = sugestoesDaResposta(r, baseDoCasoDoSocial(caso), pedidas, textoDoDossie(caso.marca, caso.dossie, caso.provas), anteriores);
  // A sugestão a mais já conta na quantidade; os outros descartes são a sugestão que não chegaria à conferência (no
  // "Pedir outras", a que repete uma das que a pessoa já viu também é descartada).
  for (const d of descartes) if (d !== 'sobra') falhas.push(`descartada_${d}: a sugestão não chegaria à conferência`);
  if (sugestoes.length === 2 && normalizar(sugestoes[0]!.enfoque) === normalizar(sugestoes[1]!.enfoque)) falhas.push(`enfoque_repetido: ${sugestoes[0]!.enfoque}`);
  // O "Pedir outras" pede outros enfoques: o enfoque de uma das que a pessoa já viu reprova.
  const enfoquesVistos = new Set(caso.anteriores.map((a) => normalizar(a.enfoque)));
  for (const s of sugestoes) if (enfoquesVistos.has(normalizar(s.enfoque))) falhas.push(`enfoque_anterior: ${s.enfoque}`);
  for (const s of sugestoes) {
    // A conferência de produção: no eval, qualquer achado reprova, inclusive o tamanho acima do recomendado.
    for (const item of s.conferencia.itens) {
      for (const a of item.achados) falhas.push(a.tipo === 'acima_do_recomendado' ? `tamanho: ${a.campo}: ${a.trecho} caracteres` : `${a.tipo}: ${a.campo}: ${a.trecho}`);
    }
    for (const sinal of estiloDaSugestao(s)) falhas.push(`estilo: ${sinal}`);
    const normal = normalizar(s.texto);
    for (const termos of caso.espera.cada_uma ?? []) if (!termos.some((t) => normal.includes(normalizar(t)))) falhas.push(`faltou: "${s.enfoque}" não traz ${termos.join(' nem ')}`);
  }
  for (const t of caso.espera.nao_cita ?? []) {
    const alvo = normalizar(t).trim();
    if (sugestoes.some((s) => normalizar(`${s.enfoque}\n${s.texto}`).includes(alvo))) falhas.push(`citou: ${t}`);
  }
  return { ok: falhas.length === 0, falhas };
}
