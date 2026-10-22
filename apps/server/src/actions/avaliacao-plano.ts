import { z } from 'zod';
import { canonicalJson, sha256 } from '../audit/audit.js';
import { type AvaliacaoLida, TAMANHO_DA_RESPOSTA, textoDaResposta, textoGuardado } from '../connectors/google-business/perfil-google.js';
import { conferirTexto, normalizar } from '../policy/texto.js';

// O estado de uma avaliação do perfil da empresa no Google, como o Action Service o guarda no pedido de resposta (A6,
// Z2), e as regras puras em cima dele. Mora aqui, fora do conector, porque o registro de ferramentas (`tools.ts`) usa
// as mesmas.
//
// O estado NÃO leva o texto da avaliação nem nada de quem avaliou (D-A6-5): o texto fica em `profile_review`, que tem
// a guarda de 12 meses dele, e no pedido vai só um resumo criptográfico, que serve para notar que ele mudou. O nome de
// quem avaliou é lido na hora e passa pelo plano só para ser conferido contra o texto da resposta: não entra no estado,
// no pedido nem na auditoria.

/** O texto que a empresa publica, como parâmetro da ferramenta. O limite fino (caracteres e bytes) é o do plano. */
export const ParametrosDaResposta = z.strictObject({ texto: z.string().min(1).max(TAMANHO_DA_RESPOSTA * 4) });

const Instante = z.iso.datetime();

export const EstadoDaAvaliacao = z.strictObject({
  tipo: z.literal('avaliacao'),
  /** O id da avaliação no Liame (`profile_review.id`) e o dela no Google. */
  id: z.uuid(),
  google_id: z.string().min(1).max(200),
  /** Falso quando o Google diz que a avaliação não existe mais (quem escreveu apagou, ou ele tirou). */
  existe: z.boolean(),
  estrelas: z.int().min(1).max(5).nullable(),
  feita_em: Instante.nullable(),
  mudou_em: Instante.nullable(),
  /** O resumo criptográfico do texto da avaliação; nulo quando ela só tem a nota. O texto em si não vem para o pedido. */
  texto_resumo: z.string().nullable(),
  /** A resposta da empresa, como o Google a tem: o texto é da própria empresa. `situacao`: pendente, aprovada, recusada ou desconhecida. */
  resposta: z.strictObject({ situacao: z.string(), texto: z.string(), violacao: z.string().nullable() }).nullable(),
});
export type EstadoDaAvaliacao = z.infer<typeof EstadoDaAvaliacao>;

/** O que o plano confere e o pedido não guarda: o nome de quem avaliou, lido do Google na hora (nulo se anônima). */
export type ContextoDaAvaliacao = { quem: string | null };

/**
 * O resumo criptográfico do texto de uma avaliação, tirado do texto como o Liame o guarda (`textoGuardado`): o do
 * pedido e o do que está em `profile_review` se comparam. Nulo quando a avaliação só tem a nota.
 */
export function resumoDoTexto(texto: string | null | undefined): string | null {
  const guardado = textoGuardado(texto);
  return guardado ? sha256(guardado) : null;
}

/** A avaliação lida do Google agora → o estado do pedido. `lida` nula: o Google diz que ela não existe mais. */
export function estadoDaAvaliacao(alvo: { id: string; googleId: string }, lida: AvaliacaoLida | null): EstadoDaAvaliacao {
  const base = { tipo: 'avaliacao' as const, id: alvo.id, google_id: alvo.googleId };
  if (!lida) return { ...base, existe: false, estrelas: null, feita_em: null, mudou_em: null, texto_resumo: null, resposta: null };
  return {
    ...base,
    existe: true,
    estrelas: lida.estrelas,
    feita_em: lida.criadaEm,
    mudou_em: lida.atualizadaEm,
    texto_resumo: resumoDoTexto(lida.texto),
    resposta: lida.resposta ? { situacao: lida.resposta.situacao, texto: lida.resposta.texto, violacao: lida.resposta.violacao } : null,
  };
}

/**
 * A versão do estado, tirada dele mesmo: muda quando a avaliação muda no que a pessoa leu para decidir (a nota e o
 * texto), some, ou ganha, perde ou troca de resposta. É o que impede publicar a resposta aprovada numa avaliação que já
 * é outra (critério A6-4), e apagar uma resposta que já não é a que o Liame publicou. Cabe na coluna inteira do pedido
 * e nunca é zero.
 *
 * Duas coisas ficam de fora de propósito. **A data de mudança da avaliação:** a referência do Google não diz se
 * responder mexe nela (base de conhecimento §3.3, [NC]); com ela na versão, a resposta do próprio Liame poderia fazer a
 * avaliação parecer outra. **A conferência do Google** (a resposta que passa de "pendente" a "aprovada"): quem mexe é
 * o Google, sem mudar o que foi publicado, e a resposta precisa continuar podendo ser apagada. A resposta que ele
 * recusa muda a versão: ela não aparece no perfil, e o que cabe ali é responder de novo.
 */
export function versaoDaAvaliacao(e: Pick<EstadoDaAvaliacao, 'existe' | 'estrelas' | 'texto_resumo' | 'resposta'>): number {
  const base = { existe: e.existe, estrelas: e.estrelas, texto_resumo: e.texto_resumo, resposta: e.resposta ? { texto: textoComparavel(e.resposta.texto), recusada: e.resposta.situacao === 'recusada' } : null };
  return (Number.parseInt(sha256(canonicalJson(base)).slice(0, 12), 16) % 2_147_483_646) + 1;
}

/**
 * O texto de uma resposta, para comparar o que o Liame mandou com o que o Google devolve: na mesma forma Unicode, com
 * cada trecho de espaço em branco como um espaço só e sem espaço nas pontas. A referência do Google não diz se ele
 * devolve o texto exatamente como recebeu (base de conhecimento §3.3, [NC]): se ele acertar os espaços ou a forma das
 * letras, a resposta continua sendo a mesma para o Liame. Qualquer outra diferença conta como outro texto.
 */
export function textoComparavel(s: string): string {
  let saida = '';
  let espaco = false;
  for (const c of s.normalize('NFC')) {
    if (c.trim() === '') {
      espaco = saida.length > 0;
      continue;
    }
    if (espaco) saida += ' ';
    espaco = false;
    saida += c;
  }
  return saida;
}

/** Avaliação de 1 ou 2 estrelas: a resposta só sai com a aprovação do dono (D-A6-4). */
export const ehNotaBaixa = (estrelas: number | null): boolean => estrelas !== null && estrelas <= 2;

/** A resposta de nota baixa é outra ação para a política: é nela que a regra do dono (ESCALATE) casa. */
export const ACAO_DA_RESPOSTA = 'avaliacao.responder';
export const ACAO_DA_RESPOSTA_DE_NOTA_BAIXA = 'avaliacao.responder_nota_baixa';
/** Apagar a resposta que o Liame publicou (a volta de `avaliacao_responder`; P17). */
export const ACAO_DE_APAGAR_A_RESPOSTA = 'avaliacao.apagar_resposta';

const letra = (c: string | undefined): boolean => c !== undefined && ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'));

/** O primeiro nome de quem avaliou, sem acento e em minúsculas: a primeira palavra do nome com três letras ou mais. */
export function primeiroNome(quem: string | null | undefined): string | null {
  if (!quem) return null;
  let palavra = '';
  for (const c of `${normalizar(quem)} `) {
    if (c >= 'a' && c <= 'z') {
      palavra += c;
      continue;
    }
    if (palavra.length >= 3) return palavra;
    palavra = '';
  }
  return null;
}

/** O texto cita o primeiro nome de quem avaliou, como palavra inteira ("Ana" não casa com "banana")? */
export function citaONome(texto: string, quem: string | null | undefined): boolean {
  const nome = primeiroNome(quem);
  if (!nome) return false;
  const normal = normalizar(texto);
  for (let i = normal.indexOf(nome); i >= 0; i = normal.indexOf(nome, i + 1)) {
    if (!letra(normal[i - 1]) && !letra(normal[i + nome.length])) return true;
  }
  return false;
}

/** Compensação prometida em público: desconto, brinde, reembolso ou cortesia (P17; D-A6-4). Alternativas literais, sobre o texto normalizado. */
const COMPENSACAO = /(?<![a-z0-9])(descontos?|brindes?|reembols(?:o|os|ar|amos|aremos|ado|ada)|cortesias?)(?![a-z0-9])/g;

/** As palavras de compensação que o texto traz, sem repetir, como aparecem no texto normalizado; vazio quando não há. */
export function compensacaoPrometida(texto: string): string[] {
  return [...new Set([...normalizar(texto).matchAll(COMPENSACAO)].map((m) => m[1]!))];
}

const REGRA_EM_PALAVRAS: Record<string, string> = {
  politico_eleitoral: 'conteúdo político ou eleitoral (regra da Liame)',
  promessa_de_resultado: 'promessa de resultado (regra da Liame)',
  categoria_proibida: 'categoria que as plataformas proíbem (regra da Liame)',
  dado_pessoal: 'dado pessoal no texto (e-mail, telefone ou documento)',
  texto_longo: 'texto longo demais para conferir',
};

/**
 * O que o Compliance não deixa passar numa resposta a avaliação (critério A6-5), cada problema em palavras; vazio
 * quando o texto serve. A resposta é pública e sai em nome da empresa: sem compensação prometida ali, sem o nome de
 * quem avaliou (o Liame não guarda esse nome, e a resposta fica guardada no pedido) e sem dado pessoal.
 */
export function problemasDaResposta(texto: string, contexto?: ContextoDaAvaliacao | null): string[] {
  const problemas = conferirTexto(texto).map((x) => REGRA_EM_PALAVRAS[x.regra] ?? x.regra);
  const prometido = compensacaoPrometida(texto);
  if (prometido.length) problemas.push(`promessa de compensação em público (${prometido.join(', ')}): desconto, brinde e reembolso se combinam em particular`);
  if (citaONome(texto, contexto?.quem)) problemas.push('o nome de quem avaliou: o Liame não guarda esse nome, e a resposta fica guardada no pedido');
  return problemas;
}

/** O plano não pode ser montado: a mensagem vai para a pessoa (vira 422 `plano-recusado`). Quem lança a exceção é a ferramenta. */
export type PlanoDaResposta =
  | { ok: false; motivo: string }
  | { ok: true; acao: string; texto: string; desejado: EstadoDaAvaliacao };

/** Do estado da avaliação e do texto pedido, o plano da resposta. Função pura. */
export function planoDaResposta(before: unknown, params: unknown, contexto?: ContextoDaAvaliacao | null): PlanoDaResposta {
  const lido = EstadoDaAvaliacao.safeParse(before);
  if (!lido.success) return { ok: false, motivo: 'Esta ferramenta é para uma avaliação do perfil da empresa no Google.' };
  const e = lido.data;
  if (!e.existe || e.estrelas === null) return { ok: false, motivo: 'Esta avaliação não está mais no Google: quem escreveu apagou, ou o Google tirou. Não há o que responder.' };
  if (e.resposta && e.resposta.situacao === 'pendente') return { ok: false, motivo: 'Esta avaliação já tem uma resposta, que o Google está conferindo.' };
  if (e.resposta && e.resposta.situacao !== 'recusada') return { ok: false, motivo: 'Esta avaliação já tem resposta no Google.' };
  const pedido = ParametrosDaResposta.safeParse(params);
  const texto = pedido.success ? textoDaResposta(pedido.data.texto) : null;
  if (!texto) return { ok: false, motivo: `A resposta precisa de um texto, com até ${TAMANHO_DA_RESPOSTA.toLocaleString('pt-BR')} caracteres.` };
  const problemas = problemasDaResposta(texto, contexto);
  if (problemas.length) return { ok: false, motivo: `O texto da resposta não passa assim. Ajuste e salve de novo: ${problemas.join('; ')}.` };
  return {
    ok: true,
    acao: ehNotaBaixa(e.estrelas) ? ACAO_DA_RESPOSTA_DE_NOTA_BAIXA : ACAO_DA_RESPOSTA,
    texto,
    // O Google confere toda resposta antes de mostrar: ela nasce "pendente".
    desejado: { ...e, resposta: { situacao: 'pendente', texto, violacao: null } },
  };
}

/** A avaliação está como o pedido queria (a tentativa anterior caiu depois de o Google aceitar)? */
export function respostaJaPublicada(atual: EstadoDaAvaliacao, desejado: unknown): boolean {
  const quer = EstadoDaAvaliacao.safeParse(desejado);
  return (
    quer.success &&
    atual.resposta !== null &&
    quer.data.resposta !== null &&
    textoComparavel(atual.resposta.texto) === textoComparavel(quer.data.resposta.texto) &&
    atual.resposta.situacao !== 'recusada'
  );
}

/** O plano de apagar a resposta (a volta da resposta publicada). Função pura. */
export type PlanoDeApagar = { ok: false; motivo: string } | { ok: true; acao: string; desejado: EstadoDaAvaliacao };

export function planoDeApagar(before: unknown): PlanoDeApagar {
  const lido = EstadoDaAvaliacao.safeParse(before);
  if (!lido.success) return { ok: false, motivo: 'Esta ferramenta é para uma avaliação do perfil da empresa no Google.' };
  const e = lido.data;
  if (!e.existe) return { ok: false, motivo: 'Esta avaliação não está mais no Google: quem escreveu apagou, ou o Google tirou. A resposta saiu junto.' };
  if (!e.resposta) return { ok: false, motivo: 'Esta avaliação não tem resposta no Google: não há o que apagar.' };
  return { ok: true, acao: ACAO_DE_APAGAR_A_RESPOSTA, desejado: { ...e, resposta: null } };
}

/** A resposta já saiu do Google (a tentativa anterior de apagar caiu depois de ele aceitar)? */
export function respostaJaApagada(atual: EstadoDaAvaliacao, desejado: unknown): boolean {
  const quer = EstadoDaAvaliacao.safeParse(desejado);
  return quer.success && quer.data.resposta === null && atual.existe && atual.resposta === null;
}
