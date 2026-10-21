import type { AppConfig } from '../../config.js';
import type { CredencialGuardada } from '../../connections/oauth.js';
import { ErroConector } from '../cliente-http.js';
import { clienteDoDmsIdDoProcesso, comTokenDoDmsId, recursoDoRegemcast } from '../dms/dms-id.js';
import type { ClienteDmsId } from '../dms/integracao-dms.js';
import { PERMISSOES_DO_CLIQUE } from './conector-regemcast.js';

// A credencial de uma conta do RegemCast, como o cofre a guarda, e o acesso de cada chamada (Hub DMS, F2, B1). Duas
// formas: o token de integração da conta (`rct_it_`, emitido pela distribuição) e a ligação da autorização por clique
// (o segredo no cabeçalho `DMS-Ligacao`, junto com o token do DMS ID do aplicativo do Liame). Quem LÊ o RegemCast pede o
// acesso aqui e não precisa saber qual das duas é. Quem GRAVA confere `podeGravar`: pela ligação, gravar fica fora até
// a F5 (decisão B1-3), e a recusa usa a frase de `SO_LEITURA_PELA_AUTORIZACAO`.

export type CredencialDaConta = { via: 'token'; token: string; escopos: string[] } | { via: 'ligacao'; ligacao: string; escopos: string[] };

/** O acesso de uma chamada ao conector do RegemCast. */
export type AcessoAoRegemcast = { token: string; contaChave: string; ligacao?: string };

/** A credencial da conta (`external_id` = o id da conta no RegemCast) no que o cofre guarda; nula = sem credencial dela. */
export function credencialDaConta(guardada: CredencialGuardada | null | undefined, externalId: string): CredencialDaConta | null {
  if (guardada?.tipo === 'regemcast') {
    const da = guardada.lojas.find((l) => l.loja_id === externalId);
    return da ? { via: 'token', token: da.token, escopos: da.escopos } : null;
  }
  if (guardada?.tipo === 'regemcast_ligacao' && guardada.conta_id === externalId) return { via: 'ligacao', ligacao: guardada.ligacao, escopos: guardada.permissoes };
  return null;
}

/** As credenciais de uma conexão do RegemCast (as contas dos tokens da distribuição, ou a conta da ligação do clique). */
export function credenciaisDaConexao(guardada: CredencialGuardada | null | undefined): { contaId: string; credencial: CredencialDaConta }[] {
  if (guardada?.tipo === 'regemcast') return guardada.lojas.map((l) => ({ contaId: l.loja_id, credencial: { via: 'token', token: l.token, escopos: l.escopos } }));
  if (guardada?.tipo === 'regemcast_ligacao') return [{ contaId: guardada.conta_id, credencial: { via: 'ligacao', ligacao: guardada.ligacao, escopos: guardada.permissoes } }];
  return [];
}

/** Gravar no RegemCast (rascunho, disparo, pausa) só pelo token da distribuição: a autorização do dono libera só leitura. */
export const podeGravar = (c: CredencialDaConta): c is CredencialDaConta & { via: 'token' } => c.via === 'token';

/** O que a pessoa lê quando o Liame não pode gravar numa conta ligada pela autorização do dono (B1-3). */
export const SO_LEITURA_PELA_AUTORIZACAO =
  'Esta conta do RegemCast foi ligada pela autorização do dono, que por enquanto libera só leitura: criar e enviar mensagens pelo Liame ainda não está disponível para ela. Para enviar agora, fale com o suporte.';

/**
 * O cliente do DMS ID dos leitores do RegemCast: o do processo (`clienteDoDmsIdDoProcesso`), o mesmo dos leitores do
 * Regem. O token fica guardado até perto de vencer e serve a todas as contas (ele é do aplicativo do Liame).
 */
export function dmsIdDosLeitores(dmsId: NonNullable<AppConfig['dmsId']>): ClienteDmsId {
  return clienteDoDmsIdDoProcesso(dmsId);
}

/**
 * Chama o RegemCast com o acesso da conta. Pelo token, direto. Pela ligação, com o token do DMS ID do aplicativo do
 * Liame, pedido de novo uma vez se o RegemCast o recusar (vencido, trocado): o RegemCast confere o token antes do resto.
 */
export async function comAcessoDaConta<T>(
  c: CredencialDaConta,
  config: Pick<AppConfig, 'dmsId' | 'produtos'>,
  contaChave: string,
  chamar: (a: AcessoAoRegemcast) => Promise<T>,
): Promise<T> {
  if (c.via === 'token') return chamar({ token: c.token, contaChave });
  const apiUrl = config.produtos.regemcastApiUrl;
  if (!config.dmsId || !apiUrl) throw new ErroConector('definitivo', 'regemcast', 'a ligação do RegemCast pede o aplicativo do Liame no DMS ID e o endereço do RegemCast');
  return comTokenDoDmsId(dmsIdDosLeitores(config.dmsId), recursoDoRegemcast(apiUrl), PERMISSOES_DO_CLIQUE, (token) => chamar({ token, contaChave, ligacao: c.ligacao }));
}

/**
 * A recusa é da conta (ela fica desconectada até conectar de novo)? Pelo token da distribuição, todo 401 é dele: o
 * `rct_it_` é a credencial da conta (o RegemCast responde ao recusado com `{ mensagem }`, sem o nome do problema). Pela
 * ligação, só `ligacao-invalida` é da conta (revogada lá, ou de outro aplicativo). O token do DMS ID recusado mesmo
 * depois de pedir outro, e o DMS ID que recusa o aplicativo do Liame (sem código: a recusa nasce no `/token` dele), são
 * do aplicativo, não da conta: nada é desconectado, e quem chama trata como falha passageira. Por correspondência,
 * nunca por "todo 401 menos um" (ERR-149).
 */
export const recusaDaConta = (c: CredencialDaConta, err: ErroConector): boolean =>
  err.tipo === 'autenticacao' && (c.via === 'token' || err.codigoProvider === 'ligacao-invalida');
