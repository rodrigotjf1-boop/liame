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
// plataforma e do caixa), a barra plataforma × caixa e "Pedir mudança". A margem e as conversas ficam na tabela.

/** O valor que não é número ("não informa", "—") sai em letra comum, sem o peso dos números. */
const ehNumero = (texto: string) => /\d/.test(texto);

function Numero({ rotulo, c, forte = false, sub }: { rotulo: string; c: Celula; forte?: boolean; sub?: string }) {
  const nota = c.sub ?? sub;
  return (
    <div className={forte ? 'cc-forte' : undefined}>
      <dt>{rotulo}</dt>
      <dd className={ehNumero(c.texto) ? undefined : 'cc-txt'}>
        {c.texto}
        {nota && <small>{nota}</small>}
      </dd>
    </div>
  );
}

/** O selo da situação da campanha: ativa em verde; pausada e as outras, neutras. */
function Situacao({ texto }: { texto: string }) {
  const t = texto.trim();
  const rotulo = t.charAt(0).toLocaleUpperCase('pt-BR') + t.slice(1);
  return <span className={/^ativ/i.test(t) ? 'st st--concluido' : 'st st--neutro'}>{rotulo}</span>;
}

export function CartoesDeCampanhas({ campanhas, pedir }: { campanhas: Dados; pedir: PedirNaLista | null }) {
  const [aberta, setAberta] = useState<{ campanha: string; anuncio: CampaignTopAd; origem: HTMLElement } | null>(null);
  return (
    <>
      <ul className="cc-cartoes" aria-label="Campanhas do período">
        {campanhas.linhas.map((l) => (
          <li className="cc-cartao" key={l.id}>
            <div className="cc-grade">
              <MiniaturaDoAnuncio anuncio={l.anuncio} aoAbrir={(botao) => l.anuncio && setAberta({ campanha: l.nome, anuncio: l.anuncio, origem: botao })} />
              <div className="cc-cab">
                <h3 className="cc-nome">{l.nome}</h3>
                <span className="cc-canal">
                  <span className={`plat plat--${l.classe}`}>{l.nomePlataforma}</span>
                  <Situacao texto={l.situacao} />
                </span>
                {l.anuncio && <span className="cc-anuncio">Anúncio: {l.anuncio.name}</span>}
              </div>
              <dl className="cc-nums">
                <Numero rotulo="Investimento" c={l.celulas.investimento} />
                <Numero rotulo="Pedidos" c={l.celulas.pedidos} />
                <Numero rotulo="Receita" c={l.celulas.receita} />
                <Numero rotulo="Custo por pedido" c={l.celulas.custoPorPedido} />
                <Numero rotulo="ROAS da plataforma" c={l.celulas.roasPlataforma} />
                <Numero rotulo="ROAS do caixa" c={l.celulas.roasCaixa} forte sub={ehNumero(l.celulas.roasCaixa.texto) ? 'janela de 7 dias do Liame' : undefined} />
              </dl>
              {(l.halteres || (pedir && pedir.porCampanha.has(l.id))) && (
                <div className="cc-rodape">
                  {l.halteres && (
                    <span className="cc-barra">
                      <span className="cc-barra-rot">Plataforma × caixa</span>
                      <Halteres plataforma={l.halteres.plataforma} caixa={l.halteres.caixa} rotulo={l.rotuloHalteres} />
                    </span>
                  )}
                  {pedir && pedir.porCampanha.has(l.id) && (
                    <span className="camp-acao">
                      <BotaoPedir campanha={l} pedir={pedir} />
                    </span>
                  )}
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
      {aberta && <PreviaDoAnuncio campanha={aberta.campanha} anuncio={aberta.anuncio} origem={aberta.origem} aoFechar={() => setAberta(null)} />}
    </>
  );
}
