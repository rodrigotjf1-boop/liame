// Pacote comum do Padrão DMS de integração (docs/padrao-dms-integracao.md).
//
// Fonte única: repositório hub-dms, arquivo pacote/integracao-dms.ts. Cada produto guarda uma CÓPIA deste arquivo
// (ADR-002). Não edite a cópia: mude aqui, rode os testes (`npm test` no hub) e copie de novo. `VERSAO_PACOTE` diz
// qual versão a cópia é.
//
// Sem dependência: só o Node (22 ou mais). Escrito para compilar como CommonJS (NestJS 10) e como ESM (Liame), e para
// rodar direto no Node sem compilar: nada de enum, namespace nem propriedade declarada no construtor.

import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify as conferirAssinatura, type JsonWebKey, type KeyObject } from 'node:crypto';
import { isIP } from 'node:net';

export const VERSAO_PACOTE = '0.2.1';

const DIA_MS = 86_400_000;

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// 1. Produtos e classes (Padrão §1)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const PRODUTOS = ['regem', 'regemcast', 'liame', 'farol', 'gogem', 'regemboard', 'orzuni', 'muraljob'] as const;
export type Produto = (typeof PRODUTOS)[number];

export function ehProduto(v: unknown): v is Produto {
  return typeof v === 'string' && (PRODUTOS as readonly string[]).includes(v);
}

/** `dms` = produto DMS (lista no código do produto); `parceiro` = software de outra empresa; `proprio` = programa do cliente. */
export type Classe = 'dms' | 'parceiro' | 'proprio';

/**
 * As permissões que valem de fato: as gravadas no banco que o TETO da classe permite. O teto fica no código do
 * produto; permissão gravada que a classe não pode ter não vira permissão (herdado do RegemCast). A ordem é a do teto.
 */
export function permissoesEfetivas<P extends string>(
  classe: Classe,
  gravadas: readonly string[],
  teto: Readonly<Record<Classe, readonly P[]>>,
): P[] {
  const permitidas = teto[classe] ?? [];
  return permitidas.filter((p) => gravadas.includes(p));
}

/** De onde veio um texto que um agente vai ler. */
export type OrigemConteudo = Classe | 'pessoa_da_loja' | 'terceiro';

/**
 * Ação de risco (R2: mensagem a cliente; R3: dinheiro) disparada a partir de um texto só roda sem aprovação de pessoa
 * se o texto veio de um produto DMS ou de alguém da própria loja (Padrão §8).
 */
export function riscoPedeAprovacao(origem: OrigemConteudo): boolean {
  return origem !== 'dms' && origem !== 'pessoa_da_loja';
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// 2. Chaves e segredos (Padrão §2.3 e §2.4)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** `ap` = chave do acesso próprio; `lg` = segredo da ligação. */
export type TipoChave = 'ap' | 'lg';

const FORMATO_CHAVE = /^dms_(ap|lg)_([a-z]+)_([A-Za-z0-9_-]{43})_([A-Za-z0-9_-]{6})$/;
const TAMANHO_MAXIMO_CHAVE = 120;

function digitosDeConferencia(corpo: string): string {
  return createHash('sha256').update(corpo, 'utf8').digest('base64url').slice(0, 6);
}

/** SHA-256 (hex) da chave inteira: é só isto que o banco guarda. */
export function resumoChave(chave: string): string {
  return createHash('sha256').update(chave, 'utf8').digest('hex');
}

/** O tipo, o produto e 5 caracteres: o bastante para reconhecer a chave na tela, sem dar a chave. */
export function prefixoVisivel(chave: string): string {
  const m = /^dms_(?:ap|lg)_[a-z]+_/.exec(chave);
  return m ? chave.slice(0, m[0].length + 5) : '';
}

/** Gera uma chave nova. A chave em claro aparece uma vez; guarde só `resumo` e `prefixo`. */
export function gerarChave(tipo: TipoChave, produto: Produto): { chave: string; resumo: string; prefixo: string } {
  if (tipo !== 'ap' && tipo !== 'lg') throw new TypeError(`Tipo de chave desconhecido: ${String(tipo)}`);
  if (!ehProduto(produto)) throw new TypeError(`Produto desconhecido: ${String(produto)}`);
  const corpo = randomBytes(32).toString('base64url');
  const chave = `dms_${tipo}_${produto}_${corpo}_${digitosDeConferencia(corpo)}`;
  return { chave, resumo: resumoChave(chave), prefixo: prefixoVisivel(chave) };
}

/**
 * Lê uma chave SEM ir ao banco: formato, produto conhecido e dígitos de conferência. O que não passa aqui nem é
 * procurado (chave digitada errada, colada pela metade, inventada).
 */
export function lerChave(texto: unknown): { tipo: TipoChave; produto: Produto } | null {
  if (typeof texto !== 'string' || texto.length > TAMANHO_MAXIMO_CHAVE) return null;
  const m = FORMATO_CHAVE.exec(texto);
  if (!m) return null;
  const [, tipo, produto, corpo, conferencia] = m;
  if (!tipo || !corpo || !conferencia || !ehProduto(produto)) return null;
  if (digitosDeConferencia(corpo) !== conferencia) return null;
  return { tipo: tipo as TipoChave, produto };
}

/** Confere a chave apresentada contra o resumo guardado, em tempo constante. */
export function chaveConfere(chave: string, resumoGuardado: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(resumoGuardado)) return false;
  return timingSafeEqual(Buffer.from(resumoChave(chave), 'hex'), Buffer.from(resumoGuardado, 'hex'));
}

/** As regras do acesso próprio aprovadas pelo dono em 14/10/2026 (Padrão §2.4). */
export const POLITICA_CHAVE_PROPRIA = Object.freeze({
  validadeMeses: 12,
  avisoAntesDias: 15,
  sobreposicaoNaTrocaDias: 7,
  suspensaoSemUsoDias: 90,
  maximoAtivasPorEmpresaEProduto: 10,
});

/** Ligação de software de parceiro parada há 90 dias é suspensa (Padrão §3). */
export const POLITICA_LIGACAO = Object.freeze({ suspensaoParadaDias: 90 });

/** Soma meses no calendário (31/01 + 1 mês = 28 ou 29/02), em UTC. */
export function somarMeses(data: Date, meses: number): Date {
  const ano = data.getUTCFullYear();
  const mes = data.getUTCMonth() + meses;
  const ultimoDia = new Date(Date.UTC(ano, mes + 1, 0)).getUTCDate();
  const r = new Date(data.getTime());
  r.setUTCFullYear(ano, mes, Math.min(data.getUTCDate(), ultimoDia));
  return r;
}

/** Quando vence uma chave criada agora. */
export function vencimentoPadrao(criadaEm: Date): Date {
  return somarMeses(criadaEm, POLITICA_CHAVE_PROPRIA.validadeMeses);
}

/** Na troca (renovação), a chave antiga passa a vencer daqui a 7 dias, para dar tempo de trocar no programa. */
export function vencimentoDaAntigaNaTroca(agora: Date): Date {
  return new Date(agora.getTime() + POLITICA_CHAVE_PROPRIA.sobreposicaoNaTrocaDias * DIA_MS);
}

export type RegistroChave = {
  criadaEm: Date;
  venceEm: Date | null;
  revogadaEm: Date | null;
  ultimoUsoEm: Date | null;
  /** Reativar uma chave suspensa conta como uso. */
  reativadaEm?: Date | null;
};

export type SituacaoChave = 'valida' | 'revogada' | 'vencida' | 'suspensa';

function maisRecente(...datas: (Date | null | undefined)[]): Date {
  let r = 0;
  for (const d of datas) if (d && d.getTime() > r) r = d.getTime();
  return new Date(r);
}

/**
 * A situação de uma chave (ou de uma ligação de parceiro, com `suspensaoDias` = 90 da `POLITICA_LIGACAO`).
 * `avisarVencimento` = falta 15 dias ou menos para vencer.
 */
export function situacaoChave(
  r: RegistroChave,
  agora: Date,
  suspensaoDias: number = POLITICA_CHAVE_PROPRIA.suspensaoSemUsoDias,
): { situacao: SituacaoChave; avisarVencimento: boolean } {
  const t = agora.getTime();
  if (r.revogadaEm && r.revogadaEm.getTime() <= t) return { situacao: 'revogada', avisarVencimento: false };
  if (r.venceEm && r.venceEm.getTime() <= t) return { situacao: 'vencida', avisarVencimento: false };
  const ultimaAtividade = maisRecente(r.ultimoUsoEm, r.reativadaEm, r.criadaEm);
  if (t - ultimaAtividade.getTime() >= suspensaoDias * DIA_MS) return { situacao: 'suspensa', avisarVencimento: false };
  const avisar = !!r.venceEm && r.venceEm.getTime() - t <= POLITICA_CHAVE_PROPRIA.avisoAntesDias * DIA_MS;
  return { situacao: 'valida', avisarVencimento: avisar };
}

/** Até 10 chaves ativas por empresa em cada produto. */
export function podeCriarChave(ativasNaEmpresaEProduto: number): boolean {
  return ativasNaEmpresaEProduto < POLITICA_CHAVE_PROPRIA.maximoAtivasPorEmpresaEProduto;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// 3. Erros RFC 9457 (Padrão §7)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const BASE_ERROS = 'https://dev.dmstecnologias.com/erros/';
export const TIPO_CONTEUDO_PROBLEMA = 'application/problem+json';

/** Nome do problema → [status padrão, título]. Os 16 primeiros vêm do Regem; os 5 últimos são novos. */
export const PROBLEMAS = {
  'token-invalido': [401, 'Token inválido'],
  'escopo-insuficiente': [403, 'Escopo insuficiente'],
  'conta-bloqueada': [403, 'Conta bloqueada'],
  'limite-de-chamadas': [429, 'Limite de chamadas'],
  'parametro-invalido': [400, 'Parâmetro inválido'],
  'cursor-invalido': [400, 'Cursor inválido'],
  'nao-encontrado': [404, 'Não encontrado'],
  'codigo-em-uso': [409, 'Código em uso'],
  'chave-em-uso': [409, 'Chave de idempotência em uso'],
  'regra-invalida': [422, 'Regra inválida'],
  'chave-reutilizada': [422, 'Chave de idempotência reutilizada'],
  'cliente-invalido': [401, 'Cliente inválido'],
  'autorizacao-invalida': [400, 'Autorização inválida'],
  'endereco-nao-permitido': [422, 'Endereço não permitido'],
  'aviso-indisponivel': [503, 'Avisos indisponíveis'],
  'erro-interno': [500, 'Erro interno'],
  'ligacao-invalida': [401, 'Ligação inválida'],
  'ligacao-suspensa': [403, 'Ligação suspensa'],
  'chave-vencida': [401, 'Chave vencida'],
  'chave-suspensa': [403, 'Chave suspensa'],
  'fonte-inativa': [409, 'Fonte inativa'],
} as const satisfies Record<string, readonly [number, string]>;

export type TipoProblema = keyof typeof PROBLEMAS;

export function ehTipoProblema(v: unknown): v is TipoProblema {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(PROBLEMAS, v);
}

/** Erro com o nome do problema do Padrão. O adaptador de cada produto transforma em resposta. */
export class ErroProblema extends Error {
  readonly tipo: TipoProblema;
  readonly status: number;
  readonly detalhe: string;
  readonly retryAfterSeg: number | undefined;

  constructor(tipo: TipoProblema, detalhe: string, opcoes: { status?: number; retryAfterSeg?: number } = {}) {
    super(detalhe);
    this.name = 'ErroProblema';
    this.tipo = tipo;
    this.status = opcoes.status ?? PROBLEMAS[tipo][0];
    this.detalhe = detalhe;
    this.retryAfterSeg = opcoes.retryAfterSeg;
  }
}

export type CorpoProblema = { type: string; title: string; status: number; detail: string; request_id?: string };

/** O corpo `application/problem+json`. `detail` em pt-BR, dizendo como resolver. */
export function corpoProblema(
  tipo: TipoProblema,
  detalhe: string,
  opcoes: { status?: number; requestId?: string | null; base?: string } = {},
): CorpoProblema {
  const corpo: CorpoProblema = {
    type: (opcoes.base ?? BASE_ERROS) + tipo,
    title: PROBLEMAS[tipo][1],
    status: opcoes.status ?? PROBLEMAS[tipo][0],
    detail: detalhe,
  };
  if (opcoes.requestId) corpo.request_id = opcoes.requestId;
  return corpo;
}

/** O problema de uma chave que não está válida. Revogada responde igual a inexistente (Padrão §7). */
export function problemaDaSituacao(situacao: Exclude<SituacaoChave, 'valida'>): ErroProblema {
  if (situacao === 'vencida') return new ErroProblema('chave-vencida', 'A chave venceu. Gere outra na tela de integrações do produto.');
  if (situacao === 'suspensa') {
    return new ErroProblema('chave-suspensa', 'A chave foi suspensa por falta de uso. O dono da conta reativa na tela de integrações.');
  }
  return new ErroProblema('token-invalido', 'Credencial ausente, inválida ou revogada.');
}

/**
 * O cabeçalho `WWW-Authenticate` das respostas 401 e 403. Na porta MCP, `metadadosRecurso` é obrigatório e, no 403,
 * `escopos` leva TODAS as permissões que faltam de uma vez (especificação MCP 2026-07-28).
 */
export function cabecalhoWwwAuthenticate(
  o: { erro?: 'invalid_token' | 'insufficient_scope'; escopos?: readonly string[]; metadadosRecurso?: string } = {},
): string {
  const partes: string[] = [];
  if (o.metadadosRecurso) partes.push(`resource_metadata="${o.metadadosRecurso.replace(/["\\]/g, '')}"`);
  if (o.erro) partes.push(`error="${o.erro}"`);
  if (o.escopos && o.escopos.length) partes.push(`scope="${o.escopos.join(' ').replace(/["\\]/g, '')}"`);
  return partes.length ? `Bearer ${partes.join(', ')}` : 'Bearer';
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// 4. Idempotência (Padrão §5 e §6)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const VALIDADE_IDEMPOTENCIA_HORAS = 24;

/** REST: cabeçalho `Idempotency-Key`, de 1 a 255 caracteres visíveis (ASCII 33 a 126), sem espaço. */
export function chaveIdempotenciaRestValida(v: unknown): v is string {
  return typeof v === 'string' && /^[\x21-\x7E]{1,255}$/.test(v);
}

/** MCP: argumento `chaveIdempotencia`, de 8 a 100 caracteres visíveis (herdado do RegemCast). */
export function chaveIdempotenciaMcpValida(v: unknown): v is string {
  return typeof v === 'string' && /^[\x21-\x7E]{8,100}$/.test(v);
}

/** JSON com as chaves dos objetos em ordem: o mesmo pedido dá sempre o mesmo texto. */
export function jsonCanonico(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    const t = JSON.stringify(v);
    return t === undefined ? 'null' : t;
  }
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : jsonCanonico(x))).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const partes = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${jsonCanonico(obj[k])}`);
  return `{${partes.join(',')}}`;
}

/**
 * A impressão de um pedido: método, caminho e corpo. A mesma chave de idempotência com OUTRA impressão é recusada
 * (`chave-reutilizada`); com a mesma, devolve a resposta guardada inteira (LIC-042).
 */
export function impressaoPedido(metodo: string, caminho: string, corpo: unknown): string {
  return createHash('sha256')
    .update(`${metodo.toUpperCase()}\n${caminho}\n${jsonCanonico(corpo ?? null)}`, 'utf8')
    .digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// 5. Limite de chamadas (Padrão §5)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Janela fixa em memória, por chave (ligação, chave própria ou empresa). Vale por processo: com mais de uma cópia do
 * serviço, cada uma conta a sua, e o produto que precisar de conta única troca por um armazenamento compartilhado.
 */
export class JanelaFixa {
  private readonly limite: number;
  private readonly janelaMs: number;
  private readonly relogio: () => number;
  private readonly contagens = new Map<string, { inicio: number; usadas: number }>();

  constructor(limitePorJanela: number, janelaMs: number = 60_000, relogio: () => number = Date.now) {
    if (!Number.isInteger(limitePorJanela) || limitePorJanela < 1) throw new RangeError('O limite precisa ser um inteiro positivo.');
    this.limite = limitePorJanela;
    this.janelaMs = janelaMs;
    this.relogio = relogio;
  }

  /** Conta uma chamada. `ok:false` → responder 429 com `Retry-After: retryAfterSeg`. */
  contar(chave: string): { ok: boolean; restante: number; retryAfterSeg: number } {
    const agora = this.relogio();
    let c = this.contagens.get(chave);
    if (!c || agora - c.inicio >= this.janelaMs) {
      c = { inicio: agora, usadas: 0 };
      this.contagens.set(chave, c);
      if (this.contagens.size > 10_000) this.limpar(agora);
    }
    const retryAfterSeg = Math.max(1, Math.ceil((c.inicio + this.janelaMs - agora) / 1000));
    if (c.usadas >= this.limite) return { ok: false, restante: 0, retryAfterSeg };
    c.usadas += 1;
    return { ok: true, restante: this.limite - c.usadas, retryAfterSeg };
  }

  private limpar(agora: number): void {
    for (const [k, c] of this.contagens) if (agora - c.inicio >= this.janelaMs) this.contagens.delete(k);
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// 6. Cursor opaco (Padrão §5; generalizado de cursor-integracao.ts do Regem)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type PosicaoCursor = { t: string; i: string } | null;

const INSTANTE_US = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAMANHO_MAXIMO_CURSOR = 1000;

/** O vínculo do cursor com a empresa e a loja (resumo curto: não revela os ids). */
export function vinculoCursor(empresaId: string, lojaId: string | null): string {
  return createHash('sha256').update(`${empresaId}:${lojaId ?? 'empresa'}`, 'utf8').digest('base64url').slice(0, 16);
}

/**
 * Cursor preso à rota e ao vínculo, com a posição (carimbo com microssegundos e id). `extra` guarda valores curtos
 * da carga inicial (como o `desde`). Nada disso é segredo: o filtro de empresa e loja vem SEMPRE da credencial.
 */
export function codificarCursor(
  rota: string,
  vinculo: string,
  posicao: PosicaoCursor,
  extra: Readonly<Record<string, string | null>> = {},
): string {
  const corpo = { k: rota, l: vinculo, t: posicao ? posicao.t : null, i: posicao ? posicao.i : null, x: extra };
  return Buffer.from(JSON.stringify(corpo), 'utf8').toString('base64url');
}

function cursorInvalido(): never {
  throw new ErroProblema('cursor-invalido', 'Cursor inválido para esta rota e esta loja. Recomece sem cursor.');
}

/** Lê o cursor devolvido pelo cliente. Qualquer coisa fora do formato → 400 `cursor-invalido`. */
export function lerCursor(
  texto: unknown,
  rota: string,
  vinculo: string,
): { posicao: PosicaoCursor; extra: Record<string, string | null> } {
  // A regex é ancorada e de uma classe de caracteres só, sem repetição aninhada: tempo linear, sem retrocesso
  // catastrófico; e o tamanho já passou pelo teto (TAMANHO_MAXIMO_CURSOR) antes dela.
  // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos
  if (typeof texto !== 'string' || !texto || texto.length > TAMANHO_MAXIMO_CURSOR || !/^[A-Za-z0-9_-]+$/.test(texto)) cursorInvalido();
  let corpo: unknown;
  try {
    corpo = JSON.parse(Buffer.from(texto, 'base64url').toString('utf8'));
  } catch {
    cursorInvalido();
  }
  if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) cursorInvalido();
  const c = corpo as Record<string, unknown>;
  if (c.k !== rota || c.l !== vinculo) cursorInvalido();
  const temT = c.t !== null && c.t !== undefined;
  const temI = c.i !== null && c.i !== undefined;
  if (temT !== temI) cursorInvalido();
  if (temT && (typeof c.t !== 'string' || !INSTANTE_US.test(c.t))) cursorInvalido();
  if (temI && (typeof c.i !== 'string' || !UUID.test(c.i))) cursorInvalido();
  const x = c.x ?? {};
  if (!x || typeof x !== 'object' || Array.isArray(x)) cursorInvalido();
  const extra: Record<string, string | null> = {};
  const entradas = Object.entries(x as Record<string, unknown>);
  if (entradas.length > 5) cursorInvalido();
  for (const [k, v] of entradas) {
    if (!/^[a-z_]{1,20}$/.test(k) || (v !== null && (typeof v !== 'string' || v.length > 100))) cursorInvalido();
    extra[k] = v as string | null;
  }
  const posicao = temT ? { t: c.t as string, i: (c.i as string).toLowerCase() } : null;
  return { posicao, extra };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// 7. Avisos — Standard Webhooks (Padrão §9; assinatura herdada de webhook-integracao.ts do Regem)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const PREFIXO_SEGREDO_AVISO = 'whsec_';

/** Segredo novo de aviso: `whsec_` + 32 bytes em base64. Um por ligação. */
export function gerarSegredoAviso(): string {
  return PREFIXO_SEGREDO_AVISO + randomBytes(32).toString('base64');
}

/** Os bytes do segredo `whsec_<base64>` (24 a 64 bytes), ou `null` se o formato não serve. */
export function chaveDoSegredoAviso(segredo: unknown): Buffer | null {
  if (typeof segredo !== 'string' || !segredo.startsWith(PREFIXO_SEGREDO_AVISO)) return null;
  const b64 = segredo.slice(PREFIXO_SEGREDO_AVISO.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const chave = Buffer.from(b64, 'base64');
  return chave.length >= 24 && chave.length <= 64 ? chave : null;
}

/** `v1,` + HMAC-SHA256 (base64) de `id.timestamp.corpo`. */
export function assinarAviso(chave: Buffer, id: string, timestampSeg: number, corpo: string): string {
  return `v1,${createHmac('sha256', chave).update(`${id}.${timestampSeg}.${corpo}`, 'utf8').digest('base64')}`;
}

export type CabecalhosAviso = { 'webhook-id': string; 'webhook-timestamp': string; 'webhook-signature': string };

/** Os três cabeçalhos de um aviso. O corpo vai como está (o mesmo texto que foi assinado). */
export function cabecalhosAviso(segredo: string, id: string, corpo: string, agora: Date = new Date()): CabecalhosAviso {
  const chave = chaveDoSegredoAviso(segredo);
  if (!chave) throw new TypeError('Segredo de aviso fora do formato whsec_.');
  const ts = Math.floor(agora.getTime() / 1000);
  return { 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': assinarAviso(chave, id, ts, corpo) };
}

/**
 * Confere um aviso recebido: assinatura certa (aceita várias, separadas por espaço, para a troca de segredo) e
 * horário dentro da tolerância (5 minutos), contra repetição de aviso antigo.
 */
export function conferirAviso(
  segredo: string,
  cabecalhos: Partial<Record<keyof CabecalhosAviso, string | undefined>>,
  corpo: string,
  agora: Date = new Date(),
  toleranciaSeg: number = 300,
): boolean {
  const chave = chaveDoSegredoAviso(segredo);
  const id = cabecalhos['webhook-id'];
  const tsTexto = cabecalhos['webhook-timestamp'];
  const assinaturas = cabecalhos['webhook-signature'];
  if (!chave || !id || !tsTexto || !assinaturas || !/^\d{1,12}$/.test(tsTexto)) return false;
  const ts = Number(tsTexto);
  if (Math.abs(Math.floor(agora.getTime() / 1000) - ts) > toleranciaSeg) return false;
  const esperada = Buffer.from(assinarAviso(chave, id, ts, corpo), 'utf8');
  return assinaturas.split(' ').some((a) => {
    const recebida = Buffer.from(a, 'utf8');
    return recebida.length === esperada.length && timingSafeEqual(recebida, esperada);
  });
}

/**
 * O destino de um aviso está dentro da lista aprovada do aplicativo? Só HTTPS, na porta padrão, sem usuário e senha,
 * sem pergunta (`?`) nem fragmento, mesma origem de uma base da lista e o caminho = o caminho da base + UM trecho
 * (o id da ligação no aplicativo). Comparado com `new URL()`, nunca pelo começo do texto (LIC-119).
 */
export function destinoAvisoPermitido(endereco: unknown, bases: readonly string[]): boolean {
  if (typeof endereco !== 'string' || endereco.length > 2048) return false;
  let u: URL;
  try {
    u = new URL(endereco);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.port !== '' || u.username || u.password || u.search || u.hash) return false;
  for (const textoBase of bases) {
    let b: URL;
    try {
      b = new URL(textoBase);
    } catch {
      continue;
    }
    if (b.protocol !== 'https:' || b.origin !== u.origin) continue;
    const caminhoBase = b.pathname.endsWith('/') ? b.pathname : b.pathname + '/';
    if (!u.pathname.startsWith(caminhoBase)) continue;
    const resto = u.pathname.slice(caminhoBase.length);
    if (/^[A-Za-z0-9_-]{1,128}$/.test(resto)) return true;
  }
  return false;
}

function ipv4ParaNumero(ip: string): number {
  return ip.split('.').reduce((acc, p) => acc * 256 + Number(p), 0);
}

const FAIXAS_IPV4_INTERNAS: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function ipv4Interno(ip: string): boolean {
  const n = ipv4ParaNumero(ip);
  return FAIXAS_IPV4_INTERNAS.some(([base, bits]) => {
    const mascara = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((n & mascara) >>> 0) === ((ipv4ParaNumero(base) & mascara) >>> 0);
  });
}

type GruposIpv6 = [number, number, number, number, number, number, number, number];

/** Os 8 grupos de 16 bits de um IPv6 (aceita `::` e o final em IPv4, como `::ffff:10.0.0.1`). */
function gruposIpv6(ip: string): GruposIpv6 | null {
  let texto = ip.toLowerCase().split('%')[0] ?? '';
  let finalV4: [number, number] | null = null;
  const ultimoDoisPontos = texto.lastIndexOf(':');
  const cauda = texto.slice(ultimoDoisPontos + 1);
  if (cauda.includes('.')) {
    if (isIP(cauda) !== 4) return null;
    const n = ipv4ParaNumero(cauda);
    finalV4 = [(n >>> 16) & 0xffff, n & 0xffff];
    texto = texto.slice(0, ultimoDoisPontos + 1) + '0:0';
  }
  const [esq, dir, ...demais] = texto.split('::');
  if (demais.length) return null;
  const a = esq ? esq.split(':') : [];
  const b = dir !== undefined ? (dir ? dir.split(':') : []) : null;
  if (b !== null && a.length + b.length > 7) return null; // com `::`, ao menos um grupo é zero
  const total = b === null ? a : [...a, ...Array(8 - a.length - b.length).fill('0'), ...b];
  if (total.length !== 8) return null;
  const grupos = total.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)) as GruposIpv6;
  if (grupos.some((g) => Number.isNaN(g))) return null;
  if (finalV4) {
    grupos[6] = finalV4[0];
    grupos[7] = finalV4[1];
  }
  return grupos;
}

/**
 * O endereço IP é interno, reservado ou de rede local? Quem envia o aviso resolve o nome do destino, recusa se
 * QUALQUER endereço resolvido for interno e conecta no endereço que conferiu (Padrão §9). Texto que não é IP → true.
 */
export function enderecoInterno(ip: string): boolean {
  const versao = isIP(ip.split('%')[0] ?? '');
  if (versao === 4) return ipv4Interno(ip);
  if (versao !== 6) return true;
  const g = gruposIpv6(ip);
  if (!g) return true;
  const zerosAte = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zerosAte(8)) return true; // ::
  if (zerosAte(7) && g[7] === 1) return true; // ::1
  const v4Embutido = () => `${g[6] >>> 8}.${g[6] & 0xff}.${g[7] >>> 8}.${g[7] & 0xff}`;
  if (zerosAte(5) && g[5] === 0xffff) return ipv4Interno(v4Embutido()); // ::ffff:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return ipv4Interno(v4Embutido()); // 64:ff9b::/96
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // 2001:db8::/32
  if (g[0] === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return true; // 100::/64
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// 8. O token do DMS ID, a ligação e o cliente pronto (Padrão §2.1; decisões F2-1 e F2-4 de 15/10/2026)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
//
// O token do DMS ID diz QUAL APLICATIVO chama; o segredo da ligação (`DMS-Ligacao: dms_lg_…`) diz qual conta autorizou.
// O produto confere os dois e que a ligação é daquele aplicativo: vazar um só não abre nada. O token é conferido NO
// produto, com as chaves públicas do DMS ID guardadas — o produto não chama o DMS ID a cada pedido.
//
// Forma conferida no Logto 1.44 (15/10/2026): assinatura ES384 (chave EC P-384), cabeçalho `typ: at+jwt` com `kid`;
// campos `iss` (`<endereço>/oidc`), `aud` (texto: o produto), `sub` = `client_id`, `scope` (separado por espaço),
// `exp`, `iat`, `jti`. O Logto emite token para QUALQUER destino, mesmo sem permissão lá (`scope` vazio): por isso o
// produto exige a permissão, nunca só o destino (prova, P1).

/** O cabeçalho do segredo da ligação, na REST e na MCP entre produtos DMS. Nome de cabeçalho é só ASCII: sem cedilha. */
export const CABECALHO_LIGACAO = 'DMS-Ligacao';

/**
 * Assinaturas aceitas: as duas que o Logto usa — ES384 (a chave EC P-384 de fábrica) e RS256 (se a chave for trocada
 * para RSA). `none`, as de segredo (HS*) e qualquer outra, nunca.
 */
const ASSINATURAS = {
  ES384: { hash: 'sha384', tipo: 'ec' },
  RS256: { hash: 'sha256', tipo: 'rsa' },
} as const;
type Assinatura = keyof typeof ASSINATURAS;

/** Lê um pedaço base64url de JSON. Nulo = não é JSON de objeto. */
function jsonDoPedaco(pedaco: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(Buffer.from(pedaco, 'base64url').toString('utf8'));
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export type OpcoesChavesDmsId = {
  /** O endereço das chaves públicas do DMS ID (`<emissor>/jwks`). */
  jwks: string;
  buscar?: typeof fetch;
  /** Depois disso, as chaves guardadas são buscadas de novo (padrão: 10 minutos). */
  validadeMs?: number;
  /** Intervalo mínimo entre duas buscas, para um `kid` inventado não virar enxurrada no DMS ID (padrão: 30 s). */
  intervaloMinimoMs?: number;
  tempoLimiteMs?: number;
  relogio?: () => number;
};

/**
 * As chaves públicas do DMS ID, guardadas. Busca de novo quando ficam velhas ou quando chega um `kid` que não conhece
 * (a troca de chave). Se o DMS ID não responde, segue com as que tem: o token já emitido continua conferível. A chave
 * que saiu do DMS ID sai daqui na busca seguinte que der certo.
 */
export class ChavesDmsId {
  private readonly jwks: string;
  private readonly buscar: typeof fetch;
  private readonly validadeMs: number;
  private readonly intervaloMinimoMs: number;
  private readonly tempoLimiteMs: number;
  private readonly relogio: () => number;
  private chaves = new Map<string, KeyObject>();
  private buscadoEm = Number.NEGATIVE_INFINITY;
  private tentadoEm = Number.NEGATIVE_INFINITY;
  private emCurso: Promise<void> | null = null;

  constructor(o: OpcoesChavesDmsId) {
    this.jwks = o.jwks;
    this.buscar = o.buscar ?? fetch;
    this.validadeMs = o.validadeMs ?? 600_000;
    this.intervaloMinimoMs = o.intervaloMinimoMs ?? 30_000;
    this.tempoLimiteMs = o.tempoLimiteMs ?? 3_000;
    this.relogio = o.relogio ?? Date.now;
  }

  /** A chave de um `kid`, ou nulo se o DMS ID não a publica (nem publicou da última vez que respondeu). */
  async chave(kid: string): Promise<KeyObject | null> {
    // Uma busca em andamento (a primeira, na subida, ou a de um kid novo): espera por ela antes de decidir.
    if (this.emCurso) await this.emCurso;
    const agora = this.relogio();
    const velha = agora - this.buscadoEm >= this.validadeMs;
    if (this.chaves.has(kid) && !velha) return this.chaves.get(kid) ?? null;
    if (agora - this.tentadoEm >= this.intervaloMinimoMs) await this.atualizar();
    return this.chaves.get(kid) ?? null;
  }

  private atualizar(): Promise<void> {
    this.tentadoEm = this.relogio();
    this.emCurso = this.buscarChaves().finally(() => {
      this.emCurso = null;
    });
    return this.emCurso;
  }

  private async buscarChaves(): Promise<void> {
    try {
      const r = await this.buscar(this.jwks, { signal: AbortSignal.timeout(this.tempoLimiteMs) });
      if (!r.ok) return;
      const corpo = (await r.json()) as { keys?: unknown };
      if (!Array.isArray(corpo.keys)) return;
      const novas = new Map<string, KeyObject>();
      for (const k of corpo.keys as Array<Record<string, unknown>>) {
        if (typeof k.kid !== 'string' || (k.use !== undefined && k.use !== 'sig')) continue;
        // chave simétrica (`oct`) ou quebrada não se lê como pública e fica de fora; a de outro tipo (Ed25519) é lida, mas
        // a conferência do token exige o tipo da assinatura (`asymmetricKeyType`)
        try {
          novas.set(k.kid, createPublicKey({ key: k as JsonWebKey, format: 'jwk' }));
        } catch {
          // chave que não se lê fica de fora; as outras valem
        }
      }
      if (novas.size === 0) return;
      this.chaves = novas;
      this.buscadoEm = this.relogio();
    } catch {
      // DMS ID fora do ar ou lento: seguem as chaves guardadas
    }
  }
}

/** O token que não vale. A resposta é a mesma para todo motivo (Padrão §7); o `motivo` é só para o registro local. */
export class ErroTokenDmsId extends ErroProblema {
  readonly motivo: string;

  constructor(motivo: string) {
    super('token-invalido', 'Token do DMS ID ausente, inválido ou vencido. Peça outro ao DMS ID.');
    this.name = 'ErroTokenDmsId';
    this.motivo = motivo;
  }
}

/** Falta permissão no token. `faltando` traz TODAS de uma vez, para o `WWW-Authenticate` da porta MCP. */
export class ErroPermissaoFaltando extends ErroProblema {
  readonly faltando: string[];

  constructor(faltando: readonly string[]) {
    super('escopo-insuficiente', `Falta a permissão: ${faltando.join(', ')}.`);
    this.name = 'ErroPermissaoFaltando';
    this.faltando = [...faltando];
  }
}

export type TokenDmsId = {
  /** O aplicativo que chama (`client_id`). */
  aplicativo: string;
  permissoes: string[];
  expiraEm: Date;
};

export type OpcoesTokenDmsId = {
  chaves: ChavesDmsId;
  /** O `iss` esperado: o endereço do DMS ID com `/oidc` (ex.: `https://id.dmstecnologias.com/oidc`). */
  emissor: string;
  /** O `aud` esperado: o identificador do produto que confere (o recurso cadastrado no DMS ID). */
  destino: string;
  /** As permissões que a chamada exige. Falta uma: 403 com todas as que faltam. */
  exigidas?: readonly string[];
  agora?: Date;
  /** Folga para relógios desencontrados (padrão: 30 s). */
  folgaSeg?: number;
};

/**
 * Confere o token do DMS ID: a forma, a assinatura (com a chave do `kid`), o emissor, o destino, a validade e as
 * permissões exigidas. Token que não vale → `ErroTokenDmsId` (401); falta permissão → `ErroPermissaoFaltando` (403).
 * Não confere a ligação: isso é do produto, com o segredo da ligação (`lerChave`, `resumoChave`) e
 * `permissoesDaChamada`.
 */
export async function conferirTokenDmsId(token: unknown, o: OpcoesTokenDmsId): Promise<TokenDmsId> {
  if (typeof token !== 'string' || token.length === 0 || token.length > 8192) throw new ErroTokenDmsId('ausente ou grande demais');
  const partes = token.split('.');
  if (partes.length !== 3) throw new ErroTokenDmsId('não é JWS compacto');
  const [cabecaTexto, corpoTexto, assinaturaTexto] = partes as [string, string, string];
  const cabeca = jsonDoPedaco(cabecaTexto);
  const corpo = jsonDoPedaco(corpoTexto);
  if (!cabeca || !corpo) throw new ErroTokenDmsId('cabeçalho ou corpo ilegível');
  if (typeof cabeca.alg !== 'string' || !Object.prototype.hasOwnProperty.call(ASSINATURAS, cabeca.alg)) throw new ErroTokenDmsId('assinatura não aceita');
  if (typeof cabeca.typ !== 'string' || cabeca.typ.toLowerCase() !== 'at+jwt') throw new ErroTokenDmsId('não é token de acesso');
  if (typeof cabeca.kid !== 'string' || cabeca.kid.length === 0) throw new ErroTokenDmsId('sem kid');

  const assinatura = ASSINATURAS[cabeca.alg as Assinatura];
  const chave = await o.chaves.chave(cabeca.kid);
  if (!chave) throw new ErroTokenDmsId('kid desconhecido');
  if (chave.asymmetricKeyType !== assinatura.tipo) throw new ErroTokenDmsId('chave de outro tipo');
  const dados = Buffer.from(`${cabecaTexto}.${corpoTexto}`, 'ascii');
  const valida = conferirAssinatura(
    assinatura.hash,
    dados,
    assinatura.tipo === 'ec' ? { key: chave, dsaEncoding: 'ieee-p1363' } : chave,
    Buffer.from(assinaturaTexto, 'base64url'),
  );
  if (!valida) throw new ErroTokenDmsId('assinatura não confere');

  const agoraSeg = Math.floor((o.agora ?? new Date()).getTime() / 1000);
  const folga = o.folgaSeg ?? 30;
  if (corpo.iss !== o.emissor) throw new ErroTokenDmsId('outro emissor');
  const destinos = Array.isArray(corpo.aud) ? corpo.aud : [corpo.aud];
  if (!destinos.includes(o.destino)) throw new ErroTokenDmsId('outro destino');
  if (typeof corpo.exp !== 'number' || corpo.exp <= agoraSeg - folga) throw new ErroTokenDmsId('vencido');
  if (typeof corpo.nbf === 'number' && corpo.nbf > agoraSeg + folga) throw new ErroTokenDmsId('ainda não vale');
  if (typeof corpo.iat === 'number' && corpo.iat > agoraSeg + folga) throw new ErroTokenDmsId('emitido no futuro');
  const aplicativo = typeof corpo.client_id === 'string' ? corpo.client_id : typeof corpo.sub === 'string' ? corpo.sub : null;
  if (!aplicativo) throw new ErroTokenDmsId('sem aplicativo');

  const permissoes = typeof corpo.scope === 'string' ? corpo.scope.split(' ').filter((p) => p.length > 0) : [];
  const faltando = (o.exigidas ?? []).filter((p) => !permissoes.includes(p));
  if (faltando.length > 0) throw new ErroPermissaoFaltando(faltando);
  return { aplicativo, permissoes, expiraEm: new Date(corpo.exp * 1000) };
}

/**
 * As permissões que valem numa chamada: as do token E as que a conta autorizou na ligação. Vale a menor das duas — o
 * DMS ID diz o que o aplicativo pode no produto; a ligação diz o que aquela conta deixou.
 */
export function permissoesDaChamada(doToken: readonly string[], daLigacao: readonly string[]): string[] {
  return doToken.filter((p) => daLigacao.includes(p));
}

/** O DMS ID recusou ou não respondeu o pedido de token. A mensagem nunca leva o segredo do aplicativo. */
export class ErroDmsId extends Error {
  readonly status: number;
  readonly codigo: string;

  constructor(status: number, codigo: string) {
    super(`O DMS ID não deu o token (${status}${codigo ? ` ${codigo}` : ''}).`);
    this.name = 'ErroDmsId';
    this.status = status;
    this.codigo = codigo;
  }
}

export type OpcoesClienteDmsId = {
  /** O endereço do DMS ID com `/oidc` (o mesmo `iss` dos tokens). O pedido vai a `<emissor>/token`. */
  emissor: string;
  /** O `client_id` do aplicativo no DMS ID. */
  aplicativo: string;
  /** O segredo do aplicativo. Fica na configuração do servidor, nunca em registro. */
  segredo: string;
  buscar?: typeof fetch;
  /** Renova este tanto antes de vencer (padrão: 60 s). */
  margemSeg?: number;
  tempoLimiteMs?: number;
  relogio?: () => number;
};

/**
 * O cliente pronto: pede o token do DMS ID para um produto, guarda até perto de vencer e renova sozinho. Pedidos ao
 * mesmo tempo para o mesmo destino viram UM pedido ao DMS ID. Recebeu 401 do produto? `esquecer` e pedir de novo, uma
 * vez.
 */
export class ClienteDmsId {
  private readonly emissor: string;
  private readonly aplicativo: string;
  private readonly segredo: string;
  private readonly buscar: typeof fetch;
  private readonly margemMs: number;
  private readonly tempoLimiteMs: number;
  private readonly relogio: () => number;
  private readonly guardados = new Map<string, { token: string; venceEm: number }>();
  private readonly emCurso = new Map<string, Promise<string>>();

  constructor(o: OpcoesClienteDmsId) {
    this.emissor = o.emissor.replace(/\/+$/, '');
    this.aplicativo = o.aplicativo;
    this.segredo = o.segredo;
    this.buscar = o.buscar ?? fetch;
    this.margemMs = (o.margemSeg ?? 60) * 1000;
    this.tempoLimiteMs = o.tempoLimiteMs ?? 5_000;
    this.relogio = o.relogio ?? Date.now;
  }

  private static chave(destino: string, permissoes: readonly string[]): string {
    return `${destino} ${[...permissoes].sort().join(' ')}`;
  }

  /** O token para chamar `destino` com estas permissões. */
  async token(destino: string, permissoes: readonly string[]): Promise<string> {
    const chave = ClienteDmsId.chave(destino, permissoes);
    const guardado = this.guardados.get(chave);
    if (guardado && guardado.venceEm - this.margemMs > this.relogio()) return guardado.token;
    const andando = this.emCurso.get(chave);
    if (andando) return andando;
    const pedido = this.pedir(destino, permissoes, chave).finally(() => this.emCurso.delete(chave));
    this.emCurso.set(chave, pedido);
    return pedido;
  }

  /** Joga fora o token guardado (o produto respondeu 401: o próximo `token` pede outro). */
  esquecer(destino: string, permissoes: readonly string[]): void {
    this.guardados.delete(ClienteDmsId.chave(destino, permissoes));
  }

  private async pedir(destino: string, permissoes: readonly string[], chave: string): Promise<string> {
    // RFC 6749 §2.3.1: o id e o segredo vão codificados antes do Basic.
    const credencial = Buffer.from(`${encodeURIComponent(this.aplicativo)}:${encodeURIComponent(this.segredo)}`).toString('base64');
    let r: Response;
    try {
      r = await this.buscar(`${this.emissor}/token`, {
        method: 'POST',
        headers: { authorization: `Basic ${credencial}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', resource: destino, scope: [...permissoes].join(' ') }).toString(),
        signal: AbortSignal.timeout(this.tempoLimiteMs),
      });
    } catch {
      throw new ErroDmsId(0, 'sem_resposta');
    }
    const corpo = (await r.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown; error?: unknown };
    if (!r.ok || typeof corpo.access_token !== 'string') throw new ErroDmsId(r.status, typeof corpo.error === 'string' ? corpo.error.slice(0, 60) : '');
    const segundos = typeof corpo.expires_in === 'number' && corpo.expires_in > 0 ? corpo.expires_in : 300;
    this.guardados.set(chave, { token: corpo.access_token, venceEm: this.relogio() + segundos * 1000 });
    return corpo.access_token;
  }
}
