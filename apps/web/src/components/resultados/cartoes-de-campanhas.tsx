'use client';

import type { CampaignTopAd } from '@liame/contracts';
import { useState } from 'react';
import { BotaoPedir, type PedirNaLista } from '@/components/pedir/botao-pedir';
import { Halteres } from './halteres';
import { MiniaturaDoAnuncio, PreviaDoAnuncio } from './imagem-do-anuncio';
import type { CartaoCampanhas as Dados, Celula } from './textos';

// "Por campanha" em cartões, no modo Pro (A3 · I14, parte 2; P44 aprovado em 11/11/2026; D-A3-31 e D-A3-33): cada
// campanha num cartão com a imagem do anúncio que mais gastou, o nome como está na plataforma (inteiro, quebrando a
// linha), a plataforma e a situação, os seis números (investimento, pedidos, receita, custo por pedido, ROAS da
// plataforma e do caixa), a barra plataforma × caixa e "Pedir". A margem e as conversas ficam na tabela.

function Numero({ rotulo, c, forte = false }: { rotulo: string; c: Celula; forte?: boolean }) {
  return (
    <div className={forte ? 'cc-forte' : undefined}>
      <dt>{rotulo}</dt>
      <dd>
        {c.texto}
        {c.sub && <small>{c.sub}</small>}
      </dd>
    </div>
  );
}

export function CartoesDeCampanhas({ campanhas, pedir }: { campanhas: Dados; pedir: PedirNaLista | null }) {
  const [aberta, setAberta] = useState<{ campanha: string; anuncio: CampaignTopAd } | null>(null);
  return (
    <>
      <ul className="cc-cartoes" aria-label="Campanhas do período">
        {campanhas.linhas.map((l) => (
          <li className="cc-cartao" key={l.id}>
            <div className="cc-grade">
              <MiniaturaDoAnuncio anuncio={l.anuncio} aoAbrir={() => l.anuncio && setAberta({ campanha: l.nome, anuncio: l.anuncio })} />
              <div className="cc-cab">
                <b className="cc-nome">{l.nome}</b>
                <span className="camp-canal">
                  <span className={`plat plat--${l.classe}`}>{l.nomePlataforma}</span>
                  {l.situacao}
                </span>
                {l.anuncio && <span className="cc-anuncio">Anúncio: {l.anuncio.name}</span>}
              </div>
              <dl className="cc-nums">
                <Numero rotulo="Investimento" c={l.celulas.investimento} />
                <Numero rotulo="Pedidos" c={l.celulas.pedidos} />
                <Numero rotulo="Receita" c={l.celulas.receita} />
                <Numero rotulo="Custo por pedido" c={l.celulas.custoPorPedido} />
                <Numero rotulo="ROAS da plataforma" c={l.celulas.roasPlataforma} />
                <Numero rotulo="ROAS do caixa" c={l.celulas.roasCaixa} forte />
              </dl>
              {(l.halteres || (pedir && pedir.porCampanha.has(l.id))) && (
                <div className="cc-rodape">
                  {l.halteres ? (
                    <span className="cc-barra">
                      <span className="cc-barra-rot">Plataforma × caixa</span>
                      <Halteres plataforma={l.halteres.plataforma} caixa={l.halteres.caixa} rotulo={l.rotuloHalteres} />
                    </span>
                  ) : (
                    <span />
                  )}
                  {pedir && pedir.porCampanha.has(l.id) && <BotaoPedir campanha={l} pedir={pedir} curto />}
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
      {aberta && <PreviaDoAnuncio campanha={aberta.campanha} anuncio={aberta.anuncio} aoFechar={() => setAberta(null)} />}
    </>
  );
}
