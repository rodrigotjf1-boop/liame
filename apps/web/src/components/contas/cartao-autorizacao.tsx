'use client';

import type { ConnectionResponse } from '@liame/contracts';
import { Icone } from '@/components/ui/icone';
import { dataCompleta } from '@/lib/formato';
import { autorizadorDa, contasDaAutorizacao, emConferencia, erroDaConexao, plataforma, vencimentoDaAutorizacao } from './textos';

// Uma autorização (o "sim" que alguém deu na Meta ou no Google): quando, quantas contas, se vence
// (Google em modo de teste) e as ações: conectar de novo, procurar contas de novo e revogar.

type Props = {
  conexao: ConnectionResponse;
  agora: Date;
  podeConectar: boolean;
  procurando: boolean;
  /** Autorização que ainda espera a escolha (a pessoa fechou com "Agora não"): reabre a escolha. */
  aoEscolher: (() => void) | null;
  aoReconectar: () => void;
  aoProcurar: () => void;
  aoRevogar: () => void;
};

export function CartaoAutorizacao({ conexao: c, agora, podeConectar, procurando, aoEscolher, aoReconectar, aoProcurar, aoRevogar }: Props) {
  const a = autorizadorDa(c.provider);
  const plat = plataforma(c.provider);
  const n = contasDaAutorizacao(c);
  const vence = vencimentoDaAutorizacao(c, agora);
  const falhou = c.status === 'erro' ? erroDaConexao(c.error_code, a) : null;
  const conferindo = emConferencia(c) || procurando;
  const reconectar = Boolean(falhou || vence);
  const qual = `${a === 'google' ? 'do Google' : 'da Meta'} de ${dataCompleta(c.completed_at ?? c.created_at)}`;

  return (
    <li className="card autorizacao">
      <div className="aut-cab">
        <span className={`plat plat--${plat.classe}`}>{plat.nome}</span>
        <b>Autorizada em {dataCompleta(c.completed_at ?? c.created_at)}</b>
        <span className="aut-meta">{n === 1 ? '1 conta' : `${n} contas`}</span>
      </div>
      {falhou ? (
        <p className="aut-txt aut-txt--atencao">
          <Icone nome="alert-circle" pequeno />
          <span>
            {falhou.titulo} {falhou.texto}
          </span>
        </p>
      ) : vence ? (
        <p className="aut-txt aut-txt--atencao">
          <Icone nome="clock" pequeno />
          <span>{vence.texto}</span>
        </p>
      ) : (
        <p className="aut-txt">
          {a === 'google' ? 'Google Ads e Google Analytics numa autorização só, sem prazo de validade.' : 'Autorização da empresa, sem prazo de validade.'}
        </p>
      )}
      {conferindo && (
        <p className="aut-txt" role="status">
          Procurando as contas {a === 'google' ? 'no Google' : 'na Meta'}…
        </p>
      )}
      {podeConectar && (
        <div className="seg-acoes">
          {aoEscolher && (
            <button className="btn btn--sm btn--primary" type="button" onClick={aoEscolher} aria-label={`Escolher contas: autorização ${qual}`}>
              Escolher contas
            </button>
          )}
          {reconectar && (
            <button className="btn btn--sm btn--primary" type="button" onClick={aoReconectar} aria-label={`Conectar de novo: autorização ${qual}`}>
              Conectar de novo
            </button>
          )}
          <button
            className="btn btn--sm"
            type="button"
            onClick={aoProcurar}
            disabled={conferindo}
            aria-busy={procurando}
            aria-label={`Procurar contas de novo: autorização ${qual}`}
          >
            Procurar contas de novo
          </button>
          <button className="btn btn--sm btn--perigo" type="button" onClick={aoRevogar} aria-label={`Revogar a autorização ${qual}`}>
            Revogar
          </button>
        </div>
      )}
    </li>
  );
}
