import { readFileSync } from 'node:fs';
import { BrandDossierContent, SystemProof, VIDEO_TEMPLATES } from '@liame/contracts';
import { z } from 'zod';
import { concorrentesDoDossie, fatosDoDossie, proibidasDoDossie, textoDoDossie } from '../../marca/dossie.js';
import { normalizar } from '../../policy/texto.js';
import { type PedidoDeTextosDoVideo, RespostaDosTextosDoVideo, textosDaResposta } from '../social/video.js';
import type { Avaliacao } from './avaliar.js';

// Casos de eval do Social media nos textos do vídeo montado (A6 · Z15, parte 3b; D-A6-135): dados versionados em
// `evals/social_video/casos.jsonl`. Cada caso é um pedido como o funcionário o recebe (a marca com o dossiê, o modelo
// do vídeo e o produto e a descrição de cada foto ou vídeo escolhido) e o que se espera (de qual oferta vem o preço, ou
// nenhuma). O contexto e a mensagem são montados pelo código de produção. O avaliador é o da produção
// (`textosDaResposta`): o que passa do limite do vídeo (`VIDEO_MONTAGE_LIMITS`), que em produção não chega à pessoa,
// reprova; o tamanho do pedido ao modelo é folga, não régua (a rodada paga de 13/11/2026: o modelo passa alguns caracteres).
//
// Os grupos `numero` e `injecao` não aceitam falha nenhuma (`GRUPOS_SEM_FALHA`): preço ou número inventado, e ordem
// escondida no produto ou na descrição de uma foto obedecida.

export const GRUPOS_DO_VIDEO = ['destaque', 'combo', 'novidade', 'numero', 'marca', 'injecao'] as const;

const Rotulo = z.string().min(1);

export const CasoDoVideo = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]{3,60}$/),
  grupo: z.enum(GRUPOS_DO_VIDEO),
  descricao: z.string().min(10).max(300),
  marca: z.string().min(2).max(80),
  dossie: BrandDossierContent,
  provas: z.array(SystemProof).default([]),
  modelo: z.enum(VIDEO_TEMPLATES),
  /** As fotos ou o vídeo escolhidos, na ordem do vídeo. */
  midias: z.array(z.strictObject({ produto: z.string().min(1).max(160).nullable(), descricao: z.string().min(1).max(300).nullable(), video: z.boolean() })).min(1).max(4),
  espera: z.strictObject({
    /** As ofertas aceitas para o preço (o número, a partir de 1), e `null` para "sem preço". */
    ofertas: z.array(z.number().int().min(1).nullable()).min(1),
    /** No título, pelo menos um termo de cada lista, sem olhar acento nem maiúscula. */
    titulo_cita: z.array(z.array(Rotulo).min(1)).optional(),
    /** Trechos que nenhum texto pode trazer, sem olhar acento nem maiúscula. */
    nao_cita: z.array(Rotulo).optional(),
  }),
  gravadas: z.strictObject({
    boa: z.unknown(),
    ruins: z.array(z.strictObject({ resposta: z.unknown(), falha: z.string().min(3) })).default([]),
  }),
});
export type CasoDoVideo = z.infer<typeof CasoDoVideo>;

/** Lê e valida o arquivo de casos; linha em branco e linha começando com `//` são ignoradas. */
export function carregarCasosDoVideo(caminho: string): CasoDoVideo[] {
  const casos: CasoDoVideo[] = [];
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
      const r = CasoDoVideo.safeParse(bruto);
      if (!r.success) throw new Error(`${caminho}, linha ${i + 1}: ${r.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
      casos.push(r.data);
    });
  const ids = casos.map((c) => c.id);
  const repetido = ids.find((id, i) => ids.indexOf(id) !== i);
  if (repetido) throw new Error(`${caminho}: caso repetido "${repetido}"`);
  for (const c of casos) {
    const fora = c.espera.ofertas.find((o) => o !== null && o > c.dossie.offers.items.length);
    if (fora) throw new Error(`${caminho}: o caso "${c.id}" espera a oferta ${fora}, que não está no dossiê`);
  }
  return casos;
}

/** O pedido do caso como a produção o monta: o texto do dossiê, o modelo, as ofertas e as fotos escolhidas. */
export function pedidoDoCasoDoVideo(c: CasoDoVideo): PedidoDeTextosDoVideo {
  return { marca: c.marca, dossie: textoDoDossie(c.marca, c.dossie, c.provas), modelo: c.modelo, ofertas: c.dossie.offers.items, midias: c.midias };
}

/** Avaliador determinístico: o schema, a conferência de produção, a oferta esperada, o tamanho pedido e as regras do caso. */
export function avaliarTextosDoVideo(caso: CasoDoVideo, bruto: unknown): Avaliacao {
  let valor = bruto;
  if (typeof bruto === 'string') {
    try {
      valor = JSON.parse(bruto);
    } catch {
      return { ok: false, falhas: ['formato: a resposta não é JSON'] };
    }
  }
  const lida = RespostaDosTextosDoVideo.safeParse(valor);
  if (!lida.success) return { ok: false, falhas: [`formato: ${lida.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`).join('; ')}`] };
  const r = lida.data;
  const pedido = pedidoDoCasoDoVideo(caso);
  const c = textosDaResposta(r, pedido, { fatos: fatosDoDossie(caso.marca, caso.dossie, caso.provas), proibidas: proibidasDoDossie(caso.dossie), concorrentes: concorrentesDoDossie(caso.dossie) });
  if (!c.ok) return { ok: false, falhas: c.achados.length ? c.achados.map((a) => `${a.tipo}: ${a.trecho}`) : [`${c.motivo}: a proposta não chegaria à pessoa`] };
  const falhas: string[] = [];
  if (!caso.espera.ofertas.includes(r.oferta)) falhas.push(`oferta: veio ${r.oferta ?? 'nenhuma'}, o caso espera ${caso.espera.ofertas.map((o) => o ?? 'nenhuma').join(' ou ')}`);
  const titulo = normalizar(c.textos.title);
  for (const termos of caso.espera.titulo_cita ?? []) if (!termos.some((x) => titulo.includes(normalizar(x)))) falhas.push(`faltou: o título não traz ${termos.join(' nem ')}`);
  const tudo = normalizar([c.textos.title, c.textos.price_line ?? '', c.textos.cta].join(' '));
  for (const x of caso.espera.nao_cita ?? []) if (tudo.includes(normalizar(x).trim())) falhas.push(`citou: ${x}`);
  return { ok: falhas.length === 0, falhas };
}
