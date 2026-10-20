import type { ClienteConector } from '../connectors/cliente-http.js';
import { ErroConector } from '../connectors/cliente-http.js';
import { lerSituacao } from '../connectors/regemcast/conector-regemcast.js';
import type { SituacaoRegemcast } from '../connectors/regemcast/contrato-regemcast.js';
import type { DescobertaGuardada } from './connections.service.js';
import type { CredencialLigacaoRegemcast, CredencialRegem } from './oauth.js';

// A conta do RegemCast como conta descoberta (contrato v2): cada credencial diz a conta dela pela `integracao_situacao`,
// e o identificador é o `contaId` que ela devolve (não muda quando o token é trocado). Vale para as três portas de
// entrada: o token emitido pela distribuição (`distribuicao.ts`), o "Procurar as contas de novo" de uma conexão dessas e
// a ligação da autorização por clique (Hub DMS, B1). A credencial do RegemCast só vai para a API do RegemCast.

/** A conta que a `integracao_situacao` descreve, com as permissões que valem para a credencial. */
export function contaDoRegemcast(s: SituacaoRegemcast, extra: Record<string, unknown> = {}): DescobertaGuardada {
  return {
    provider: 'regemcast',
    external_id: s.contaId,
    name: s.conta,
    currency: null,
    timezone: s.fuso,
    provider_attributes: { escopos: s.permissoes.map((x) => x.id), classe: s.classe, token_nome: s.token, ...extra },
  };
}

/**
 * As contas que os tokens de uma conexão da distribuição alcançam, procuradas de novo. Token recusado fica de fora; se
 * todos forem recusados, a conexão precisa ser refeita. Token de outro produto também fica de fora: o dono da conta
 * autorizou aquele produto, não o Liame.
 */
export async function contasPelosTokens(cliente: ClienteConector, apiUrl: string, credencial: CredencialRegem & { tipo: 'regemcast' }): Promise<DescobertaGuardada[]> {
  const descobertas: DescobertaGuardada[] = [];
  let recusados = 0;
  for (const l of credencial.lojas) {
    try {
      const s = await lerSituacao({ cliente, apiUrl }, l.token, l.loja_id);
      if (s.produto === 'liame' && !descobertas.some((d) => d.external_id === s.contaId)) descobertas.push(contaDoRegemcast(s));
    } catch (err) {
      if (err instanceof ErroConector && err.tipo === 'autenticacao') {
        recusados++;
        continue;
      }
      throw err;
    }
  }
  if (!descobertas.length && recusados) throw new ErroConector('autenticacao', 'regemcast', 'todos os tokens das contas foram recusados');
  return descobertas;
}

/**
 * A conta da ligação da autorização por clique: a `integracao_situacao` pela credencial nova (o token do DMS ID e o
 * segredo da ligação). A ligação é de UMA conta, a que a troca devolveu: outra conta aqui é defeito de alguém, e a
 * conexão não fica com ela.
 */
export async function contaPelaLigacao(cliente: ClienteConector, apiUrl: string, tokenDmsId: string, credencial: CredencialLigacaoRegemcast): Promise<DescobertaGuardada> {
  const s = await lerSituacao({ cliente, apiUrl }, tokenDmsId, credencial.conta_id, credencial.ligacao);
  if (s.contaId !== credencial.conta_id) throw new ErroConector('definitivo', 'regemcast', 'a ligação diz outra conta que a da troca');
  return contaDoRegemcast(s, { ligacao: credencial.prefixo });
}
