'use client';

import type { CouponItem, CouponRequest, CouponStore, OrderPlatform } from '@liame/contracts';
import { useEffect, useRef, useState } from 'react';
import { inteiro, reaisDeMicros } from '@/lib/formato';
import { disparar } from '@/lib/disparar';
import {
  type FiltroCupom,
  filtrarCupons,
  infoPlataforma,
  nomeDaLoja,
  regraDoCupom,
  regraDoPedido,
  semUsoComGasto,
  situacaoDoCupom,
  situacaoDoPedido,
  textoVinculo,
  validadeDoCupom,
  validadeDoPedido,
} from './cupons-textos';
import { classePlataforma, rotuloPlataforma } from './textos';

// Os cupons da loja (protótipo P3): código (e a plataforma, no informado), regra e validade, usos em 7 dias,
// a campanha ligada e a ação. No topo, os pedidos de criação que ainda não viraram cupom no Regem (esperando
// aprovação ou sendo criados). Filtros por ligação; desligar e cancelar o pedido pedem confirmação na própria
// linha. No celular, cada linha vira um cartão.

type Props = {
  itens: CouponItem[];
  /** Pedidos de criação em andamento (o cupom ainda não existe no Regem). */
  pedidos?: CouponRequest[];
  loja: CouponStore;
  agora: Date;
  podeGerenciar: boolean;
  /** Quem pede a criação também cancela o pedido. */
  podeCriarCupom?: boolean;
  aoLigar: (c: CouponItem) => void;
  aoDesligar: (c: CouponItem) => Promise<boolean>;
  aoCancelarPedido?: (p: CouponRequest) => Promise<boolean>;
};

const FILTROS: { valor: FiltroCupom; rotulo: string }[] = [
  { valor: 'todos', rotulo: 'Todos' },
  { valor: 'ligados', rotulo: 'Ligados a campanha' },
  { valor: 'sem', rotulo: 'Sem campanha' },
];

export function TabelaCupons({ itens, pedidos = [], loja, agora, podeGerenciar, podeCriarCupom = false, aoLigar, aoDesligar, aoCancelarPedido }: Props) {
  const [filtro, setFiltro] = useState<FiltroCupom>('todos');
  /** A linha com a confirmação aberta: o id do cupom ou o da ação do pedido. */
  const [confirmando, setConfirmando] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const confirmar = useRef<HTMLButtonElement>(null);
  const visiveis = filtrarCupons(itens, filtro);
  // O pedido já nasce com a campanha: entra em "Todos" e em "Ligados a campanha".
  const pedidosDoFiltro = (f: FiltroCupom) => (f === 'sem' ? [] : pedidos);
  const pedidosVisiveis = pedidosDoFiltro(filtro);

  useEffect(() => {
    if (confirmando) confirmar.current?.focus();
  }, [confirmando]);

  async function confirmarAcao(acao: () => Promise<boolean>) {
    setOcupado(true);
    const ok = await acao();
    setOcupado(false);
    if (ok) setConfirmando(null);
  }

  return (
    <>
      <div className="filtros" role="group" aria-label="Filtrar cupons">
        {FILTROS.map((f) => (
          <button key={f.valor} className="chip" type="button" aria-pressed={filtro === f.valor} onClick={() => setFiltro(f.valor)}>
            {f.rotulo} <span className="num">{filtrarCupons(itens, f.valor).length + pedidosDoFiltro(f.valor).length}</span>
          </button>
        ))}
      </div>
      <div className="table-wrap lista-cartoes">
        <table className="tabela tabela--cupons">
          <caption className="sr-only">Cupons da {nomeDaLoja(loja)}</caption>
          <thead>
            <tr>
              <th scope="col">Cupom</th>
              <th scope="col">Regra e validade</th>
              <th scope="col" className="n">
                Usos em 7 dias
              </th>
              <th scope="col">Campanha</th>
              <th scope="col">
                <span className="sr-only">Ações</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {pedidosVisiveis.map((p) => {
              const aguardando = situacaoDoPedido(p) === 'aguardando';
              return (
                <tr key={p.action_id} className="cupom-pendente">
                  <th scope="row">
                    <span className="cupom-cod">{p.code}</span>
                    <span className="cupom-estado">
                      <span className="st st--aguardando">
                        <span className="dot" aria-hidden="true" />
                        {aguardando ? 'Aguardando aprovação' : 'Criando no Regem'}
                      </span>
                    </span>
                  </th>
                  <td className="cupom-regra" data-rot="Regra e validade">
                    {regraDoPedido(p)}
                    <span className="sub">{validadeDoPedido(p)}</span>
                  </td>
                  <td className="n num" data-rot="Usos em 7 dias">
                    —<span className="sub">ainda não existe no Regem</span>
                  </td>
                  <td data-rot="Campanha">
                    {p.campaign ? (
                      <span className="camp-cel">
                        <span className="linha">
                          <b>{p.campaign.name}</b>
                          <span className={classePlataforma(p.campaign.provider)}>{rotuloPlataforma(p.campaign.provider)}</span>
                        </span>
                        <small>{p.exclusive ? 'exclusivo · prova a origem' : 'não exclusivo · só acompanha'}</small>
                      </span>
                    ) : (
                      <span className="eixo-nota">Sem campanha</span>
                    )}
                  </td>
                  <td className="acoes">
                    {aguardando &&
                      podeCriarCupom &&
                      aoCancelarPedido &&
                      (confirmando === p.action_id ? (
                        <span className="confirma-linha">
                          <span className="confirma-txt">O pedido de aprovação sai da fila e o cupom não é criado.</span>
                          <button
                            ref={confirmar}
                            className="btn btn--sm btn--perigo-cheio"
                            type="button"
                            onClick={() => disparar(confirmarAcao(() => aoCancelarPedido(p)))}
                            disabled={ocupado}
                            aria-busy={ocupado}
                          >
                            {ocupado ? 'Cancelando…' : 'Cancelar o pedido'}
                          </button>
                          <button className="btn btn--sm" type="button" onClick={() => setConfirmando(null)} disabled={ocupado}>
                            Manter
                          </button>
                        </span>
                      ) : (
                        <button className="btn btn--sm btn--ghost" type="button" onClick={() => setConfirmando(p.action_id)} aria-label={`Cancelar o pedido do cupom ${p.code}`}>
                          Cancelar pedido
                        </button>
                      ))}
                  </td>
                </tr>
              );
            })}
            {visiveis.map((c) => {
              const situacao = situacaoDoCupom(c);
              const semUso = semUsoComGasto(c);
              return (
                <tr key={c.id} className={situacao === 'vencido' ? 'cupom-vencido' : undefined}>
                  <th scope="row">
                    <span className="cupom-cod">{c.code}</span>
                    {c.origin === 'externo' && c.platform && <> <span className="plat">{infoPlataforma(c.platform as OrderPlatform).nome}</span></>}
                    {situacao && (
                      <span className="cupom-estado">
                        <span className="st st--espera">{situacao === 'vencido' ? 'Vencido' : 'Desativado'}</span>
                      </span>
                    )}
                  </th>
                  <td className="cupom-regra" data-rot="Regra e validade">
                    {regraDoCupom(c, agora)}
                    <span className="sub">{validadeDoCupom(c, loja, agora)}</span>
                  </td>
                  <td className="n num" data-rot="Usos em 7 dias">
                    {inteiro(c.uses_7d)}
                    {semUso ? (
                      <span className="sub sub--atencao">sem uso, com {reaisDeMicros(c.link!.campaign_spend_7d_micros!)} gastos</span>
                    ) : (
                      c.uses_7d > 0 && <span className="sub">{reaisDeMicros(c.revenue_7d_micros)} em pedidos</span>
                    )}
                  </td>
                  <td data-rot="Campanha">
                    {c.link ? (
                      <span className="camp-cel">
                        <span className="linha">
                          <b>{c.link.campaign.name}</b>
                          <span className={classePlataforma(c.link.campaign.provider)}>{rotuloPlataforma(c.link.campaign.provider)}</span>
                        </span>
                        <small>{textoVinculo(c, loja, agora)}</small>
                      </span>
                    ) : (
                      <span className="eixo-nota">Sem campanha</span>
                    )}
                  </td>
                  <td className="acoes">
                    {c.link ? (
                      podeGerenciar &&
                      (confirmando === c.id ? (
                        <span className="confirma-linha">
                          <span className="confirma-txt">Os usos até agora continuam valendo; os próximos não contam para a campanha.</span>
                          <button
                            ref={confirmar}
                            className="btn btn--sm btn--perigo-cheio"
                            type="button"
                            onClick={() => disparar(confirmarAcao(() => aoDesligar(c)))}
                            disabled={ocupado}
                            aria-busy={ocupado}
                          >
                            {ocupado ? 'Desligando…' : 'Desligar agora'}
                          </button>
                          <button className="btn btn--sm" type="button" onClick={() => setConfirmando(null)} disabled={ocupado}>
                            Cancelar
                          </button>
                        </span>
                      ) : (
                        <button className="btn btn--sm btn--ghost" type="button" onClick={() => setConfirmando(c.id)} aria-label={`Desligar ${c.code} da campanha ${c.link.campaign.name}`}>
                          Desligar
                        </button>
                      ))
                    ) : situacao ? (
                      <span className="eixo-nota">{situacao === 'vencido' ? 'Vencido no Regem' : 'Desativado no Regem'}</span>
                    ) : (
                      podeGerenciar && (
                        <button className="btn btn--sm" type="button" aria-haspopup="dialog" onClick={() => aoLigar(c)} aria-label={`Ligar ${c.code} a uma campanha`}>
                          Ligar a campanha
                        </button>
                      )
                    )}
                  </td>
                </tr>
              );
            })}
            {!visiveis.length && !pedidosVisiveis.length && (
              <tr>
                <td colSpan={5}>
                  <span className="eixo-nota">Nenhum cupom com este filtro.</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="eixo-nota">
        Só cupom exclusivo prova de onde veio o pedido: ele vale no cardápio, no WhatsApp, no balcão e nas plataformas de pedidos que chegam ao Regem. Cupom que aparece em
        outros lugares fica ligado só para acompanhar.
      </p>
    </>
  );
}
