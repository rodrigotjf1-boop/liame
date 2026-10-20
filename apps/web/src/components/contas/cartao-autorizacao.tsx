'use client';

import type { ConnectionResponse } from '@liame/contracts';
import { Icone } from '@/components/ui/icone';
import { dataCompleta } from '@/lib/formato';
import { contasELojas, ligadasDaAutorizacao, type perfilNaAutorizacao } from './perfil-google';
import type { searchConsoleNaAutorizacao } from './search-console';
import { autorizadorDa, daPlataforma, emConferencia, erroDaConexao, naPlataforma, plataforma, quemAutorizou, vencimentoDaAutorizacao } from './textos';

// Uma autorização (o "sim" que alguém deu na Meta, no Google ou no RegemCast): quando, quantas contas, se vence
// (Google em modo de teste) e as ações: conectar de novo, procurar contas de novo e revogar. Com o perfil da empresa no
// Google ligado para a empresa (P17, parte B), a do Google diz o que traz do perfil e o que falta quando falta; com o
// Search Console ligado (P18, parte B), o mesmo do site. O RegemCast se conecta de novo pela autorização por clique (Hub DMS, B1), quando a empresa tem; sem ela, quem liga de
// novo é a DMS, e o cartão diz isso em vez de oferecer um botão que não leva a lugar nenhum.

type Props = {
  conexao: ConnectionResponse;
  agora: Date;
  podeConectar: boolean;
  procurando: boolean;
  /** A autorização do Google inclui a permissão de informar vendas, e a função está ligada para a marca (A5, Y1). */
  informaVendas?: boolean;
  /** O que a autorização do Google diz do perfil da empresa (`perfilNaAutorizacao`); nulo ou ausente sem a função. */
  perfil?: ReturnType<typeof perfilNaAutorizacao>;
  /** O que a autorização do Google diz do Search Console (`searchConsoleNaAutorizacao`); nulo ou ausente sem a função. */
  site?: ReturnType<typeof searchConsoleNaAutorizacao>;
  /** Autorização que ainda espera a escolha (a pessoa fechou com "Agora não"): reabre a escolha. */
  aoEscolher: (() => void) | null;
  /** "Conectar de novo"; nulo = não dá para conectar de novo daqui (o RegemCast sem a autorização por clique). */
  aoReconectar: (() => void) | null;
  /** "Autorizar o Google de novo", direto para a página do Google (o perfil recusado ou numa conta sem perfil). */
  aoAutorizar?: () => void;
  aoProcurar: () => void;
  aoRevogar: () => void;
};

const ICONE_DA_NOTA = { lock: 'lock', info: 'info', clock: 'clock', alert: 'alert' } as const;

export function CartaoAutorizacao({
  conexao: c,
  agora,
  podeConectar,
  procurando,
  informaVendas = false,
  perfil = null,
  site = null,
  aoEscolher,
  aoReconectar,
  aoAutorizar,
  aoProcurar,
  aoRevogar,
}: Props) {
  const a = autorizadorDa(c.provider);
  const plat = plataforma(c.provider);
  const vence = vencimentoDaAutorizacao(c, agora);
  const falhou = c.status === 'erro' ? erroDaConexao(c.error_code, a) : null;
  const conferindo = emConferencia(c) || procurando;
  const reconectar = Boolean(falhou || vence);
  const quando = dataCompleta(c.completed_at ?? c.created_at);
  const quem = quemAutorizou(c);
  // "3 contas e 1 loja", "3 contas e 1 site": a loja do perfil e o site do Search Console contam à parte.
  const contas = contasELojas(ligadasDaAutorizacao(c));
  const qual = `${daPlataforma(a)} de ${quando}`;
  const sobre =
    a === 'google'
      ? 'Google Ads e Google Analytics numa autorização só, sem prazo de validade.'
      : a === 'regemcast'
        ? c.origin === 'distribuicao'
          ? 'Ligada pela DMS, com o token da conta, sem prazo de validade.'
          : 'Autorizada pelo dono da conta no RegemCast, sem prazo de validade.'
        : 'Autorização da empresa, sem prazo de validade.';
  // O que falta do perfil e do site, um aviso para cada (com as duas funções ligadas, os dois podem aparecer).
  const notas = !falhou ? [perfil?.nota ?? null, site?.nota ?? null].filter((n): n is NonNullable<typeof n> => n !== null) : [];
  const autorizar = !reconectar && (perfil?.acao === 'autorizar' || site?.acao === 'autorizar') && aoAutorizar;

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
          {sobre}
          {a === 'google' && informaVendas && ' Inclui a permissão de informar vendas.'}
          {a === 'google' && perfil?.inclui && ' Inclui a permissão do perfil da empresa.'}
          {a === 'google' && site?.inclui && ' Inclui a permissão do Search Console, só de leitura.'}
        </p>
      )}
      {notas.map((nota) => (
        <p className="aut-txt aut-txt--atencao" key={`${nota.destaque ?? ''}${nota.texto}`}>
          <Icone nome={ICONE_DA_NOTA[nota.icone]} pequeno />
          <span>
            {nota.destaque && <b>{nota.destaque}</b>} {nota.texto}
          </span>
        </p>
      ))}
      {conferindo && (
        <p className="aut-txt" role="status">
          Procurando as contas {naPlataforma(a)}…
        </p>
      )}
      {reconectar && !aoReconectar && a === 'regemcast' && (
        <p className="aut-txt">A conexão com o RegemCast é feita pela DMS: fale com o suporte para ligar de novo.</p>
      )}
      {podeConectar && (
        <div className="seg-acoes">
          {aoEscolher && (
            <button className="btn btn--sm btn--primary" type="button" onClick={aoEscolher} aria-label={`Escolher contas: autorização ${qual}`}>
              Escolher contas
            </button>
          )}
          {reconectar && aoReconectar && (
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
