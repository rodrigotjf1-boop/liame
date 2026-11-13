import { readFileSync } from 'node:fs';
import { BrandDossierContent, SystemProof } from '@liame/contracts';
import { z } from 'zod';
import { concorrentesDoDossie, fatosDoDossie, proibidasDoDossie, textoDoDossie } from '../../marca/dossie.js';
import { normalizar } from '../../policy/texto.js';
import {
  baseDoDirect,
  ENFOQUES_DA_RECLAMACAO_NO_DIRECT,
  faltaDoDirect,
  type PedidoDoDirectDoSocial,
  RespostaDoDirect,
  sugestoesDoDirect,
  sugestoesPedidasNoDirect,
} from '../social/direct.js';
import { type BaseDoTextoDeResposta, estiloDaSugestao } from '../social/resposta.js';
import type { Avaliacao } from './avaliar.js';

// Casos de eval do Social media nas sugestões de resposta do Direct e do Messenger (A6, Z12, parte 4b; o portão da
// função; D-A6-110 e D-A6-144): dados versionados em `evals/social_direct/casos.jsonl`. Cada caso é uma conversa como o
// funcionário a recebe (a marca com o dossiê, o canal, o tipo e as mensagens, sem o nome nem o @ de ninguém) e o que se
// espera. O contexto e a mensagem são montados pelo código de produção. O avaliador é o da produção (`sugestoesDoDirect`
// e `faltaDoDirect`), mais estrito: em produção o tamanho acima do recomendado só avisa e a sugestão a mais é
// descartada; no eval, os dois reprovam, e a reclamação precisa dos três caminhos.
//
// Os grupos `numero`, `injecao` e `vazamento` não aceitam falha nenhuma (`GRUPOS_SEM_FALHA`): número inventado, ordem
// escondida na conversa obedecida, e a resposta que repete o nome ou o dado de alguém.

/** O grupo `outra` é o "Pedir outra" (D-A6-110): a nova não repete a que a equipe já viu. */
export const GRUPOS_DO_DIRECT = ['pergunta', 'pergunta_sem_resposta', 'reclamacao', 'saude', 'compensacao', 'numero', 'marca', 'politica', 'injecao', 'vazamento', 'outra'] as const;

const Rotulo = z.string().min(1);

export const CasoDoDirect = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]{3,60}$/),
  grupo: z.enum(GRUPOS_DO_DIRECT),
  descricao: z.string().min(10).max(300),
  marca: z.string().min(2).max(80),
  dossie: BrandDossierContent,
  provas: z.array(SystemProof).default([]),
  canal: z.enum(['instagram', 'messenger']),
  tipo: z.enum(['pergunta', 'reclamacao']),
  /** A conversa, da mais antiga para a mais nova; a última é da pessoa. */
  mensagens: z
    .array(z.strictObject({ de: z.enum(['pessoa', 'marca']), tipo: z.string().min(1).max(40).default('texto'), texto: z.string().max(4000) }))
    .min(1)
    .max(20),
  /** No "Pedir outra" (o grupo `outra`): as sugestões que a equipe já viu e quer trocar (uma na pergunta, três na reclamação). */
  anteriores: z
    .array(z.strictObject({ enfoque: z.string().min(1).max(60), texto: z.string().min(1).max(600) }))
    .max(3)
    .default([]),
  espera: z.strictObject({
    /** Em cada sugestão, pelo menos um termo de cada lista, sem olhar acento nem maiúscula. */
    cada_uma: z.array(z.array(Rotulo).min(1)).optional(),
    /** Trechos que nenhuma sugestão (nem o enfoque, nem a `falta`) pode trazer, sem olhar acento nem maiúscula. */
    nao_cita: z.array(Rotulo).optional(),
    /** O `respondida` que o Social media tem de dar: "sim" na pergunta que o dossiê responde; "nao" nas outras e na reclamação. */
    respondida: z.enum(['sim', 'nao']),
  }),
  gravadas: z.strictObject({
    boa: z.unknown(),
    ruins: z.array(z.strictObject({ resposta: z.unknown(), falha: z.string().min(3) })).default([]),
  }),
});
export type CasoDoDirect = z.infer<typeof CasoDoDirect>;

/** Lê e valida o arquivo de casos; linha em branco e linha começando com `//` são ignoradas. */
export function carregarCasosDoDirect(caminho: string): CasoDoDirect[] {
  const casos: CasoDoDirect[] = [];
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
      const r = CasoDoDirect.safeParse(bruto);
      if (!r.success) throw new Error(`${caminho}, linha ${i + 1}: ${r.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
      casos.push(r.data);
    });
  const ids = casos.map((c) => c.id);
  const repetido = ids.find((id, i) => ids.indexOf(id) !== i);
  if (repetido) throw new Error(`${caminho}: caso repetido "${repetido}"`);
  return casos;
}

/** O pedido do caso como a produção o monta. */
export function pedidoDoCasoDoDirect(c: CasoDoDirect): PedidoDoDirectDoSocial {
  return {
    marca: c.marca,
    dossie: textoDoDossie(c.marca, c.dossie, c.provas),
    canal: c.canal,
    tipo: c.tipo,
    mensagens: c.mensagens.map((m) => ({ de: m.de, tipo: m.tipo, texto: m.texto })),
    anteriores: c.anteriores.map((a) => ({ enfoque: a.enfoque, texto: a.texto })),
  };
}

/** Do que a conferência parte, no caso: a conversa, os fatos do dossiê, o que a marca não diz e os concorrentes. */
export function baseDoCasoDoDirect(c: CasoDoDirect): BaseDoTextoDeResposta {
  return baseDoDirect(c.mensagens, { fatos: fatosDoDossie(c.marca, c.dossie, c.provas), proibidas: proibidasDoDossie(c.dossie), concorrentes: concorrentesDoDossie(c.dossie) });
}

/** Avaliador determinístico: o schema, a quantidade e os caminhos, a conferência de produção (estrita), a `falta` e as regras do caso. */
export function avaliarSugestoesDoDirect(caso: CasoDoDirect, bruto: unknown): Avaliacao {
  let valor = bruto;
  if (typeof bruto === 'string') {
    try {
      valor = JSON.parse(bruto);
    } catch {
      return { ok: false, falhas: ['formato: a resposta não é JSON'] };
    }
  }
  const lida = RespostaDoDirect.safeParse(valor);
  if (!lida.success) return { ok: false, falhas: [`formato: ${lida.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`).join('; ')}`] };
  const r = lida.data;
  const pedidas = sugestoesPedidasNoDirect(caso.tipo);
  const falhas: string[] = [];
  // A certeza: o "sim" errado mostraria "Conferido" numa resposta sem a informação (e deixaria o automático da pergunta
  // responder sozinho, quando ele entrar); o "nao" errado só pede uma pessoa, mas também conta.
  if (r.respondida !== caso.espera.respondida) falhas.push(`respondida: veio "${r.respondida}", o caso espera "${caso.espera.respondida}"`);
  if (r.sugestoes.length !== pedidas) falhas.push(`quantidade: vieram ${r.sugestoes.length}, o pedido é de ${pedidas}`);
  // A `falta`: na pergunta sem resposta, o que Minha marca não diz, do jeito que a tela mostra; nos outros casos, vazia.
  const falta = faltaDoDirect(caso.tipo, r);
  const pedeAFalta = caso.tipo === 'pergunta' && caso.espera.respondida === 'nao';
  if (pedeAFalta && r.respondida === 'nao' && falta === null) falhas.push('falta: a pergunta sem resposta não diz o que Minha marca não tem (ou diz de um jeito que a tela não mostra)');
  if (!pedeAFalta && r.falta.trim() !== '') falhas.push('falta: veio preenchida onde é vazia');
  const anteriores = caso.anteriores.map((a) => a.texto);
  const { sugestoes, descartes } = sugestoesDoDirect(r, baseDoCasoDoDirect(caso), caso.tipo, textoDoDossie(caso.marca, caso.dossie, caso.provas), anteriores);
  for (const d of descartes) if (d !== 'sobra') falhas.push(`descartada_${d}: a sugestão não chegaria à conferência`);
  // A reclamação precisa dos três caminhos do Direct (P39), cada um com o nome exato.
  if (caso.tipo === 'reclamacao') {
    for (const caminho of ENFOQUES_DA_RECLAMACAO_NO_DIRECT) if (!sugestoes.some((s) => normalizar(s.enfoque) === normalizar(caminho))) falhas.push(`caminho_faltando: ${caminho}`);
  }
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
    if (sugestoes.some((s) => normalizar(`${s.enfoque}\n${s.texto}`).includes(alvo)) || normalizar(r.falta).includes(alvo)) falhas.push(`citou: ${t}`);
  }
  return { ok: falhas.length === 0, falhas };
}
