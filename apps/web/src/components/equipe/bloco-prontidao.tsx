'use client';

import type { AutonomyItem, AutonomyResponse } from '@liame/contracts';
import { Icone } from '@/components/ui/icone';
import { quandoComHora } from '@/lib/formato';
import type { Modo } from '@/lib/modo';
import { ConfirmaNaLinha } from './pecas';
import { acaoDa, alvoDe, faltamNaAmostra, modoEscrito, plataformaDe, portoesDe } from './textos';

// "Já pode fazer mais?" (protótipo P7): a prontidão do Gestor de tráfego por conta e ação. Não é uma nota: são cinco
// portões objetivos. Quando todos passam, o sistema propõe mostrar as recomendações (de Sombra para Sugerir) e uma
// pessoa aprova, recusa ou, depois, volta para sombra. Nada é executado em plataforma nenhuma.

export interface AcoesDaProntidao {
  /** Qual ação está em andamento (`aprovar:<id>`, `recusar:<id>`, `voltar:<conta>:<ação>`), ou nula. */
  ocupado: string | null;
  /** A proposta cuja recusa espera a confirmação. */
  recusando: string | null;
  aoAprovar: (a: AutonomyItem) => void;
  aoPedirRecusa: (id: string | null) => void;
  aoRecusar: (a: AutonomyItem) => void;
  /** Volta um passo: de Sugerir para Sombra e, com o modo Aprovação, de Aprovação para Sugerir. */
  aoVoltarParaSombra: (a: AutonomyItem) => void;
  /** Com o modo Aprovação (P11): a linha (conta e ação) escolhida, e a linha cuja volta de um passo espera a confirmação. */
  linha: string | null;
  voltando: string | null;
  aoEscolherLinha: (chave: string) => void;
  aoPedirVolta: (chave: string | null) => void;
}

const chaveDe = (a: AutonomyItem) => `${a.connected_account_id}:${a.tool}`;
const seloDoModo = (a: AutonomyItem) => (a.mode === 'SUGGEST' ? 'modo-chip modo-chip--sugerir' : 'modo-chip modo-chip--sombra');

function Promocao({ a, agora, podeDecidir, primeiro, acoes }: { a: AutonomyItem; agora: Date; podeDecidir: boolean; primeiro: boolean; acoes: AcoesDaProntidao }) {
  const p = a.proposal;
  const alvo = alvoDe(a);
  if (p?.status === 'pendente') {
    const id = `promo-${p.id}`;
    return (
      <div className="promocao" role="region" aria-labelledby={id}>
        <h4 id={id}>Proposta do sistema: {alvo}, de Sombra para Sugerir</h4>
        <p>
          Os cinco portões passaram. <b>O que muda:</b> quando ele recomendar {acaoDa(a.tool, null)} de uma campanha da conta {a.account_name} ({plataformaDe(a.provider)}), a recomendação
          aparece na Atenção, com o motivo e os números. Quem decide e muda na plataforma é você. As outras ações seguem em sombra.
        </p>
        <p className="explica-nota">Fica registrado quem aprovou, quando e a versão da regra de autonomia. Dá para voltar para Sombra a qualquer momento.</p>
        {podeDecidir ? (
          <div className="promocao-acoes">
            {acoes.recusando === p.id ? (
              <ConfirmaNaLinha
                texto="Recusar a promoção? Ele segue em sombra nessa ação."
                rotulo="Recusar"
                rotuloOcupado="Recusando…"
                ocupado={acoes.ocupado === `recusar:${p.id}`}
                aoConfirmar={() => acoes.aoRecusar(a)}
                aoCancelar={() => acoes.aoPedirRecusa(null)}
              />
            ) : (
              <>
                <button
                  className="btn btn--primary"
                  type="button"
                  id={`eqp-bt-aprovar-${p.id}`}
                  onClick={() => acoes.aoAprovar(a)}
                  disabled={acoes.ocupado !== null}
                  aria-busy={acoes.ocupado === `aprovar:${p.id}`}
                >
                  <Icone nome="check" pequeno />
                  {acoes.ocupado === `aprovar:${p.id}` ? 'Aprovando…' : 'Aprovar a promoção'}
                </button>
                <button className="btn" type="button" id={`eqp-bt-recusar-${p.id}`} onClick={() => acoes.aoPedirRecusa(p.id)} disabled={acoes.ocupado !== null}>
                  Recusar
                </button>
              </>
            )}
          </div>
        ) : (
          <p className="eixo-nota">Quem decide é o Dono ou o Administrador.</p>
        )}
      </div>
    );
  }
  if (a.mode === 'SUGGEST') {
    const aprovada = p?.status === 'aprovada' && p.decided_at;
    return (
      <div className="promocao">
        <h4>{alvo} está em Sugerir</h4>
        <p className="card-sub">
          {aprovada
            ? `Aprovado${p.decided_by ? ` por ${p.decided_by.name}` : ''} ${quandoComHora(p.decided_at!, agora)} · regra de autonomia, versão ${p.policy_version ?? a.mode_source.version ?? 1}.`
            : `Pela política ${a.mode_source.policy === 'marca' ? 'da marca' : a.mode_source.policy === 'empresa' ? 'da empresa' : 'em vigor'}${a.mode_source.version ? `, versão ${a.mode_source.version}` : ''}.`}{' '}
          As recomendações dessa ação aparecem na Atenção.
        </p>
        {podeDecidir && (
          <div className="promocao-acoes">
            <button
              className="btn"
              type="button"
              id={`eqp-bt-voltar-${chaveDe(a)}`}
              onClick={() => acoes.aoVoltarParaSombra(a)}
              disabled={acoes.ocupado !== null}
              aria-busy={acoes.ocupado === `voltar:${chaveDe(a)}`}
            >
              <Icone nome="undo" pequeno />
              {acoes.ocupado === `voltar:${chaveDe(a)}` ? 'Voltando…' : 'Voltar para sombra'}
            </button>
          </div>
        )}
      </div>
    );
  }
  if (!primeiro || !p) return null;
  const denovo = p.next_sample_size ? ` O sistema só propõe de novo com ${p.next_sample_size} decisões comparáveis.` : '';
  if (p.status === 'recusada') {
    return (
      <div className="promocao">
        <h4>Promoção recusada{p.decided_by ? ` por ${p.decided_by.name}` : ''}</h4>
        <p className="card-sub">Ele segue em sombra nessa ação.{denovo}</p>
      </div>
    );
  }
  if (p.status === 'desfeita') {
    return (
      <div className="promocao">
        <h4>{alvo} voltou para sombra</h4>
        <p className="card-sub">
          {p.undone_by ? `Por ${p.undone_by.name}` : 'Por uma pessoa da empresa'}
          {p.undone_at ? `, ${quandoComHora(p.undone_at, agora)}` : ''}. Nada aparece na Atenção por ele nessa ação.{denovo}
        </p>
      </div>
    );
  }
  return null;
}

export function BlocoProntidao({ autonomia, modo, agora, acoes }: { autonomia: AutonomyResponse | null; modo: Modo; agora: Date; acoes: AcoesDaProntidao }) {
  const alvo = autonomia?.items[0] ?? null;
  const nota = (
    <p className="explica-nota">Prontidão não é uma nota: são cinco portões objetivos, por conta e por ação. Quando todos passam, o sistema propõe e uma pessoa aprova.</p>
  );
  if (!autonomia || !alvo) {
    return (
      <div className="eqp-bloco" id="eqp-prontidao">
        <div className="eqp-bloco-cab">
          <h3>Já pode fazer mais?</h3>
        </div>
        {autonomia ? (
          <p className="lite-frase">
            <b>Ainda não.</b> Nesta fase ninguém mexe em campanha, e ele ainda nem mostra as recomendações: só registra e compara. Os portões aparecem depois da primeira recomendação registrada.
          </p>
        ) : (
          <p className="card-sub">Não foi possível carregar a prontidão. Nada mudou nos modos.</p>
        )}
        {nota}
      </div>
    );
  }
  const portoes = portoesDe(alvo, autonomia.thresholds);
  const passaram = portoes.filter((p) => p.passou).length;
  const faltam = faltamNaAmostra(alvo, autonomia.thresholds);
  const nomeDoAlvo = alvoDe(alvo);
  const pendente = alvo.proposal?.status === 'pendente';
  let lite;
  if (alvo.mode === 'SUGGEST') {
    lite = (
      <p className="lite-frase">
        Em <b>{nomeDoAlvo}</b>, ele já mostra a recomendação para você na Atenção. As outras ações seguem em sombra.
      </p>
    );
  } else if (pendente) {
    lite = (
      <p className="lite-frase">
        Em <b>{nomeDoAlvo}</b>, ele passou nos cinco portões. O sistema propõe que ele passe a mostrar essas recomendações para você. Quem decide é{' '}
        {autonomia.can_decide ? 'você' : 'o Dono ou o Administrador'}.
      </p>
    );
  } else {
    lite = (
      <p className="lite-frase">
        <b>Ainda não.</b> Nesta fase ninguém mexe em campanha, e ele ainda nem mostra as recomendações: só registra e compara. O mais perto de mostrar é <b>{nomeDoAlvo}</b>: {passaram} de 5
        portões
        {faltam > 0 ? (
          <>
            ; faltam <b>{faltam}</b> {faltam === 1 ? 'decisão comparável' : 'decisões comparáveis'}
          </>
        ) : null}
        .
      </p>
    );
  }
  // As promoções com o que fazer: a proposta pendente e as ações já em Sugerir; da primeira, também a recusa e a volta.
  const promocoes = autonomia.items.filter((a, i) => a.proposal?.status === 'pendente' || a.mode === 'SUGGEST' || (i === 0 && (a.proposal?.status === 'recusada' || a.proposal?.status === 'desfeita')));
  return (
    <div className="eqp-bloco" id="eqp-prontidao">
      <div className="eqp-bloco-cab">
        <h3>Já pode fazer mais?</h3>
        <span className={seloDoModo(alvo)}>
          {nomeDoAlvo}: {modoEscrito(alvo.mode)}
        </span>
      </div>
      {modo === 'lite' && lite}
      {modo === 'pro' && (
        <>
          <div>
            <div className="portoes-linha">
              <span className="portoes-num">{passaram} de 5</span>
              <span className="card-sub">portões em {nomeDoAlvo}</span>
            </div>
            <div className="portoes" role="img" aria-label={`${passaram} de 5 portões`}>
              {portoes.map((p) => (
                <span key={p.chave} className={p.passou ? 'ok' : undefined} />
              ))}
            </div>
          </div>
          <ul className="sinais">
            {portoes.map((p) => (
              <li key={p.chave}>
                <span className={p.passou ? 's-ok' : 's-alerta'}>
                  <Icone nome={p.passou ? 'check-circle' : 'alert'} />
                  <span className="sr-only">{p.passou ? 'Passou: ' : 'Falta: '}</span>
                </span>
                <span>{p.rotulo}</span>
                <b>{p.valor}</b>
              </li>
            ))}
          </ul>
        </>
      )}
      {promocoes.map((a) => (
        <Promocao key={chaveDe(a)} a={a} agora={agora} podeDecidir={autonomia.can_decide} primeiro={a === alvo} acoes={acoes} />
      ))}
      {modo === 'pro' && (
        <div className="table-wrap">
          <table className="tabela tabela--compacta">
            <caption className="sr-only">Prontidão por conta e por ação</caption>
            <thead>
              <tr>
                <th scope="col">Conta e ação</th>
                <th scope="col">Modo</th>
                <th scope="col" className="n">
                  Portões
                </th>
                <th scope="col">O que falta</th>
              </tr>
            </thead>
            <tbody>
              {autonomia.items.map((a) => {
                const ps = portoesDe(a, autonomia.thresholds);
                const ok = ps.filter((p) => p.passou).length;
                return (
                  <tr key={chaveDe(a)}>
                    <th scope="row">
                      {alvoDe(a)}
                      <span className="sub">{a.account_name}</span>
                    </th>
                    <td>
                      <span className={seloDoModo(a)}>{modoEscrito(a.mode)}</span>
                    </td>
                    <td className="n num">{ok} de 5</td>
                    <td>
                      {ok === 5 ? (
                        <span className="ok-txt">{a.mode === 'SUGGEST' ? 'Já mostra as recomendações' : 'Pronto para propor'}</span>
                      ) : (
                        <>
                          <span className="falta-txt">Falta:</span> {ps.filter((p) => !p.passou).map((p) => p.curto).join('; ')}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {nota}
    </div>
  );
}
