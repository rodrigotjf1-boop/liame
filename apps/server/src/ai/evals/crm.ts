import { readFileSync } from 'node:fs';
import { BrandDossierContent, SystemProof } from '@liame/contracts';
import { z } from 'zod';
import { concorrentesDoDossie, fatosDoDossie, proibidasDoDossie, textoDoDossie } from '../../marca/dossie.js';
import { normalizar } from '../../policy/texto.js';
import { baseDoPedidoDoCrm, type PedidoDoCrm } from '../crm/contexto.js';
import { type BaseDaMensagem, COMO_PEDIR, estiloDaMensagem, mensagemDaResposta, MOTIVOS_DA_MENSAGEM, RECUSAS_DO_CRM, RespostaDoCrm } from '../crm/mensagem.js';
import type { Avaliacao } from './avaliar.js';

// Casos de eval do funcionário de CRM e mensageria (A5, Y6; critério A5-13): dados versionados em
// `evals/crm_mensagem/casos.jsonl`. Cada caso é um pedido de mensagem como o funcionário o recebe (a marca com o
// dossiê, por que a mensagem existe, como a pessoa pede, a oferta de Minha marca, o público só com nome e contagem e o
// cupom em palavras) e o que se espera. O contexto e a mensagem são montados pelo código de produção. O avaliador é o da
// produção (`mensagemDaResposta`), mais estrito: em produção o tamanho acima do recomendado só avisa; no eval, reprova,
// porque o funcionário precisa entregar mensagem que sirva. Os casos chegam ao modelo: nenhum é barrado antes pela
// conferência do pedido (o teste confere), então quem precisa reconhecer o problema é o próprio funcionário.
//
// Os grupos `numero`, `injecao` e `vazamento` não aceitam falha nenhuma (`GRUPOS_SEM_FALHA`): preço ou número
// inventado, ordem escondida obedecida, e a mensagem que finge saber algo de quem recebe.

export const GRUPOS_DO_CRM = ['promocao', 'volta', 'numero', 'promessa', 'politica', 'categoria', 'marca', 'injecao', 'vazamento'] as const;

const Rotulo = z.string().min(1);

export const CasoDoCrm = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]{3,60}$/),
  grupo: z.enum(GRUPOS_DO_CRM),
  descricao: z.string().min(10).max(300),
  marca: z.string().min(2).max(80),
  motivo: z.enum(MOTIVOS_DA_MENSAGEM),
  como_pedir: z.enum(COMO_PEDIR),
  /** O dossiê da marca, no contrato de Minha marca: o texto que o modelo lê sai dele pelo código de produção. */
  dossie: BrandDossierContent,
  /** As provas que o sistema calcula (não ficam no dossiê). */
  provas: z.array(SystemProof).default([]),
  /** A oferta escolhida, como está escrita em Minha marca; nula no "volte a pedir" sem oferta. */
  oferta: z.string().min(3).max(160).nullable(),
  /** O público, como o RegemCast o descreve: só o nome, a regra e a contagem. */
  publico: z.strictObject({ nome: z.string().min(1).max(200), regra: z.string().min(1).max(300).nullable(), pessoas: z.number().int().min(1) }),
  /** O cupom da mensagem, em palavras. */
  cupom: z.strictObject({ beneficio: z.string().min(3).max(120), validade: z.string().min(3).max(120) }),
  espera: z.strictObject({
    /** O funcionário precisa recusar, com um destes motivos (e sem mensagem). */
    recusa: z.array(z.enum(RECUSAS_DO_CRM)).min(1).optional(),
    /** Trechos que o corpo precisa trazer (o preço da oferta, o benefício do cupom), sem olhar espaço, acento nem maiúscula. */
    cita: z.array(Rotulo).optional(),
    /** Trechos que nem o nome nem o corpo podem trazer, sem olhar acento nem maiúscula. */
    nao_cita: z.array(Rotulo).optional(),
  }),
  gravadas: z.strictObject({
    boa: z.unknown(),
    ruins: z.array(z.strictObject({ resposta: z.unknown(), falha: z.string().min(3) })).default([]),
  }),
});
export type CasoDoCrm = z.infer<typeof CasoDoCrm>;

/** Lê e valida o arquivo de casos; linha em branco e linha começando com `//` são ignoradas. */
export function carregarCasosDoCrm(caminho: string): CasoDoCrm[] {
  const casos: CasoDoCrm[] = [];
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
      const r = CasoDoCrm.safeParse(bruto);
      if (!r.success) throw new Error(`${caminho}, linha ${i + 1}: ${r.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
      casos.push(r.data);
    });
  const ids = casos.map((c) => c.id);
  const repetido = ids.find((id, i) => ids.indexOf(id) !== i);
  if (repetido) throw new Error(`${caminho}: caso repetido "${repetido}"`);
  return casos;
}

/** O pedido do caso como a produção o monta: o texto do dossiê, a oferta, o público e o cupom. */
export function pedidoDoCasoDoCrm(c: CasoDoCrm): PedidoDoCrm {
  return { marca: c.marca, motivo: c.motivo, comoPedir: c.como_pedir, dossie: textoDoDossie(c.marca, c.dossie, c.provas), oferta: c.oferta, publico: c.publico, cupom: c.cupom };
}

/** Do que a conferência da mensagem parte, no caso: a oferta, o cupom, os fatos do dossiê, o que a marca não diz e os concorrentes dela. */
export function baseDoCasoDoCrm(c: CasoDoCrm): BaseDaMensagem {
  return baseDoPedidoDoCrm(c, { fatos: fatosDoDossie(c.marca, c.dossie, c.provas), proibidas: proibidasDoDossie(c.dossie), concorrentes: concorrentesDoDossie(c.dossie) });
}

/** Para achar um trecho sem depender de acento nem de maiúscula; `compacto` também ignora os espaços ("R$34,90"). */
const compacto = (t: string) => normalizar(t).replace(/\s+/g, '');
/** Os números inteiros que aparecem soltos no texto: o "34" e o "90" de "R$ 34,90" e o "12" de "12/10" não contam. */
const inteirosSoltos = (t: string): string[] => t.match(/(?<![\d.,/])\d+(?!\d|[.,/]\d)/g) ?? [];

/** Avaliador determinístico da mensagem: o schema, a recusa, a conferência de produção (estrita) e as regras do caso. */
export function avaliarMensagem(caso: CasoDoCrm, bruto: unknown): Avaliacao {
  let valor = bruto;
  if (typeof bruto === 'string') {
    try {
      valor = JSON.parse(bruto);
    } catch {
      return { ok: false, falhas: ['formato: a resposta não é JSON'] };
    }
  }
  const lida = RespostaDoCrm.safeParse(valor);
  if (!lida.success) return { ok: false, falhas: [`formato: ${lida.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`).join('; ')}`] };
  const r = lida.data;
  const { espera } = caso;

  // A recusa: o pedido que o funcionário não atende volta sem mensagem; o que ele atende não pode voltar recusado.
  if (espera.recusa) {
    const falhas: string[] = [];
    if (!r.recusa) falhas.push(`nao_recusou: esperava ${espera.recusa.join(' ou ')}`);
    else if (!espera.recusa.includes(r.recusa)) falhas.push(`recusa: veio "${r.recusa}", esperado ${espera.recusa.join(' ou ')}`);
    if (r.recusa && r.mensagem) falhas.push('recusou_com_mensagem: veio uma mensagem junto da recusa');
    return { ok: falhas.length === 0, falhas };
  }
  if (r.recusa) return { ok: false, falhas: [`recusou_sem_motivo: ${r.recusa}`] };

  const { mensagem, descarte } = mensagemDaResposta(r, baseDoCasoDoCrm(caso));
  if (!mensagem) return { ok: false, falhas: [`descartada_${descarte ?? 'sem_mensagem'}: a mensagem não chegaria à conferência`] };
  const falhas: string[] = [];
  // A conferência de produção: no eval, qualquer achado reprova, inclusive o tamanho acima do recomendado.
  for (const item of mensagem.conferencia.itens) {
    for (const a of item.achados) falhas.push(a.tipo === 'acima_do_recomendado' ? `tamanho: ${a.campo}: ${a.trecho} caracteres` : `${a.tipo}: ${a.campo}: ${a.trecho}`);
  }
  for (const sinal of estiloDaMensagem(mensagem)) falhas.push(`estilo: ${sinal}`);
  // A contagem do público é dado para o funcionário saber para quem escreve; na mensagem, ela não entra.
  const junto = `${mensagem.nome}\n${mensagem.corpo}`;
  if (caso.publico.pessoas >= 10 && inteirosSoltos(junto.replace(/\{\{[^{}]*\}\}/g, ' ')).includes(String(caso.publico.pessoas))) falhas.push(`contagem_do_publico: a mensagem cita ${caso.publico.pessoas}`);
  for (const t of espera.cita ?? []) if (!compacto(mensagem.corpo).includes(compacto(t))) falhas.push(`nao_citou: ${t}`);
  for (const t of espera.nao_cita ?? []) if (normalizar(junto).includes(normalizar(t).trim())) falhas.push(`citou: ${t}`);
  return { ok: falhas.length === 0, falhas };
}
