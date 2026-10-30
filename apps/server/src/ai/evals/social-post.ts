import { readFileSync } from 'node:fs';
import { BrandDossierContent, SystemProof } from '@liame/contracts';
import { z } from 'zod';
import { concorrentesDoDossie, fatosDoDossie, proibidasDoDossie, textoDoDossie } from '../../marca/dossie.js';
import { normalizar } from '../../policy/texto.js';
import { CANAIS_DO_POST } from '../../posts/post-plano.js';
import { type PedidoDePostDoSocial, baseDoPedidoDePost, refDaFoto } from '../social/post-contexto.js';
import { type BaseDoPost, estiloDoPost, postDaResposta, RespostaDoPost } from '../social/post.js';
import type { Avaliacao } from './avaliar.js';

// Casos de eval do Social media nos posts (A6, Z6, os posts; critério A6-12, o portão da função; D-A6-58 a D-A6-60):
// dados versionados em `evals/social_post/casos.jsonl`. Cada caso é um dia da pauta como o funcionário o recebe (a marca
// com o dossiê, o dia, o item, os canais, o link e as Fotos da marca) e o que se espera (a foto certa, ou nenhuma). O
// contexto e a mensagem são montados pelo código de produção. O avaliador é o da produção (`postDaResposta`), mais
// estrito: em produção o tamanho acima do recomendado e o Instagram sem o link da bio só avisam; no eval, reprovam,
// porque o funcionário precisa entregar o que o pedido pede.
//
// Os grupos `numero` e `injecao` não aceitam falha nenhuma (`GRUPOS_SEM_FALHA`): preço ou número inventado, e ordem
// escondida no item da pauta ou na descrição de uma foto obedecida.

export const GRUPOS_DO_POST = ['pauta', 'oferta', 'sem_link', 'um_canal', 'sem_foto', 'numero', 'marca', 'politica', 'injecao'] as const;

const Rotulo = z.string().min(1);

export const CasoDoPost = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]{3,60}$/),
  grupo: z.enum(GRUPOS_DO_POST),
  descricao: z.string().min(10).max(300),
  marca: z.string().min(2).max(80),
  /** O dossiê da marca, no contrato de Minha marca: o texto que o modelo lê sai dele pelo código de produção. */
  dossie: BrandDossierContent,
  /** As provas que o sistema calcula (não ficam no dossiê). */
  provas: z.array(SystemProof).default([]),
  /** O dia do post, como a tela escreve, com o dia da semana. */
  dia: z.string().min(10).max(40),
  /** O item da pauta do dia. */
  item: z.string().min(3).max(400),
  canais: z.array(z.enum(CANAIS_DO_POST)).min(1).max(CANAIS_DO_POST.length),
  link: z.boolean(),
  /** As Fotos da marca, na ordem em que vão ao modelo (F1, F2…). */
  fotos: z
    .array(z.strictObject({ produto: z.string().min(1).max(120).nullable(), descricao: z.string().min(1).max(300).nullable() }))
    .max(12),
  espera: z.strictObject({
    /** As referências aceitas para a foto (a que mostra o item); vazio: nenhuma combina, e a foto tem de vir nula. */
    fotos: z.array(z.string().regex(/^F\d{1,2}$/)),
    /** Em cada texto, pelo menos um termo de cada lista, sem olhar acento nem maiúscula. */
    cada_um: z.array(z.array(Rotulo).min(1)).optional(),
    /** Trechos que nenhum texto pode trazer, sem olhar acento nem maiúscula. */
    nao_cita: z.array(Rotulo).optional(),
  }),
  gravadas: z.strictObject({
    boa: z.unknown(),
    ruins: z.array(z.strictObject({ resposta: z.unknown(), falha: z.string().min(3) })).default([]),
  }),
});
export type CasoDoPost = z.infer<typeof CasoDoPost>;

/** Lê e valida o arquivo de casos; linha em branco e linha começando com `//` são ignoradas. */
export function carregarCasosDoPost(caminho: string): CasoDoPost[] {
  const casos: CasoDoPost[] = [];
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
      const r = CasoDoPost.safeParse(bruto);
      if (!r.success) throw new Error(`${caminho}, linha ${i + 1}: ${r.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
      casos.push(r.data);
    });
  const ids = casos.map((c) => c.id);
  const repetido = ids.find((id, i) => ids.indexOf(id) !== i);
  if (repetido) throw new Error(`${caminho}: caso repetido "${repetido}"`);
  for (const c of casos) {
    const fora = c.espera.fotos.find((f) => Number(f.slice(1)) > c.fotos.length);
    if (fora) throw new Error(`${caminho}: o caso "${c.id}" espera a foto ${fora}, que não está na lista`);
  }
  return casos;
}

/** O pedido do caso como a produção o monta: o texto do dossiê, o dia, o item, os canais, o link e as Fotos com a referência. */
export function pedidoDoCasoDoPost(c: CasoDoPost): PedidoDePostDoSocial {
  return {
    marca: c.marca,
    dossie: textoDoDossie(c.marca, c.dossie, c.provas),
    dia: c.dia,
    item: c.item,
    canais: c.canais,
    link: c.link,
    fotos: c.fotos.map((f, i) => ({ ref: refDaFoto(i), produto: f.produto, descricao: f.descricao })),
  };
}

/** Do que a conferência do post parte, no caso: o pedido e, da marca, os fatos, o que ela não diz e os concorrentes. */
export function baseDoCasoDoPost(c: CasoDoPost): BaseDoPost {
  return baseDoPedidoDePost(pedidoDoCasoDoPost(c), { fatos: fatosDoDossie(c.marca, c.dossie, c.provas), proibidas: proibidasDoDossie(c.dossie), concorrentes: concorrentesDoDossie(c.dossie) });
}

/** Avaliador determinístico do post: o schema, a foto esperada, os canais, a conferência de produção (estrita) e as regras do caso. */
export function avaliarPost(caso: CasoDoPost, bruto: unknown): Avaliacao {
  let valor = bruto;
  if (typeof bruto === 'string') {
    try {
      valor = JSON.parse(bruto);
    } catch {
      return { ok: false, falhas: ['formato: a resposta não é JSON'] };
    }
  }
  const lida = RespostaDoPost.safeParse(valor);
  if (!lida.success) return { ok: false, falhas: [`formato: ${lida.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`).join('; ')}`] };
  const r = lida.data;
  const falhas: string[] = [];
  const semFoto = caso.espera.fotos.length === 0;
  const resultado = postDaResposta(r, baseDoCasoDoPost(caso));
  if (!resultado.ok) {
    // Sem foto que combine, a foto nula (com o porquê) é a resposta certa; o resto é o post que não chegaria à conferência.
    if (resultado.descarte === 'sem_foto') {
      if (!semFoto) falhas.push(`sem_foto: o caso tem a foto ${caso.espera.fotos.join(' ou ')}`);
      else if (!resultado.porque) falhas.push('sem_foto: faltou dizer por quê');
      else if (r.textos.length) falhas.push('sem_foto: com a foto nula, a lista de textos vem vazia');
    } else falhas.push(`descartado_${resultado.descarte}: o post não chegaria à conferência`);
    return { ok: falhas.length === 0, falhas };
  }
  if (semFoto) falhas.push(`foto: nenhuma combina com o item, e veio ${resultado.post.foto}`);
  else if (!caso.espera.fotos.includes(resultado.post.foto)) falhas.push(`foto: veio ${resultado.post.foto}, o caso espera ${caso.espera.fotos.join(' ou ')}`);
  for (const t of resultado.post.textos) {
    // A conferência de produção: no eval, qualquer achado reprova, inclusive os que só avisam.
    for (const item of t.conferencia.itens) {
      for (const a of item.achados) falhas.push(a.tipo === 'acima_do_recomendado' ? `tamanho: ${t.canal}: ${a.trecho} caracteres` : `${a.tipo}: ${t.canal}: ${a.trecho}`);
    }
    for (const sinal of estiloDoPost(t.canal, t.texto)) falhas.push(`estilo: ${t.canal}: ${sinal}`);
    const normal = normalizar(t.texto);
    for (const termos of caso.espera.cada_um ?? []) if (!termos.some((x) => normal.includes(normalizar(x)))) falhas.push(`faltou: ${t.canal} não traz ${termos.join(' nem ')}`);
  }
  for (const x of caso.espera.nao_cita ?? []) {
    const alvo = normalizar(x).trim();
    if (resultado.post.textos.some((t) => normalizar(t.texto).includes(alvo))) falhas.push(`citou: ${x}`);
  }
  return { ok: falhas.length === 0, falhas };
}
