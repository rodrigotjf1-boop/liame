'use client';

import type { ReactNode } from 'react';
import { useDetalhes } from '@/lib/modo';
import { BotaoDetalhes, SeloVeredito, TextoRico } from './pecas';
import type { CartaoRoas as Dados } from './textos';

// Herói da tela (protótipo P1): o ROAS confirmado no caixa, com a frase do dono no Lite; no Pro (ou em
// "Ver detalhes"), cada plataforma com a janela dela ao lado do confirmado no caixa, com a janela do Liame.

export function CartaoRoas({ roas, explicar }: { roas: Dados; /** O botão "Explicar" (A3 · I4), quando há o que explicar. */ explicar?: ReactNode }) {
  const d = useDetalhes();
  return (
    <article className="card res-hero" aria-labelledby="t-roas">
      <div className="card-cab">
        <h2 id="t-roas" className="rotulo-marca">
          {roas.titulo}
        </h2>
        {roas.selos.map((s) => (
          <span key={s} className="st st--aguardando">
            <span className="dot" aria-hidden="true" />
            {s}
          </span>
        ))}
        {explicar}
      </div>
      <p className={`hero-num num${roas.vazio ? ' hero-num--vazio' : ''}`}>{roas.numero}</p>
      {roas.frase && (
        <p className="res-explica">
          <TextoRico frase={roas.frase} />
        </p>
      )}
      {!d.pro && roas.fraseLite && (
        <p className="res-explica">
          <TextoRico frase={roas.fraseLite} />
        </p>
      )}
      {!d.pro && roas.frasePlataformas && <p className="res-explica">{roas.frasePlataformas}</p>}

      {roas.mensagens.length > 0 && (
        <div className="msg-comp" role="group" aria-label="Campanhas de mensagem: custo por conversa e por pedido">
          <p className="rotulo-marca">Campanha de mensagem · conversa × pedido</p>
          {roas.mensagens.map((m) => (
            <div className="msg-comp-linha" key={m.id}>
              <b>{m.campanha}</b>
              <span>
                <b className="num">{m.porConversa}</b> por conversa
              </span>
              <span>
                <b className="num">{m.porPedido}</b> por pedido
              </span>
              <small>{m.taxa}</small>
            </div>
          ))}
        </div>
      )}

      {!d.pro && <BotaoDetalhes aberto={d.aberto} controla="roas-pro" aoAlternar={d.alternar} />}
      <div className="res-pro" id="roas-pro" hidden={!d.mostraPro}>
        <p className="res-explica">
          <TextoRico frase={roas.explicacao} />
        </p>
        {roas.plataformas.length ? (
          <ul className="plat-comp">
            {roas.plataformas.map((p) => (
              <li className="plat-linha" key={p.provider}>
                <div className="plat-linha-cab">
                  <span className="plat-nome">
                    <span className={`plat plat--${p.classe}`}>{p.nome}</span>
                    {p.veredito && <SeloVeredito veredito={p.veredito} />}
                  </span>
                  <span className="plat-invest num">{p.investido}</span>
                </div>
                <div className="roas-par">
                  <div className="roas">
                    <p className="roas-rot">
                      <i aria-hidden="true" />
                      {p.janela}
                    </p>
                    <p className={p.plataforma.vazio ? 'roas-val roas-val--txt' : 'roas-val num'}>{p.plataforma.texto}</p>
                  </div>
                  <div className="roas roas--caixa">
                    <p className="roas-rot">
                      <i aria-hidden="true" />
                      {p.rotuloCaixa}
                    </p>
                    <p className={p.caixa.vazio ? 'roas-val roas-val--txt' : 'roas-val num'}>{p.caixa.texto}</p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="eixo-nota">Nenhuma plataforma de anúncio com gasto ou venda no período.</p>
        )}
        <p className="eixo-nota">As plataformas ainda podem rever os números dos últimos dias. As janelas são diferentes, então os ROAS das plataformas não se somam.</p>
      </div>
    </article>
  );
}
