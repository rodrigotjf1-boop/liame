'use client';

import type { ConnectionResponse } from '@liame/contracts';
import { Icone } from '@/components/ui/icone';
import { dataCompleta } from '@/lib/formato';
import { contasELojas, ligadasDaAutorizacao, type perfilNaAutorizacao } from './perfil-google';
import { autorizadorDa, emConferencia, erroDaConexao, plataforma, quemAutorizou, vencimentoDaAutorizacao } from './textos';

// Uma autorização (o "sim" que alguém deu na Meta ou no Google): quando, quantas contas, se vence
// (Google em modo de teste) e as ações: conectar de novo, procurar contas de novo e revogar. Com o perfil da empresa no
// Google ligado para a empresa (P17, parte B), a do Google diz o que traz do perfil e o que falta quando falta.

type Props = {
  conexao: ConnectionResponse;
  agora: Date;
  podeConectar: boolean;
  procurando: boolean;
  /** A autorização do Google inclui a permissão de informar vendas, e a função está ligada para a marca (A5, Y1). */
  informaVendas?: boolean;
  /** O que a autorização do Google diz do perfil da empresa (`perfilNaAutorizacao`); nulo ou ausente sem a função. */
  perfil?: ReturnType<typeof perfilNaAutorizacao>;
  /** Autorização que ainda espera a escolha (a pessoa fechou com "Agora não"): reabre a escolha. */
  aoEscolher: (() => void) | null;
  aoReconectar: () => void;
  /** "Autorizar o Google de novo", direto para a página do Google (o perfil recusado ou numa conta sem perfil). */
  aoAutorizar?: () => void;
  aoProcurar: () => void;
  aoRevogar: () => void;
};

const ICONE_DA_NOTA = { lock: 'lock', info: 'info', clock: 'clock', alert: 'alert' } as const;

export function CartaoAutorizacao({ conexao: c, agora, podeConectar, procurando, informaVendas = false, perfil = null, aoEscolher, aoReconectar, aoAutorizar, aoProcurar, aoRevogar }: Props) {
  const a = autorizadorDa(c.provider);
  const plat = plataforma(c.provider);
  const vence = vencimentoDaAutorizacao(c, agora);
  const falhou = c.status === 'erro' ? erroDaConexao(c.error_code, a) : null;
  const conferindo = emConferencia(c) || procurando;
  const reconectar = Boolean(falhou || vence);
  const quando = dataCompleta(c.completed_at ?? c.created_at);
  const quem = quemAutorizou(c);
  // "3 contas e 1 loja": a loja do perfil conta à parte.
  const contas = contasELojas(ligadasDaAutorizacao(c));
  const qual = `${a === 'google' ? 'do Google' : 'da Meta'} de ${quando}`;
  const nota = !falhou ? (perfil?.nota ?? null) : null;
  const autorizar = !reconectar && perfil?.acao === 'autorizar' && aoAutorizar;

  return (
    <li className="card autorizacao">
      <div className="aut-cab">
        <span className={`plat plat--${plat.classe}`}>{plat.nome}</span>
        {quem ? (
          <>
            <b>Autorizada por {quem}</b>
            <span className="aut-meta">
              em {quando} · {contas}
            </span>
          </>
        ) : (
          <>
            <b>Autorizada em {quando}</b>
            <span className="aut-meta">{contas}</span>
          </>
        )}
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
          {a === 'google' && informaVendas && ' Inclui a permissão de informar vendas.'}
          {a === 'google' && perfil?.inclui && ' Inclui a permissão do perfil da empresa.'}
        </p>
      )}
      {nota && (
        <p className="aut-txt aut-txt--atencao">
          <Icone nome={ICONE_DA_NOTA[nota.icone]} pequeno />
          <span>
            {nota.destaque && <b>{nota.destaque}</b>} {nota.texto}
          </span>
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
          {autorizar && (
            <button className="btn btn--sm btn--primary" type="button" onClick={aoAutorizar} aria-label={`Autorizar o Google de novo: autorização ${qual}`}>
              Autorizar o Google de novo
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
