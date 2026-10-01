'use client';

import type { ConnectionResponse } from '@liame/contracts';
import { useId, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { dataCompleta } from '@/lib/formato';
import { contasDaAutorizacao, escoposDoRegem, quemAutorizou, regemRevogado, semCusto } from './textos';

// A autorização do Regem (protótipo P2, aprovado em 29/09/2026): quem autorizou, quantas lojas, o que o
// Liame recebe de cada escopo ("Liberado", "Não liberado", "Liberado · desligado no Liame"), o aviso de
// "sem o custo dos itens" e o de "revogada no Regem". Um token por loja; revogar aqui revoga lá também.

type Props = {
  conexao: ConnectionResponse;
  podeConectar: boolean;
  /** Autorização que ainda espera a escolha das lojas. */
  aoEscolher: (() => void) | null;
  /** Dá para conectar o Regem de novo (a API diz que está disponível): o botão da autorização revogada. */
  aoConectar: (() => void) | null;
  aoRevogar: () => void;
  /** Criar cupom no Regem pelo Liame está ligado para a empresa (a permissão liberada pela loja passa a valer). */
  escritaLigada?: boolean;
};

const ROTULO = { liberado: 'Liberado', nao_liberado: 'Não liberado', desligado: 'Liberado · desligado no Liame' } as const;
const TOM = { liberado: 'st--concluido', nao_liberado: 'st--aguardando', desligado: 'st--espera' } as const;
const ICONE = { liberado: 'check', nao_liberado: 'alert', desligado: 'lock' } as const;

export function CartaoAutorizacaoRegem({ conexao: c, podeConectar, aoEscolher, aoConectar, aoRevogar, escritaLigada = false }: Props) {
  const [aberto, setAberto] = useState(false);
  const id = useId();
  const n = contasDaAutorizacao(c);
  const lojas = n === 1 ? '1 loja' : `${n} lojas`;
  const quando = dataCompleta(c.completed_at ?? c.created_at);
  const quem = quemAutorizou(c);
  const daDistribuicao = c.origin === 'distribuicao';
  const revogada = regemRevogado(c);
  const qual = `do Regem de ${quando}`;

  return (
    <li className="card autorizacao">
      <div className="aut-cab">
        <span className="plat plat--regem">Regem</span>
        {quem ? (
          <>
            <b>Autorizada por {quem}</b>
            <span className="aut-meta">
              presidente no Regem · em {quando} · {lojas}
            </span>
          </>
        ) : (
          <>
            <b>Autorizada em {quando}</b>
            <span className="aut-meta">{daDistribuicao ? `pela distribuição DMS · ${lojas}` : lojas}</span>
          </>
        )}
      </div>
      {revogada ? (
        <p className="aut-txt aut-txt--perigo">
          <Icone nome="alert-circle" pequeno />
          <span>Revogada no Regem. A leitura dos pedidos parou; conecte de novo para voltar.</span>
        </p>
      ) : (
        <p className="aut-txt">Um token para cada loja, guardado cifrado no Liame e só em hash no Regem. Revogar aqui revoga lá também.</p>
      )}
      {!revogada && semCusto(c.scopes) && (
        <p className="aut-txt aut-txt--atencao">
          <Icone nome="alert" pequeno />
          <span>{daDistribuicao ? 'Sem o custo dos itens: o token desta loja foi emitido sem ele.' : 'Sem o custo dos itens: quem autorizou não tem permissão financeira no Regem.'}</span>
        </p>
      )}
      <div className="aut-escopos" id={id} hidden={!aberto}>
        <ul className="escopos">
          {escoposDoRegem(c.scopes, c.origin, escritaLigada).map((e) => (
            <li key={e.cod} className={`escopo escopo--${e.estado}`}>
              <Icone nome={ICONE[e.estado]} pequeno />
              <div>
                <p className="escopo-cab">
                  <b>{e.rotulo}</b>
                  <code>{e.cod}</code>
                  <span className={`st ${TOM[e.estado]}`}>{ROTULO[e.estado]}</span>
                </p>
                <p className="escopo-txt">{e.texto}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
      <div className="seg-acoes">
        {podeConectar && revogada && aoConectar && (
          <button className="btn btn--sm btn--primary" type="button" onClick={aoConectar} aria-label={`Conectar de novo: autorização ${qual}`}>
            Conectar de novo
          </button>
        )}
        {podeConectar && aoEscolher && (
          <button className="btn btn--sm btn--primary" type="button" onClick={aoEscolher} aria-label={`Ligar lojas: autorização ${qual}`}>
            Ligar lojas
          </button>
        )}
        <button className="btn btn--sm btn-alternar" type="button" aria-expanded={aberto} aria-controls={id} onClick={() => setAberto((a) => !a)}>
          O que o Liame recebe
          <Icone nome="chevron-down" pequeno />
        </button>
        {podeConectar && (
          <button className="btn btn--sm btn--perigo" type="button" onClick={aoRevogar} aria-label={`Revogar a autorização ${qual}`}>
            Revogar
          </button>
        )}
      </div>
    </li>
  );
}
