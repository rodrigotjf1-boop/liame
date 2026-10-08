'use client';

import type { AutonomyItem, AutonomyResponse, TeamResponse, TeamShadowResponse } from '@liame/contracts';
import Link from 'next/link';
import type { Frase } from '@/components/resultados/textos';
import { Icone } from '@/components/ui/icone';
import type { Modo } from '@/lib/modo';
import {
  caixaDaLinha,
  chaveDaLinha,
  classeDoModo,
  confirmacaoDaVolta,
  faltaDaLinha,
  fraseDaLinha,
  linhaDosModos,
  nomeDaLinha,
  notaDosPortoes,
  O_QUE_O_MODO_FAZ,
  portoesDaLinha,
  resumoDosModos,
  rodadaDoGestor,
} from './aprovacao-textos';
import type { AcoesDaProntidao } from './bloco-prontidao';
import { ConfirmaNaLinha } from './pecas';
import { modoEscrito } from './textos';

// Sua equipe com o modo Aprovação (protótipo P11): na ficha do Gestor de tráfego, a rodada da manhã, o modo em cada
// conta e ação (Sombra, Sugerir e Aprovação na mesma tela) e, para a linha escolhida, os portões, a proposta do sistema
// e a volta de um passo. Só aparece para a empresa com o modo Aprovação; as outras seguem com a tela do P7.

const EmFrase = ({ frase }: { frase: Frase }) => <>{frase.map((x, i) => (x.b ? <b key={i}>{x.t}</b> : <span key={i}>{x.t}</span>))}</>;

/** "Rodada de hoje": o que ele pediu, o que deixou na Atenção e o que não conseguiu pedir. */
export function BlocoRodadaDoGestor({ sombra, autonomia, equipe, modo, agora }: { sombra: TeamShadowResponse | null; autonomia: AutonomyResponse; equipe: TeamResponse; modo: Modo; agora: Date }) {
  const r = rodadaDoGestor(sombra, autonomia.items, equipe, agora);
  if (!r) return null;
  return (
    <div className="eqp-bloco" id="eqp-rodada">
      <div className="eqp-bloco-cab">
        <h3>{r.titulo}</h3>
        <span className="eixo-nota">{r.nota}</span>
      </div>
      <p className="lite-frase">
        <EmFrase frase={r.frase} />
      </p>
      {modo === 'pro' && r.passos.length > 0 && (
        <ol className="eqp-passos">
          {r.passos.map((p) => (
            <li className="eqp-passo" key={p.texto}>
              <span className={`eqp-passo-ic${p.falhou ? ' eqp-passo-ic--falha' : ''}`} aria-hidden="true">
                <Icone nome={p.falhou ? 'x' : 'check'} />
              </span>
              <div>
                <p className="eqp-passo-txt">
                  {p.falhou && <span className="sr-only">Não deu certo: </span>}
                  {p.texto}
                </p>
                <div className="ferr">
                  {p.ferramentas.map((f) => (
                    <span key={f}>{f}</span>
                  ))}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
      {(r.aprovacoes || r.naAtencao) && (
        <div className="promocao-acoes">
          {r.aprovacoes && (
            <Link className="btn btn--sm" href={r.aprovacoes.pedido ? `/aprovacoes?pedido=${r.aprovacoes.pedido}` : '/aprovacoes'}>
              {r.aprovacoes.pedido ? 'Ver o pedido em Aprovações' : 'Ver os pedidos em Aprovações'}
            </Link>
          )}
          {r.naAtencao && (
            <Link className="btn btn--sm" href="/atencao">
              Ver na Atenção
            </Link>
          )}
        </div>
      )}
      {r.aviso && <p className="explica-nota">{r.aviso}</p>}
    </div>
  );
}

/** "Como ele trabalha em cada conta": uma linha por conta e ação, que também escolhe o que o bloco da prontidão mostra. */
export function BlocoModos({ autonomia, modo, alvo, aoEscolher }: { autonomia: AutonomyResponse; modo: Modo; alvo: AutonomyItem; aoEscolher: (chave: string) => void }) {
  const itens = autonomia.items;
  const escolhida = chaveDaLinha(alvo);
  return (
    <div className="eqp-bloco" id="eqp-modos">
      <div className="eqp-bloco-cab">
        <h3>Como ele trabalha em cada conta</h3>
        <span className="eixo-nota">{resumoDosModos(itens)}</span>
      </div>
      <p className="card-sub">O modo é por conta e por ação. Escolha uma linha para ver o que falta para ele fazer mais.</p>
      <ul className="modos-lista" aria-label="Modo por conta e ação">
        {itens.map((a) => {
          const l = linhaDosModos(a, itens);
          return (
            <li key={l.chave}>
              <button className="modos-item" type="button" id={`eqp-linha-${l.chave}`} aria-current={l.chave === escolhida ? 'true' : undefined} onClick={() => aoEscolher(l.chave)}>
                <b>{l.nome}</b>
                <span className={l.classe}>{l.modo}</span>
                <span className="modos-oque">{l.oque}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {modo === 'pro' && (
        <ul className="modos-legenda" aria-label="O que cada modo quer dizer">
          <li>
            <span className={classeDoModo('SHADOW')}>Sombra</span>
            <span>{O_QUE_O_MODO_FAZ.SHADOW} Nada aparece para você.</span>
          </li>
          <li>
            <span className={classeDoModo('SUGGEST')}>Sugerir</span>
            <span>{O_QUE_O_MODO_FAZ.SUGGEST}</span>
          </li>
          <li>
            <span className={classeDoModo('APPROVAL')}>Aprovação</span>
            <span>{O_QUE_O_MODO_FAZ.APPROVAL} Nada é executado antes disso.</span>
          </li>
        </ul>
      )}
    </div>
  );
}

function CaixaDaLinha({ a, autonomia, agora, acoes }: { a: AutonomyItem; autonomia: AutonomyResponse; agora: Date; acoes: AcoesDaProntidao }) {
  const c = caixaDaLinha(a, autonomia.items, autonomia.thresholds, agora);
  if (!c) return null;
  const chave = chaveDaLinha(a);
  const proposta = c.proposta;
  let botoes = null;
  if (!autonomia.can_decide) {
    botoes =
      proposta || c.voltar ? (
        <p className="nota">
          <Icone nome="lock" />
          <span>Só o Dono e o Administrador aprovam a promoção e voltam um passo. Você acompanha por aqui.</span>
        </p>
      ) : null;
  } else if (proposta) {
    botoes = (
      <div className="promocao-acoes">
        {acoes.recusando === proposta.id ? (
          <ConfirmaNaLinha
            texto={`Recusar a promoção? Ele segue em ${modoEscrito(a.mode)} nesta ação.`}
            rotulo="Recusar"
            rotuloOcupado="Recusando…"
            ocupado={acoes.ocupado === `recusar:${proposta.id}`}
            aoConfirmar={() => acoes.aoRecusar(a)}
            aoCancelar={() => acoes.aoPedirRecusa(null)}
          />
        ) : (
          <>
            <button
              className="btn btn--primary"
              type="button"
              id={`eqp-bt-aprovar-${proposta.id}`}
              onClick={() => acoes.aoAprovar(a)}
              disabled={acoes.ocupado !== null}
              aria-busy={acoes.ocupado === `aprovar:${proposta.id}`}
            >
              <Icone nome="check" pequeno />
              {acoes.ocupado === `aprovar:${proposta.id}` ? 'Aprovando…' : 'Aprovar a promoção'}
            </button>
            <button className="btn" type="button" id={`eqp-bt-recusar-${proposta.id}`} onClick={() => acoes.aoPedirRecusa(proposta.id)} disabled={acoes.ocupado !== null}>
              Recusar
            </button>
          </>
        )}
      </div>
    );
  } else if (c.voltar) {
    const confirma = confirmacaoDaVolta(a);
    botoes = (
      <div className="promocao-acoes">
        {acoes.voltando === chave ? (
          <ConfirmaNaLinha
            texto={confirma.texto}
            rotulo={confirma.rotulo}
            rotuloOcupado="Voltando…"
            ocupado={acoes.ocupado === `voltar:${chave}`}
            aoConfirmar={() => acoes.aoVoltarParaSombra(a)}
            aoCancelar={() => acoes.aoPedirVolta(null)}
          />
        ) : (
          <button className="btn" type="button" id={`eqp-bt-voltar-${chave}`} onClick={() => acoes.aoPedirVolta(chave)} disabled={acoes.ocupado !== null}>
            <Icone nome="undo" pequeno />
            Voltar para {c.voltar}
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="promocao" role={proposta ? 'region' : undefined} aria-labelledby={proposta ? 'eqp-caixa-t' : undefined}>
      <h4 id="eqp-caixa-t" tabIndex={-1}>
        {c.titulo}
      </h4>
      {c.sub && <p className="card-sub">{c.sub}</p>}
      {c.texto && (
        <p>
          <EmFrase frase={c.texto} />
        </p>
      )}
      {c.pontos.length > 0 && (
        <ul className="eqp-lite">
          {c.pontos.map((p) => (
            <li key={p.forte}>
              <b>{p.forte}</b> {p.texto}
            </li>
          ))}
        </ul>
      )}
      {proposta && <p className="explica-nota">Fica registrado quem aprovou, quando e a versão da regra de autonomia. Dá para voltar um passo a qualquer momento.</p>}
      {botoes}
    </div>
  );
}

/** "Já pode fazer mais?", para a linha escolhida: os portões (cinco ou sete), a proposta e a volta de um passo. */
export function BlocoDaLinha({ autonomia, alvo, modo, agora, acoes }: { autonomia: AutonomyResponse; alvo: AutonomyItem; modo: Modo; agora: Date; acoes: AcoesDaProntidao }) {
  const itens = autonomia.items;
  const nome = nomeDaLinha(alvo, itens);
  const portoes = portoesDaLinha(alvo, autonomia.thresholds);
  const [passaram, total] = [portoes.filter((p) => p.passou).length, portoes.length];
  const noModoMaisAlto = alvo.mode === 'APPROVAL';
  return (
    <div className="eqp-bloco" id="eqp-prontidao">
      <div className="eqp-bloco-cab">
        <h3>Já pode fazer mais?</h3>
        <span className={classeDoModo(alvo.mode)}>
          {nome}: {modoEscrito(alvo.mode)}
        </span>
      </div>
      {modo === 'lite' && (
        <p className="lite-frase">
          <EmFrase frase={fraseDaLinha(alvo, itens, autonomia.thresholds, autonomia.can_decide)} />
        </p>
      )}
      {modo === 'pro' && !noModoMaisAlto && (
        <>
          <div>
            <div className="portoes-linha">
              <span className="portoes-num">
                {passaram} de {total}
              </span>
              <span className="card-sub">portões em {nome}</span>
            </div>
            <div className={`portoes${total === 7 ? ' portoes--7' : ''}`} role="img" aria-label={`${passaram} de ${total} portões`}>
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
      <CaixaDaLinha a={alvo} autonomia={autonomia} agora={agora} acoes={acoes} />
      {modo === 'pro' && (
        <div className="table-wrap">
          <table className="tabela tabela--compacta tabela--pilha">
            <caption className="sr-only">Modo e prontidão por conta e por ação</caption>
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
              {itens.map((a) => {
                const f = faltaDaLinha(a, autonomia.thresholds);
                return (
                  <tr key={chaveDaLinha(a)}>
                    <th scope="row">{nomeDaLinha(a, itens)}</th>
                    <td data-rot="Modo">
                      <span className={classeDoModo(a.mode)}>{modoEscrito(a.mode)}</span>
                    </td>
                    <td className="n num" data-rot="Portões">
                      {f.portoes}
                    </td>
                    <td className="larga" data-rot="O que falta">
                      {f.ok ? (
                        <span className="ok-txt">{f.texto}</span>
                      ) : f.falta ? (
                        <>
                          <span className="falta-txt">Falta:</span> {f.texto}
                        </>
                      ) : (
                        f.texto
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="explica-nota">{notaDosPortoes(autonomia.thresholds)}</p>
    </div>
  );
}
