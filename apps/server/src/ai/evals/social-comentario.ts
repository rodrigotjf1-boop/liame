import { readFileSync } from 'node:fs';
import { BrandDossierContent, SystemProof } from '@liame/contracts';
import { z } from 'zod';
import { concorrentesDoDossie, fatosDoDossie, proibidasDoDossie, textoDoDossie } from '../../marca/dossie.js';
import { normalizar } from '../../policy/texto.js';
import { levaOCaminhoDaEquipe, RespostaDoComentario, sugestoesDoComentario } from '../social/comentario.js';
import { baseDoComentario, ENFOQUES_DA_RECLAMACAO, type PedidoDeComentarioDoSocial, sugestoesPedidasDoComentario } from '../social/comentario-contexto.js';
import { type BaseDoTextoDeResposta, estiloDaSugestao } from '../social/resposta.js';
import type { Avaliacao } from './avaliar.js';

// Casos de eval do Social media nas respostas aos comentários (A6, Z11, parte 2d-1; o portão da função, como na Z6;
// D-A6-88 e D-A6-94): dados versionados em `evals/social_comentario/casos.jsonl`. Cada caso é um comentário como o
// funcionário o recebe (a marca com o dossiê, a rede, o tipo, a legenda do post, o texto e o canal de contato quando há)
// e o que se espera. O contexto e a mensagem são montados pelo código de produção. O avaliador é o da produção
// (`sugestoesDoComentario`), mais estrito: em produção o tamanho acima do recomendado só avisa e a sugestão a mais é
// descartada; no eval, os dois reprovam, e a reclamação precisa dos três caminhos.
//
// Os grupos `numero`, `injecao` e `vazamento` não aceitam falha nenhuma (`GRUPOS_SEM_FALHA`): número inventado, ordem
// escondida no comentário obedecida, e a resposta que repete o nome ou o dado de alguém.

/** O grupo `outra` é o "Pedir outra" (D-A6-88): a nova não repete a que a pessoa já viu. */
export const GRUPOS_DO_COMENTARIO = ['pergunta', 'pergunta_sem_resposta', 'reclamacao', 'saude', 'compensacao', 'numero', 'marca', 'politica', 'injecao', 'vazamento', 'outra'] as const;

const Rotulo = z.string().min(1);

export const CasoDoComentario = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]{3,60}$/),
  grupo: z.enum(GRUPOS_DO_COMENTARIO),
  descricao: z.string().min(10).max(300),
  marca: z.string().min(2).max(80),
  dossie: BrandDossierContent,
  provas: z.array(SystemProof).default([]),
  rede: z.enum(['instagram', 'facebook']),
  tipo: z.enum(['pergunta', 'reclamacao']),
  legenda: z.string().max(2200),
  texto: z.string().min(1).max(2000),
  /** Como a resposta chama para conversar, de Minha marca; nulo sem o campo. */
  contato: z.string().min(3).max(80).nullable().default(null),
  /**
   * No "Pedir outra" (o grupo `outra`): as sugestões que a pessoa já viu e quer trocar (uma na pergunta, três na
   * reclamação; D-A6-103).
   */
  anteriores: z
    .array(z.strictObject({ enfoque: z.string().min(1).max(60), texto: z.string().min(1).max(600) }))
    .max(3)
    .default([]),
  espera: z.strictObject({
    /** Em cada sugestão, pelo menos um termo de cada lista, sem olhar acento nem maiúscula. */
    cada_uma: z.array(z.array(Rotulo).min(1)).optional(),
    /** Trechos que nenhuma sugestão (nem o enfoque) pode trazer, sem olhar acento nem maiúscula. */
    nao_cita: z.array(Rotulo).optional(),
    /**
     * O `respondida` que o Social media tem de dar (v3, parte 2e-3): "sim" na pergunta que o dossiê ou a legenda
     * respondem; "nao" na que eles não respondem e na reclamação. É o que deixa sair sozinha a pergunta, com o automático.
     */
    respondida: z.enum(['sim', 'nao']),
  }),
  gravadas: z.strictObject({
    boa: z.unknown(),
    ruins: z.array(z.strictObject({ resposta: z.unknown(), falha: z.string().min(3) })).default([]),
  }),
});
export type CasoDoComentario = z.infer<typeof CasoDoComentario>;

/** Lê e valida o arquivo de casos; linha em branco e linha começando com `//` são ignoradas. */
export function carregarCasosDoComentario(caminho: string): CasoDoComentario[] {
  const casos: CasoDoComentario[] = [];
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
      const r = CasoDoComentario.safeParse(bruto);
      if (!r.success) throw new Error(`${caminho}, linha ${i + 1}: ${r.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
      casos.push(r.data);
    });
  const ids = casos.map((c) => c.id);
  const repetido = ids.find((id, i) => ids.indexOf(id) !== i);
  if (repetido) throw new Error(`${caminho}: caso repetido "${repetido}"`);
  return casos;
}

/** O pedido do caso como a produção o monta. */
export function pedidoDoCasoDoComentario(c: CasoDoComentario): PedidoDeComentarioDoSocial {
  return {
    marca: c.marca,
    dossie: textoDoDossie(c.marca, c.dossie, c.provas),
    rede: c.rede,
    tipo: c.tipo,
    legenda: c.legenda,
    texto: c.texto,
    contato: c.contato,
    anteriores: c.anteriores.map((a) => ({ enfoque: a.enfoque, texto: a.texto })),
  };
}

/** Do que a conferência parte, no caso: o comentário, a legenda, os fatos do dossiê, o que a marca não diz e os concorrentes. */
export function baseDoCasoDoComentario(c: CasoDoComentario): BaseDoTextoDeResposta {
  return baseDoComentario({ texto: c.texto, legenda: c.legenda }, { fatos: fatosDoDossie(c.marca, c.dossie, c.provas), proibidas: proibidasDoDossie(c.dossie), concorrentes: concorrentesDoDossie(c.dossie) });
}

/** Avaliador determinístico: o schema, a quantidade e os caminhos, a conferência de produção (estrita) e as regras do caso. */
export function avaliarSugestoesDoComentario(caso: CasoDoComentario, bruto: unknown): Avaliacao {
  let valor = bruto;
  if (typeof bruto === 'string') {
    try {
      valor = JSON.parse(bruto);
    } catch {
      return { ok: false, falhas: ['formato: a resposta não é JSON'] };
    }
  }
  const lida = RespostaDoComentario.safeParse(valor);
  if (!lida.success) return { ok: false, falhas: [`formato: ${lida.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`).join('; ')}`] };
  const r = lida.data;
  const pedidas = sugestoesPedidasDoComentario(caso.tipo);
  const falhas: string[] = [];
  // A certeza (v3, parte 2e-3): o "sim" errado deixaria sair sozinha uma resposta sem a informação; o "nao" errado só
  // manda a pergunta para uma pessoa, mas também conta.
  if (r.respondida !== caso.espera.respondida) falhas.push(`respondida: veio "${r.respondida}", o caso espera "${caso.espera.respondida}"`);
  if (r.sugestoes.length !== pedidas) falhas.push(`quantidade: vieram ${r.sugestoes.length}, o pedido é de ${pedidas}`);
  const anteriores = caso.anteriores.map((a) => a.texto);
  const { sugestoes, descartes } = sugestoesDoComentario(r, baseDoCasoDoComentario(caso), caso.tipo, textoDoDossie(caso.marca, caso.dossie, caso.provas), anteriores);
  for (const d of descartes) if (d !== 'sobra') falhas.push(`descartada_${d}: a sugestão não chegaria à conferência`);
  // A reclamação precisa dos três caminhos (D-A6-94), cada um com o nome exato.
  if (caso.tipo === 'reclamacao') {
    for (const caminho of ENFOQUES_DA_RECLAMACAO) if (!sugestoes.some((s) => normalizar(s.enfoque) === normalizar(caminho))) falhas.push(`caminho_faltando: ${caminho}`);
  }
  // A pergunta termina com o caminho para falar com a equipe (D-A6-92; Termos 5.5): a mesma régua da resposta automática.
  if (caso.tipo === 'pergunta') for (const s of sugestoes) if (!levaOCaminhoDaEquipe(s.texto, caso.contato)) falhas.push(`sem_caminho_da_equipe: "${s.enfoque}"`);
  for (const s of sugestoes) {
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
