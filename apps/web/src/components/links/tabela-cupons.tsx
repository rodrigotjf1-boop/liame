'use client';

import type { CouponItem, CouponStore, OrderPlatform } from '@liame/contracts';
import { useEffect, useRef, useState } from 'react';
import { inteiro, reaisDeMicros } from '@/lib/formato';
import { disparar } from '@/lib/disparar';
import { type FiltroCupom, filtrarCupons, infoPlataforma, nomeDaLoja, regraDoCupom, semUsoComGasto, situacaoDoCupom, textoVinculo, validadeDoCupom } from './cupons-textos';
import { classePlataforma, rotuloPlataforma } from './textos';

// Os cupons da loja (protótipo P3): código (e a plataforma, no informado), regra e validade, usos em 7 dias,
// a campanha ligada e a ação. Filtros por ligação; desligar pede confirmação na própria linha. No celular,
// cada linha vira um cartão.

type Props = {
  itens: CouponItem[];
  loja: CouponStore;
  agora: Date;
  podeGerenciar: boolean;
  aoLigar: (c: CouponItem) => void;
  aoDesligar: (c: CouponItem) => Promise<boolean>;
};

const FILTROS: { valor: FiltroCupom; rotulo: string }[] = [
  { valor: 'todos', rotulo: 'Todos' },
  { valor: 'ligados', rotulo: 'Ligados a campanha' },
  { valor: 'sem', rotulo: 'Sem campanha' },
];

export function TabelaCupons({ itens, loja, agora, podeGerenciar, aoLigar, aoDesligar }: Props) {
  const [filtro, setFiltro] = useState<FiltroCupom>('todos');
  const [confirmando, setConfirmando] = useState<string | null>(null);
  const [desligando, setDesligando] = useState(false);
  const confirmar = useRef<HTMLButtonElement>(null);
  const visiveis = filtrarCupons(itens, filtro);

  useEffect(() => {
    if (confirmando) confirmar.current?.focus();
  }, [confirmando]);

  async function desligarAgora(c: CouponItem) {
    setDesligando(true);
    const ok = await aoDesligar(c);
    setDesligando(false);
    if (ok) setConfirmando(null);
  }

  return (
    <>
      <div className="filtros" role="group" aria-label="Filtrar cupons">
        {FILTROS.map((f) => (
          <button key={f.valor} className="chip" type="button" aria-pressed={filtro === f.valor} onClick={() => setFiltro(f.valor)}>
            {f.rotulo} <span className="num">{filtrarCupons(itens, f.valor).length}</span>
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
            {visiveis.length ? (
              visiveis.map((c) => {
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
                            <button ref={confirmar} className="btn btn--sm btn--perigo-cheio" type="button" onClick={() => disparar(desligarAgora(c))} disabled={desligando} aria-busy={desligando}>
                              {desligando ? 'Desligando…' : 'Desligar agora'}
                            </button>
                            <button className="btn btn--sm" type="button" onClick={() => setConfirmando(null)} disabled={desligando}>
                              Cancelar
                            </button>
                          </span>
                        ) : (
                          <button
                            className="btn btn--sm btn--ghost"
                            type="button"
                            onClick={() => setConfirmando(c.id)}
                            aria-label={`Desligar ${c.code} da campanha ${c.link.campaign.name}`}
                          >
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
              })
            ) : (
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
