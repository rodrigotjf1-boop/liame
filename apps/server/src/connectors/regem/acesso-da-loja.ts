import { createHash } from 'node:crypto';
import type { AppConfig } from '../../config.js';
import type { CredencialGuardada } from '../../connections/oauth.js';
import { ErroConector } from '../cliente-http.js';
import { clienteDoDmsIdDoProcesso, comTokenDoDmsId } from '../dms/dms-id.js';

// O acesso de cada chamada do Liame ao Regem (Hub DMS, F3, parte B). Os cinco caminhos que chamam o Regem (a leitura das
// vendas, a descoberta das lojas, o registro pela distribuição, a revogação e a criação do cupom) montam o acesso aqui e
// não precisam saber por qual credencial ele vai. Duas formas:
// - o token da loja (`rgm_it_`), como sempre;
// - a ligação do Hub DMS: o token do DMS ID do aplicativo do Liame no `Authorization` e o segredo da ligação da loja no
//   cabeçalho `DMS-Ligacao`. A ligação sai da troca automática do `rgm_it_` (só a rotina da comparação troca: repetir a
//   troca gira o segredo) e fica no cofre (`connected_account.ligacao_secret_id`), com o resumo do `rgm_it_` de onde veio.
//
// A leitura de verdade só vai pela ligação com `REGEM_PELA_LIGACAO` (desligada: antes vem o critério da comparação,
// decisão F3-6) e quando a ligação guardada veio do `rgm_it_` de agora. O `rgm_it_` segue aceito até a F6 e fica de
// reserva: pela ligação, a recusa do acesso ou da permissão é repetida pelo token, e quem diz se a loja foi desconectada é
// a recusa do `rgm_it_`. Sem reserva, pela ligação só `ligacao-invalida` é da loja (ERR-149: nunca "todo 401").

/** O acesso de uma chamada ao conector do Regem: o token (o `rgm_it_`, ou o do DMS ID) e, pela ligação, o segredo dela. */
export type AcessoAoRegem = { token: string; lojaChave: string; ligacao?: string };

/** O que o cofre guarda da ligação de uma loja do Regem (`ligacao_secret_id`). */
export type LigacaoGuardadaRegem = { tipo: 'ligacao_regem'; ligacao: string; prefixo: string; origem: string; obtida_em: string };

/**
 * A credencial de uma loja numa chamada. Pela ligação, `reserva` é o `rgm_it_` de onde ela saiu (nulo = ligação sem
 * token de reserva: a autorização por clique da parte C).
 */
export type CredencialDaLoja = { via: 'token'; token: string; escopos: string[] } | { via: 'ligacao'; ligacao: string; escopos: string[]; reserva: string | null };

/** O que identifica o segredo da ligação de uma loja do Regem no cofre. */
export const PROPOSITO_DA_LIGACAO_REGEM = 'ligacao_regem';

/** As permissões que o token do DMS ID pede para ler o Regem (o catálogo do Liame lá, menos criar cupom). */
export const PERMISSOES_DA_LEITURA = ['pedidos.ler', 'clientes.telefone.ler', 'custos.ler', 'clientes.anonimizacao.ler', 'cupons.ler', 'cupons.uso.ler'] as const;

/** As de criar o cupom de campanha (decisão F3-5: criar cupom pela ligação pode). */
export const PERMISSOES_DA_ESCRITA = [...PERMISSOES_DA_LEITURA, 'cupons.criar'] as const;

/** O recurso do Regem no DMS ID: o endereço das rotas de integração, que é o `aud` dos tokens (Regem `DMS_ID_RECURSO`). */
export function recursoDoRegem(apiUrl: string): string {
  return apiUrl.replace(/\/+$/, '');
}

/** O resumo do `rgm_it_` que acompanha a ligação no cofre: a ligação de outro token (a loja reconectou) não serve. */
export function resumoDoToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** O `rgm_it_` da loja (`external_id` = o id da loja no Regem) no que o cofre guarda da conexão, ou nulo. */
export function tokenDaLoja(guardada: CredencialGuardada | null | undefined, externalId: string): { token: string; escopos: string[] } | null {
  if (guardada?.tipo !== 'regem') return null;
  const da = guardada.lojas.find((l) => l.loja_id === externalId);
  return da ? { token: da.token, escopos: da.escopos } : null;
}

/** A ligação lida do cofre, se ela saiu deste `rgm_it_`; senão, nula. */
export function ligacaoDoToken(lida: string | null | undefined, token: string): LigacaoGuardadaRegem | null {
  if (!lida) return null;
  let l: Partial<LigacaoGuardadaRegem>;
  try {
    l = JSON.parse(lida) as Partial<LigacaoGuardadaRegem>;
  } catch {
    return null;
  }
  return l?.tipo === 'ligacao_regem' && typeof l.ligacao === 'string' && l.origem === resumoDoToken(token) ? (l as LigacaoGuardadaRegem) : null;
}

/** Pelo `rgm_it_`. */
export const peloToken = (token: string, escopos: string[]): CredencialDaLoja => ({ via: 'token', token, escopos });

/**
 * A credencial de uma chamada da leitura de verdade: pela ligação só com `REGEM_PELA_LIGACAO` (`pelaLigacao`) e a ligação
 * do cofre (`ligacaoLida`, o texto guardado) saída do `rgm_it_` de agora, que fica de reserva; senão, pelo `rgm_it_`.
 * Nula = o cofre não tem o token desta loja.
 */
export function credencialDaLoja(
  guardada: CredencialGuardada | null | undefined,
  externalId: string,
  ligacaoLida: string | null | undefined,
  pelaLigacao: boolean,
): CredencialDaLoja | null {
  const t = tokenDaLoja(guardada, externalId);
  if (!t) return null;
  const ligacao = pelaLigacao ? ligacaoDoToken(ligacaoLida, t.token) : null;
  return ligacao ? { via: 'ligacao', ligacao: ligacao.ligacao, escopos: t.escopos, reserva: t.token } : peloToken(t.token, t.escopos);
}

/**
 * Chama o Regem com a credencial. Pelo token, direto. Pela ligação, com o token do DMS ID do aplicativo do Liame (pedido
 * de novo uma vez se o Regem o recusar: vencido, trocado); `permissoes` = as que o token pede.
 */
export async function comAcessoDaLoja<T>(
  c: CredencialDaLoja,
  config: Pick<AppConfig, 'dmsId' | 'produtos'>,
  lojaChave: string,
  permissoes: readonly string[],
  chamar: (a: AcessoAoRegem) => Promise<T>,
): Promise<T> {
  if (c.via === 'token') return chamar({ token: c.token, lojaChave });
  if (!config.dmsId) throw new ErroConector('definitivo', 'regem', 'a ligação do Regem pede o aplicativo do Liame no DMS ID');
  return comTokenDoDmsId(
    clienteDoDmsIdDoProcesso(config.dmsId),
    recursoDoRegem(config.produtos.regemApiUrl),
    permissoes,
    (token) => chamar({ token, lojaChave, ligacao: c.ligacao }),
    'regem',
  );
}

/**
 * A recusa é da loja (ela fica desconectada até conectar de novo)? Pelo `rgm_it_`, todo 401: ele é a credencial da loja.
 * Pela ligação com o `rgm_it_` de reserva, nunca: quem chama repete pelo token, e a recusa dele decide. Sem reserva, só
 * `ligacao-invalida` (revogada, de outro aplicativo, do token revogado); o `token-invalido` (o token do DMS ID recusado
 * mesmo depois de pedir outro) e o DMS ID que recusa o aplicativo são do aplicativo. Por correspondência, nunca por
 * "todo 401 menos um" (ERR-149).
 */
export const recusaDaLoja = (c: CredencialDaLoja, err: ErroConector): boolean =>
  err.tipo === 'autenticacao' && (c.via === 'token' || (c.reserva === null && err.codigoProvider === 'ligacao-invalida'));

/** Pela ligação, a falha que o `rgm_it_` de reserva pode resolver: a recusa do acesso (401) ou da permissão (403). */
export const repetirPeloToken = (c: CredencialDaLoja, err: ErroConector): boolean =>
  c.via === 'ligacao' && c.reserva !== null && (err.tipo === 'autenticacao' || err.tipo === 'permissao');

/** O que acontece quando uma chamada pela ligação é repetida pelo `rgm_it_` (para o log e para tirar a ligação recusada). */
export type AoRepetirPeloToken = (err: ErroConector) => Promise<void>;

/**
 * O acesso de uma execução (a leitura das vendas de uma loja, a criação de um cupom): começa pela credencial da loja e,
 * pela ligação, a chamada recusada (acesso ou permissão) é repetida pelo `rgm_it_` de reserva; dali em diante, a execução
 * segue pelo token. A repetição não gasta nada: o Regem confere o acesso antes de qualquer outra coisa, e a chave de
 * idempotência da criação do cupom é a mesma pelas duas (o id da ligação é o do token).
 */
export class AcessoDaExecucao {
  private atual: CredencialDaLoja;

  constructor(
    credencial: CredencialDaLoja,
    private readonly config: Pick<AppConfig, 'dmsId' | 'produtos'>,
    private readonly lojaChave: string,
    private readonly permissoes: readonly string[],
    private readonly aoRepetir: AoRepetirPeloToken | null = null,
  ) {
    this.atual = credencial;
  }

  /** A credencial que vale agora (depois de uma repetição, a do token). */
  get credencial(): CredencialDaLoja {
    return this.atual;
  }

  async chamar<T>(f: (a: AcessoAoRegem) => Promise<T>): Promise<T> {
    try {
      return await comAcessoDaLoja(this.atual, this.config, this.lojaChave, this.permissoes, f);
    } catch (err) {
      const c = this.atual;
      if (!(err instanceof ErroConector) || c.via !== 'ligacao' || c.reserva === null || !repetirPeloToken(c, err)) throw err;
      this.atual = peloToken(c.reserva, c.escopos);
      if (this.aoRepetir) await this.aoRepetir(err);
      return comAcessoDaLoja(this.atual, this.config, this.lojaChave, this.permissoes, f);
    }
  }
}
