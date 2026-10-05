import { readFileSync } from 'node:fs';
import { BrandDossierContent, SystemProof } from '@liame/contracts';
import { z } from 'zod';
import { concorrentesDoDossie, fatosDoDossie, proibidasDoDossie, textoDoDossie } from '../../marca/dossie.js';
import { normalizar } from '../../policy/texto.js';
import { baseDoPedido, INSTRUCAO_MAXIMA, type PedidoDePeca, referenciaSegura } from '../criativo/contexto.js';
import {
  type BaseDaPeca,
  BOTOES_DO_DESTINO,
  caracteres,
  DESTINOS_DA_PECA,
  estiloDaPeca,
  pecasDaResposta,
  RECUSAS_DO_CRIATIVO,
  RespostaDoCriativo,
  TAMANHO_RECOMENDADO,
  VARIACOES,
} from '../criativo/peca.js';
import type { Avaliacao } from './avaliar.js';

// Casos de eval do Criativo de texto (A4, X6; critério A4-11): dados versionados em `evals/criativo_texto/casos.jsonl`.
// Cada caso é um pedido de peça como o Criativo o recebe (a marca com o dossiê, o destino, a oferta de Minha marca, o
// anúncio de referência, a instrução de quem pediu e, no "pedir outra", a versão anterior da peça) e o que se espera. O contexto e a mensagem são montados pelo
// código de produção. O avaliador é o da produção (`pecasDaResposta`), mais estrito: em produção a peça barrada aparece
// com o motivo; no eval, o que barra reprova, porque o Criativo precisa entregar peça que sirva. O tamanho segue a
// produção até onde ela só avisa: reprova quando passa do maior tamanho que o guia da Meta recomenda (`TAMANHO_NO_EVAL`). Os casos chegam ao modelo: nenhum é barrado antes pela conferência do pedido (o teste
// confere), então quem precisa reconhecer o problema é o próprio Criativo.

export const GRUPOS_DO_CRIATIVO = ['referencia', 'numero', 'promessa', 'politica', 'categoria', 'marca', 'injecao'] as const;

/**
 * A régua do tamanho no eval: o maior tamanho que o guia da Meta recomenda para cada campo (40 no título, no Feed do
 * Instagram; 150 no texto, no Feed do Facebook). Entre o tamanho do aviso (27 e 125) e este, a peça tem só o aviso que
 * teria em produção; acima, o Criativo não está seguindo o tamanho que o prompt pede, e o caso reprova.
 */
export const TAMANHO_NO_EVAL = { titulo: TAMANHO_RECOMENDADO.tituloNoInstagram, texto: TAMANHO_RECOMENDADO.textoNoFacebook } as const;

const Rotulo = z.string().min(1);

export const CasoDoCriativo = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]{3,60}$/),
  grupo: z.enum(GRUPOS_DO_CRIATIVO),
  descricao: z.string().min(10).max(300),
  marca: z.string().min(2).max(80),
  destino: z.enum(DESTINOS_DA_PECA),
  variacoes: z.number().int().min(VARIACOES.min).max(VARIACOES.max),
  /** O dossiê da marca, no contrato de Minha marca: o texto que o modelo lê sai dele pelo código de produção. */
  dossie: BrandDossierContent,
  /** As provas que o sistema calcula (não ficam no dossiê). */
  provas: z.array(SystemProof).default([]),
  /** A oferta escolhida, como está escrita em Minha marca. */
  oferta: z.string().min(3).max(160),
  referencia: z.strictObject({ anuncio: z.string().min(1), titulo: z.string().nullable(), texto: z.string().nullable() }).nullable().default(null),
  instrucao: z.string().min(1).max(INSTRUCAO_MAXIMA).nullable().default(null),
  /** "Pedir outra": a versão atual da peça que o pedido refaz. A peça nova precisa ser diferente dela. */
  anterior: z.strictObject({ titulo: z.string().min(1), texto: z.string().min(1) }).nullable().default(null),
  espera: z.strictObject({
    /** O Criativo precisa recusar, com um destes motivos (e sem peça nenhuma). */
    recusa: z.array(z.enum(RECUSAS_DO_CRIATIVO)).min(1).optional(),
    /** Trechos que toda peça precisa trazer (o preço da oferta, por exemplo), sem olhar espaço, acento nem maiúscula. */
    cita: z.array(Rotulo).optional(),
    /** Trechos que nenhuma peça pode trazer, sem olhar acento nem maiúscula. */
    nao_cita: z.array(Rotulo).optional(),
  }),
  gravadas: z.strictObject({
    boa: z.unknown(),
    ruins: z.array(z.strictObject({ resposta: z.unknown(), falha: z.string().min(3) })).default([]),
  }),
});
export type CasoDoCriativo = z.infer<typeof CasoDoCriativo>;

/** Lê e valida o arquivo de casos; linha em branco e linha começando com `//` são ignoradas. */
export function carregarCasosDoCriativo(caminho: string): CasoDoCriativo[] {
  const casos: CasoDoCriativo[] = [];
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
      const r = CasoDoCriativo.safeParse(bruto);
      if (!r.success) throw new Error(`${caminho}, linha ${i + 1}: ${r.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
      casos.push(r.data);
    });
  const ids = casos.map((c) => c.id);
  const repetido = ids.find((id, i) => ids.indexOf(id) !== i);
  if (repetido) throw new Error(`${caminho}: caso repetido "${repetido}"`);
  return casos;
}

/** O pedido do caso como a produção o monta: o texto do dossiê e o anúncio de referência que pode ir ao modelo. */
export function pedidoDoCaso(c: CasoDoCriativo): PedidoDePeca {
  return {
    marca: c.marca,
    destino: c.destino,
    variacoes: c.variacoes,
    dossie: textoDoDossie(c.marca, c.dossie, c.provas),
    oferta: c.oferta,
    referencia: referenciaSegura(c.referencia),
    instrucao: c.instrucao,
    anterior: c.anterior,
  };
}

/** Do que a conferência de cada peça parte, no caso: a oferta, os fatos do dossiê, o que a marca não diz e os concorrentes dela. */
export function baseDoCaso(c: CasoDoCriativo): BaseDaPeca {
  return baseDoPedido(c, { fatos: fatosDoDossie(c.marca, c.dossie, c.provas), proibidas: proibidasDoDossie(c.dossie), concorrentes: concorrentesDoDossie(c.dossie) });
}

/** Para achar um trecho sem depender de acento nem de maiúscula; `compacto` também ignora os espaços ("R$34,90"). */
const compacto = (t: string) => normalizar(t).replace(/\s+/g, '');

/** Avaliador determinístico das peças: o schema, a recusa, a conferência de produção (estrita) e as regras do caso. */
export function avaliarPecas(caso: CasoDoCriativo, bruto: unknown): Avaliacao {
  let valor = bruto;
  if (typeof bruto === 'string') {
    try {
      valor = JSON.parse(bruto);
    } catch {
      return { ok: false, falhas: ['formato: a resposta não é JSON'] };
    }
  }
  const lida = RespostaDoCriativo.safeParse(valor);
  if (!lida.success) return { ok: false, falhas: [`formato: ${lida.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`).join('; ')}`] };
  const r = lida.data;
  const { espera } = caso;

  // A recusa: o pedido que o Criativo não atende volta sem peça nenhuma; o que ele atende não pode voltar recusado.
  if (espera.recusa) {
    const falhas: string[] = [];
    if (!r.recusa) falhas.push(`nao_recusou: esperava ${espera.recusa.join(' ou ')}`);
    else if (!espera.recusa.includes(r.recusa)) falhas.push(`recusa: veio "${r.recusa}", esperado ${espera.recusa.join(' ou ')}`);
    if (r.recusa && r.pecas.length) falhas.push(`recusou_com_peca: ${r.pecas.length} peça(s) junto da recusa`);
    return { ok: falhas.length === 0, falhas };
  }
  if (r.recusa) return { ok: false, falhas: [`recusou_sem_motivo: ${r.recusa}`] };

  const falhas: string[] = [];
  if (r.pecas.length !== caso.variacoes) falhas.push(`quantidade: vieram ${r.pecas.length}, pedidas ${caso.variacoes}`);
  // A conferência de produção: no eval, a peça que não chegaria a aparecer e qualquer achado reprovam.
  const { pecas, descartes } = pecasDaResposta(r, baseDoCaso(caso), caso.variacoes, caso.anterior);
  for (const [motivo, n] of Object.entries(descartes)) if (n > 0 && motivo !== 'a_mais') falhas.push(`descartada_${motivo}: ${n} peça(s)`);
  pecas.forEach((p, i) => {
    const n = i + 1;
    for (const item of p.conferencia.itens) {
      for (const a of item.achados) {
        if (a.tipo !== 'acima_do_recomendado') falhas.push(`${a.tipo}: peça ${n}, ${a.campo}: ${a.trecho}`);
        else if (caracteres(p[a.campo]) > TAMANHO_NO_EVAL[a.campo]) falhas.push(`tamanho: peça ${n}, ${a.campo}: ${caracteres(p[a.campo])} caracteres (o guia da Meta recomenda até ${TAMANHO_NO_EVAL[a.campo]})`);
      }
    }
    for (const sinal of estiloDaPeca(p)) falhas.push(`estilo: peça ${n}: ${sinal}`);
    if (!BOTOES_DO_DESTINO[caso.destino].includes(p.botao)) falhas.push(`botao: peça ${n}: ${p.botao} não serve para o destino ${caso.destino}`);
    const texto = `${p.titulo}\n${p.texto}`;
    for (const t of espera.cita ?? []) if (!compacto(texto).includes(compacto(t))) falhas.push(`nao_citou: peça ${n}: ${t}`);
    for (const t of espera.nao_cita ?? []) if (normalizar(texto).includes(normalizar(t).trim())) falhas.push(`citou: peça ${n}: ${t}`);
  });
  return { ok: falhas.length === 0, falhas };
}
