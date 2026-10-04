import type { ExplanationSegment, PlanContent, PlanDecision, PlanMarkedText, PlanResponse, PlanSummary } from '@liame/contracts';
import type { NomeIcone } from '@/components/ui/icone';
import { diaHora, diasAte, horaDe, quandoComHora, reaisDeMicros } from '@/lib/formato';
import { erroDaDecisao, type Grupo, type Risco } from './textos';

// Regras e textos dos planos do Estrategista dentro de Aprovações (mockups/prototipo-resumo.html, P8 aprovado em
// 03/10/2026). O plano vem pronto e conferido da API (`GET /v1/plans/{id}`): o conteúdo pelo tipo, cada número com a
// fonte e os textos com os números marcados. Aqui fica o que a tela diz em volta: o que pesa na lista, de onde o
// plano veio, o que aconteceu com ele, os motivos da recusa e a montagem da versão que a pessoa edita.

export type Noventa = Extract<PlanContent, { kind: 'noventa_dias' }>;
export type Pauta = Extract<PlanContent, { kind: 'pauta' }>;
export type Oferta = Extract<PlanContent, { kind: 'oferta' }>;

/** Risco de tipo novo (V23) é tratado como médio: pede atenção sem assustar. */
export function riscoDoPlano(risk: string): Risco {
  return risk === 'baixo' || risk === 'alto' ? risk : 'medio';
}

const MICROS_POR_REAL = 1_000_000n;

/** "+R$ 200/mês" quando o plano pede verba a mais; o resto é "sem verba nova" (verba igual, menor ou plano sem verba). */
export function dinheiroDoPlano(money_micros: string | null): string {
  if (money_micros === null) return 'sem verba nova';
  const d = BigInt(money_micros);
  return d > 0n ? `+${reaisDeMicros(d, 0)}/mês` : 'sem verba nova';
}

/**
 * Onde o plano entra na lista: o que espera decisão; e o que foi decidido hoje (aprovado, recusado, nova análise
 * pedida) ou expirou hoje. O que é de outros dias fica de fora, como os pedidos.
 */
export function grupoDoPlano(p: Pick<PlanSummary, 'status' | 'updated_at' | 'expires_at'>, agora: Date): Grupo | null {
  if (p.status === 'pendente') return 'pendente';
  const quando = p.status === 'expirado' ? p.expires_at : p.updated_at;
  return diasAte(quando, agora) === 0 ? 'feito' : null;
}

/** A segunda linha do plano decidido, na lista. Situação que a tela não conhece não inventa etiqueta. */
export function etiquetaDoPlano(status: string): string {
  if (status === 'aprovado') return 'Aprovado';
  if (status === 'recusado') return 'Recusado';
  if (status === 'nova_analise') return 'Nova análise pedida';
  return status === 'expirado' ? 'Expirou' : 'Decidido';
}

/** "Plano 5d02c7e1 · versão 2 · hash a81e…07d2": a aprovação vale só para esta versão. */
export function identidadeDaVersao(p: Pick<PlanSummary, 'id' | 'version' | 'content_hash'>): { plano: string; versao: number; hash: string } {
  return { plano: p.id.slice(0, 8), versao: p.version, hash: `${p.content_hash.slice(0, 4)}…${p.content_hash.slice(-4)}` };
}

/** O plano que ninguém pediu: o que a rotina do Estrategista manda (o do trimestre, a pauta de cada semana). */
const DA_ROTINA: Record<string, string> = { noventa_dias: 'o plano do trimestre', pauta: 'a pauta da semana', oferta: 'uma oferta' };

/** De onde o plano veio: de um pedido de alguém, de um pedido de nova análise ou da rotina do Estrategista. */
export function origemDoPlano(r: Pick<PlanResponse, 'plan' | 'reanalysis'>, euId: string): string {
  if (r.reanalysis) return `versão nova, a pedido: “${r.reanalysis}”`;
  const quem = r.plan.requested_by;
  if (quem) return `a pedido de ${quem.id === euId ? 'você' : quem.name}${r.plan.demand_id ? ', na conversa com a LIA' : ''}`;
  return DA_ROTINA[r.plan.kind] ?? 'um plano';
}

/** O texto com os números marcados (quando o servidor marcou algum) ou o texto do conteúdo, inteiro. */
export function trechosDo(marked: PlanMarkedText[], path: string, bruto: string): ExplanationSegment[] {
  return marked.find((m) => m.path === path)?.text ?? [{ text: bruto, number: null }];
}

/** Os caminhos dos textos que o corpo do plano mostra, pelo tipo (os mesmos de `CorpoDoPlano`). */
export function caminhosDoCorpo(c: PlanContent): string[] {
  if (c.kind === 'pauta') return c.days.map((_, i) => `days.${i}.item`);
  if (c.kind === 'oferta') return ['offer', 'where', 'ad_text', 'how_to_measure'];
  return [
    ...c.goals.flatMap((_, i) => [`goals.${i}.goal`, `goals.${i}.how_to_know`]),
    ...c.months.map((_, i) => `months.${i}.plan`),
    'budget.today.meta',
    'budget.today.google',
    ...c.dates.map((_, i) => `dates.${i}.what`),
  ];
}

/**
 * Os caminhos dos textos que aparecem na tela, na ordem: no plano que espera decisão, tudo; no decidido, o corpo e,
 * no aprovado, o que fazer e o que vem depois. A lista "De onde vêm os números" só traz os números destes textos.
 */
export function caminhosNaTela(c: PlanContent, vista: 'pendente' | 'aprovado' | 'decidido'): string[] {
  const depois = [...c.to_do.map((_, i) => `to_do.${i}`), 'after'];
  if (vista === 'decidido') return caminhosDoCorpo(c);
  if (vista === 'aprovado') return [...depois, ...caminhosDoCorpo(c)];
  return ['summary', ...c.reasons.map((_, i) => `reasons.${i}`), ...caminhosDoCorpo(c), 'risk_reason', ...depois];
}

/** As posições (em `numbers`) dos números que os textos destes caminhos citam, sem repetir, na ordem em que aparecem. */
export function numerosDosCaminhos(marked: PlanMarkedText[], caminhos: string[]): number[] {
  const vistos: number[] = [];
  for (const caminho of caminhos) {
    for (const trecho of marked.find((m) => m.path === caminho)?.text ?? []) {
      if (trecho.number !== null && !vistos.includes(trecho.number)) vistos.push(trecho.number);
    }
  }
  return vistos;
}

// ------------------------------------------------------------------ datas do plano (dia do calendário, sem fuso)

const SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const SEMANA_INTEIRA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const partes = (dia: string) => {
  const [a, m, d] = dia.split('-').map(Number);
  return { semana: new Date(Date.UTC(a!, m! - 1, d!)).getUTCDay(), dm: `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}` };
};

/** "Qua, 30/09": o dia da pauta. */
export function diaDaPauta(dia: string): string {
  const p = partes(dia);
  const s = SEMANA[p.semana]!;
  return `${s.charAt(0).toLocaleUpperCase('pt-BR')}${s.slice(1)}, ${p.dm}`;
}

/** "12/10 · seg": a data do calendário comercial. */
export function diaDoCalendario(dia: string): string {
  const p = partes(dia);
  return `${p.dm} · ${SEMANA[p.semana]}`;
}

/** "sexta, 02/10, das 18:00 às 23:00": quando a oferta vale. */
export function quandoDaOferta(c: Pick<Oferta, 'day' | 'starts_at' | 'ends_at'>): string {
  const p = partes(c.day);
  return `${SEMANA_INTEIRA[p.semana]}, ${p.dm}, das ${c.starts_at} às ${c.ends_at}`;
}

// ------------------------------------------------------------------ a verba do plano de 90 dias

const reais = (n: number) => reaisDeMicros(BigInt(n) * MICROS_POR_REAL, 0);

/** A frase da verba, pelas contas dos campos (não pelo texto de quem escreveu o plano). */
export function fraseDaVerba(b: Noventa['budget']): string {
  const hoje = b.today.meta + b.today.google;
  const proposta = b.proposal.meta + b.proposal.google;
  const d = proposta - hoje;
  const dMeta = b.proposal.meta - b.today.meta;
  if (d > 0) return `O total em anúncios sobe para ${reais(proposta)} por mês: ${reais(d)} a mais que hoje.`;
  if (d < 0) return `O total em anúncios cai para ${reais(proposta)} por mês: ${reais(-d)} a menos que hoje.`;
  if (!dMeta) return `A verba fica como está: ${reais(proposta)} por mês.`;
  return `O total em anúncios fica igual, ${reais(proposta)} por mês: ${reais(Math.abs(dMeta))} saem ${dMeta > 0 ? 'do Google e vão para a Meta' : 'da Meta e vão para o Google'}.`;
}

/** "Total: R$ 5.230 por mês, R$ 200 a mais que hoje.": acompanha os dois campos enquanto a pessoa edita. */
export function totalDaVerba(meta: number, google: number, hoje: Noventa['budget']['today']): string {
  const d = meta + google - (hoje.meta + hoje.google);
  const t = reais(meta + google);
  return d > 0 ? `Total: ${t} por mês, ${reais(d)} a mais que hoje.` : d < 0 ? `Total: ${t} por mês, ${reais(-d)} a menos que hoje.` : `Total: ${t} por mês, igual a hoje.`;
}

/** As linhas da tabela da verba: canal, hoje e proposta, e o total. */
export function tabelaDaVerba(b: Noventa['budget']): { linhas: Array<{ canal: string; caminho: string; hoje: string; proposta: string }>; total: { hoje: string; proposta: string } } {
  return {
    linhas: [
      { canal: 'Instagram e Facebook', caminho: 'budget.today.meta', hoje: reais(b.today.meta), proposta: reais(b.proposal.meta) },
      { canal: 'Google', caminho: 'budget.today.google', hoje: reais(b.today.google), proposta: reais(b.proposal.google) },
    ],
    total: { hoje: reais(b.today.meta + b.today.google), proposta: reais(b.proposal.meta + b.proposal.google) },
  };
}

// ------------------------------------------------------------------ o que aconteceu com o plano

const MOTIVO: Record<string, string> = {
  nao_e_o_momento: 'Não é o momento',
  verba_nao_serve: 'A verba não serve',
  oferta_nao_serve: 'A oferta não serve',
  falta_gente: 'Falta gente para fazer',
  nao_concordo: 'Não concordo com o plano',
};

export type MotivoDaRecusa = 'nao_e_o_momento' | 'verba_nao_serve' | 'oferta_nao_serve' | 'falta_gente' | 'nao_concordo';

/** Os motivos prontos da recusa, pelo tipo do plano (os do protótipo). */
export function motivosDoPlano(kind: string): Array<{ valor: MotivoDaRecusa; rotulo: string }> {
  const meio: Array<{ valor: MotivoDaRecusa; rotulo: string }> =
    kind === 'noventa_dias' ? [{ valor: 'verba_nao_serve', rotulo: MOTIVO.verba_nao_serve! }] : kind === 'pauta' ? [{ valor: 'falta_gente', rotulo: MOTIVO.falta_gente! }] : kind === 'oferta' ? [{ valor: 'oferta_nao_serve', rotulo: MOTIVO.oferta_nao_serve! }] : [];
  return [{ valor: 'nao_e_o_momento', rotulo: MOTIVO.nao_e_o_momento! }, ...meio, { valor: 'nao_concordo', rotulo: kind === 'pauta' ? 'Não concordo com a pauta' : MOTIVO.nao_concordo! }];
}

const quemDecidiu = (d: PlanDecision, euId: string) => (d.decided_by ? (d.decided_by.id === euId ? 'você' : d.decided_by.name) : 'uma pessoa da empresa');
/** "às 14:40" no mesmo dia; "em 02/10, 14:40" depois. */
const quandoDecidiu = (iso: string, agora: Date) => (diasAte(iso, agora) === 0 ? `às ${horaDe(iso)}` : `em ${diaHora(iso, agora)}`);

export interface ResultadoDoPlano {
  icone: NomeIcone;
  texto: string;
  /** Aprovado: aparece "O que fazer agora". */
  aprovado: boolean;
}

/** O que aconteceu com o plano que não espera mais decisão. Nulo no plano pendente. */
export function resultadoDoPlano(r: Pick<PlanResponse, 'plan' | 'decisions'>, euId: string, agora: Date): ResultadoDoPlano | null {
  const p = r.plan;
  if (p.status === 'pendente') return null;
  const ultima = (decisao: string) => [...r.decisions].reverse().find((d) => d.decision === decisao) ?? null;
  if (p.status === 'aprovado') {
    const d = ultima('aprovado');
    const quem = d ? `Aprovado por ${quemDecidiu(d, euId)} ${quandoDecidiu(d.created_at, agora)}` : 'Aprovado';
    const virou = p.kind === 'pauta' ? 'a pauta é a lista desta semana' : 'o plano virou a lista do que fazer';
    return { icone: 'check', aprovado: true, texto: `${quem} (versão ${d?.version ?? p.version}). Nada foi publicado pela Liame: ${virou}.` };
  }
  if (p.status === 'recusado') {
    const d = ultima('recusado');
    const motivos = d ? [...d.reasons.map((m) => MOTIVO[m] ?? 'outro motivo'), ...(d.comment ? [d.comment] : [])].join('; ') : '';
    const quem = d ? `Recusado por ${quemDecidiu(d, euId)}` : 'Recusado';
    return { icone: 'x', aprovado: false, texto: `${quem}${motivos ? `: “${motivos}”` : ''}. Nada foi executado. O Estrategista guardou o motivo para o próximo plano.` };
  }
  if (p.status === 'nova_analise') {
    const d = ultima('nova_analise');
    const quem = d ? `Nova análise pedida por ${quemDecidiu(d, euId)} ${quandoDecidiu(d.created_at, agora)}${d.comment ? `: “${d.comment}”` : ''}` : 'Nova análise pedida';
    return { icone: 'refresh', aprovado: false, texto: `${quem}. O Estrategista refaz o plano e manda a versão ${p.version + 1} para cá; esta versão não pode mais ser aprovada.` };
  }
  if (p.status === 'expirado') return { icone: 'clock', aprovado: false, texto: 'Expirou sem decisão: nada foi feito. Dá para pedir uma nova análise, e o Estrategista monta uma versão atual.' };
  // Situação que a tela ainda não conhece (V23): diz o que sabe, sem inventar.
  return { icone: 'info', aprovado: false, texto: 'Este plano não espera mais decisão.' };
}

/** O aviso de que a versão aberta não é a que o Estrategista escreveu: quem editou e o que isso muda. Nulo na versão dele. */
export function avisoDaVersao(r: Pick<PlanResponse, 'plan' | 'author' | 'edited_by'>, euId: string): string | null {
  if (r.author !== 'pessoa') return null;
  const quem = r.edited_by ? (r.edited_by.id === euId ? 'Você editou' : `${r.edited_by.name} editou`) : 'Alguém editou';
  const id = identidadeDaVersao(r.plan);
  return `${quem} o plano: agora é a versão ${id.versao} (hash ${id.hash}). A aprovação vale só para esta versão.`;
}

/** "Estrategista propôs · hoje, 10:42 · a pedido de você, na conversa com a LIA". */
export function cabecalhoDoPlano(r: Pick<PlanResponse, 'plan' | 'reanalysis'>, euId: string, agora: Date): { quando: string; origem: string } {
  return { quando: quandoComHora(r.plan.created_at, agora), origem: origemDoPlano(r, euId) };
}

// ------------------------------------------------------------------ decidir

/** A recusa do servidor ao decidir ou editar um plano, em palavras de gente; `recarregar`: o plano mudou por baixo. */
export function erroDoPlano(p: { code: string; detail?: string; title: string }): { texto: string; noCodigo: boolean; recarregar: boolean } {
  if (p.code === 'plano-mudou') return { texto: 'O plano ganhou uma versão nova depois que você abriu. Confira a versão nova antes de decidir.', noCodigo: false, recarregar: true };
  if (p.code === 'plano-nao-aguarda') return { texto: 'Este plano não espera mais decisão: alguém já decidiu.', noCodigo: false, recarregar: true };
  if (p.code === 'plano-expirado') return { texto: 'O plano expirou: ninguém decidiu a tempo. Peça uma nova análise para o Estrategista montar uma versão atual.', noCodigo: false, recarregar: true };
  if (p.code === 'plano-nao-editavel') return { texto: 'Este plano não pode mais ser editado.', noCodigo: false, recarregar: true };
  if (p.code === 'plano-sem-mudanca') return { texto: 'Nada mudou: a versão que você mandou é igual à atual.', noCodigo: false, recarregar: false };
  // O código do app e o segundo fator são os mesmos dos pedidos.
  return erroDaDecisao(p);
}

/** O endereço da tela já aberta num plano (o cartão da conversa e o Resumo). */
export function enderecoDoPlano(id: string): string {
  return `/aprovacoes?plano=${id}`;
}

// ------------------------------------------------------------------ editar: a versão nova, a partir da aberta

/** O risco e o porquê dele quando a pessoa muda a verba: sai das contas, como a frase da verba. */
function riscoDaVerba(b: Noventa['budget']): Pick<Noventa, 'risk' | 'risk_reason'> {
  const d = b.proposal.meta + b.proposal.google - (b.today.meta + b.today.google);
  if (d > 0) return { risk: 'medio', risk_reason: `pede ${reais(d)} a mais por mês do que hoje. Nada é executado por aqui: quem muda a verba é quem cuida das campanhas.` };
  if (d < 0) return { risk: 'baixo', risk_reason: 'o total por mês cai, e nada é executado por aqui.' };
  if (b.proposal.meta === b.today.meta) return { risk: 'baixo', risk_reason: 'a verba fica como está, e nada é executado por aqui.' };
  return { risk: 'baixo', risk_reason: 'o total por mês fica igual: só muda a divisão entre a Meta e o Google. Nada é executado por aqui.' };
}

/** O plano de 90 dias com outra verba proposta. O risco acompanha a conta (pede mais verba: médio). */
export function comVerba(c: Noventa, meta: number, google: number): Noventa {
  const budget = { today: c.budget.today, proposal: { meta, google } };
  return { ...c, budget, ...riscoDaVerba(budget) };
}

/** Reais inteiros, e um total maior que zero. */
export function erroDaVerba(meta: number, google: number): string | null {
  const ok = (n: number) => Number.isInteger(n) && n >= 0 && n <= 10_000_000;
  return ok(meta) && ok(google) && meta + google > 0 ? null : 'Use reais inteiros, e um total maior que zero.';
}

/** A pauta com outro item em cada dia (os dias não mudam). */
export function comDias(c: Pauta, itens: string[]): Pauta {
  return { ...c, days: c.days.map((d, i) => ({ day: d.day, item: (itens[i] ?? d.item).trim() })) };
}

export function erroDaPauta(itens: string[]): string | null {
  return itens.some((t) => !t.trim()) ? 'Cada dia precisa de um item. Para um dia sem nada, escreva “nada novo”.' : null;
}

export interface CamposDaOferta {
  oferta: string;
  inicio: string;
  fim: string;
  texto: string;
}

/** A oferta com outro texto, outro horário ou outro texto de anúncio. */
export function comOferta(c: Oferta, campos: CamposDaOferta): Oferta {
  return { ...c, offer: campos.oferta.trim(), starts_at: campos.inicio, ends_at: campos.fim, ad_text: campos.texto.trim() };
}

/** `batidas`: quantas regras o texto do anúncio bate agora (a conferência é do servidor). */
export function erroDaOferta(campos: CamposDaOferta, batidas: number): string | null {
  if (!campos.oferta.trim() || !campos.texto.trim() || !campos.inicio || !campos.fim) return 'Preencha a oferta, o horário e o texto do anúncio.';
  if (campos.fim <= campos.inicio) return 'O fim precisa ser depois do começo.';
  return batidas ? 'O texto do anúncio bate numa regra e não passa assim.' : null;
}

/** A versão editada é igual à aberta? (os campos do tipo, na ordem em que a tela os mostra) */
export function mesmoConteudo(a: PlanContent, b: PlanContent): boolean {
  const campos = (c: PlanContent): unknown[] =>
    c.kind === 'noventa_dias' ? [c.budget.proposal.meta, c.budget.proposal.google] : c.kind === 'pauta' ? c.days.map((d) => d.item) : [c.offer, c.starts_at, c.ends_at, c.ad_text];
  const x = campos(a);
  const y = campos(b);
  return a.kind === b.kind && x.length === y.length && x.every((v, i) => v === y[i]);
}
