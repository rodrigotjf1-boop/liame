'use client';

import type { AdPieceOptionsResponse, AdPieceRequestResponse, AdPieceResponse } from '@liame/contracts';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ListaDeFontes, TextoComNumeros, useFontes } from '@/components/resumo/numeros';
import { Fontes } from '@/components/resumo/textos';
import { Estado } from '@/components/ui/estado';
import { Faixa } from '@/components/ui/faixa';
import { Icone } from '@/components/ui/icone';
import { inteiro } from '@/lib/formato';
import { avisosDaTela, ehBarrada, nomeDoCartao, paraDecidir, pedidoEmAndamento, pedidoQueNaoDeuCerto, situacaoDaPeca, temAviso, usoDeIa } from './textos';

// A tela Criativos (protótipo P10): o uso de IA, o pedido que o Criativo está fazendo, o que espera decisão, a
// biblioteca (aprovadas e recusadas) e os anúncios que já vendem, de onde ele parte.

interface Props {
  opcoes: AdPieceOptionsResponse;
  pecas: AdPieceResponse[];
  pedidos: AdPieceRequestResponse[];
  /** A pessoa pede e decide peças (`campanhas.operar`). */
  pode: boolean;
  pro: boolean;
  agora: Date;
  filtro: 'aprovadas' | 'recusadas';
  confirmandoLote: boolean;
  ocupado: string | null;
  botaoDoVazio: ReactNode;
  aoFiltrar: (f: 'aprovadas' | 'recusadas') => void;
  aoAbrir: (id: string) => void;
  /** Abre o pedido de peça, opcionalmente a partir de um anúncio que já vendeu. */
  aoPedir: (anuncio?: string | null) => void;
  aoPedirLote: (pedir: boolean) => void;
  aoAprovarLote: (pecas: AdPieceResponse[]) => void;
}

function CartaoDaPeca({ p, pro, aoAbrir }: { p: AdPieceResponse; pro: boolean; aoAbrir: (id: string) => void }) {
  const sit = situacaoDaPeca(p);
  const barrada = p.status === 'decidir' && !p.redoing && ehBarrada(p);
  return (
    <li>
      <button className="peca-card" type="button" id={`cri-peca-${p.id}`} data-barrada={barrada ? '' : undefined} aria-label={nomeDoCartao(p)} onClick={() => aoAbrir(p.id)}>
        <span className="pc-corpo">
          <span className="pc-tit">{p.current.title}</span>
          <span className="pc-txt">{p.current.body}</span>
          <span className="pc-pe">
            <span className={sit.classe}>{sit.rotulo}</span>
            {p.status === 'decidir' && !p.redoing && temAviso(p) && <span className="st st--espera">Com aviso</span>}
            {p.ai_generated && (
              <span className="st st--ia">
                <Icone nome="sparkles" pequeno />
                Texto feito com IA
              </span>
            )}
            {pro && <span className="st st--neutro">v{p.current.version}</span>}
          </span>
          <span className="pc-uso">{p.offer}</span>
        </span>
      </button>
    </li>
  );
}

export function CriativosLista({ opcoes, pecas, pedidos, pode, pro, agora, filtro, confirmandoLote, ocupado, botaoDoVazio, aoFiltrar, aoAbrir, aoPedir, aoPedirLote, aoAprovarLote }: Props) {
  const fontes = new Fontes();
  const uso = opcoes.ai ? usoDeIa(opcoes.ai, opcoes.usd_brl, fontes) : null;
  const periodo = opcoes.reference_period;
  const anuncios = opcoes.reference_ads.map((a) => ({
    ...a,
    pedidos: fontes.n(inteiro(a.orders), `Regem · pedidos confirmados no caixa com origem no anúncio “${a.name}” · de ${periodo.from.slice(8)}/${periodo.from.slice(5, 7)} a ${periodo.to.slice(8)}/${periodo.to.slice(5, 7)}`),
  }));
  const estado = useFontes(fontes.lista);
  const avisos = avisosDaTela(opcoes, pode);
  const andando = opcoes.in_progress ? pedidoEmAndamento(opcoes.in_progress, agora) : null;
  // O pedido de peças novas mais recente, quando não deu certo e nenhum outro veio depois.
  const ultimo = pedidos.filter((r) => r.piece_id === null)[0] ?? null;
  const falhou = !andando && ultimo ? pedidoQueNaoDeuCerto(ultimo, agora) : null;
  const decidir = paraDecidir(pecas, pode);
  const emDecisao = pecas.filter((p) => p.status === 'decidir');
  const aprovadas = pecas.filter((p) => p.status === 'aprovada');
  const recusadas = pecas.filter((p) => p.status === 'recusada');
  const daBiblioteca = filtro === 'recusadas' ? recusadas : aprovadas;
  const semNada = !pecas.length && !andando;
  const podePedir = opcoes.available;

  const chip = (id: 'aprovadas' | 'recusadas', rotulo: string, n: number) => (
    <button className="chip" type="button" id={`cri-filtro-${id}`} aria-pressed={filtro === id} onClick={() => aoFiltrar(id)}>
      {rotulo}
      <span className="num">{n}</span>
    </button>
  );

  return (
    <div className="cri">
      {avisos.map((a) => (
        <Faixa
          key={a.chave}
          tipo={a.tipo}
          icone={<Icone nome={a.icone} />}
          titulo={a.titulo}
          texto={<span id={a.chave === 'leitor' ? undefined : 'cri-sem-pedir'}>{a.texto}</span>}
          acao={
            a.link ? (
              <Link className="btn" href={a.link.href}>
                {a.link.rotulo}
              </Link>
            ) : undefined
          }
        />
      ))}

      {uso && (
        <div className="cri-uso" role="group" aria-label="Uso de IA">
          <p>
            <TextoComNumeros texto={uso.texto} lista={fontes.lista} aoTocar={estado.mostrar} />
            {pro && ' O limite é da empresa inteira, para todos os funcionários de IA.'}
          </p>
          <div className={`cri-uso-barra${uso.cheio ? ' cri-uso-barra--cheia' : ''}`} role="img" aria-label={`${uso.porcento}% do limite de IA usado`} style={{ ['--p' as string]: uso.porcento }}>
            <i />
          </div>
        </div>
      )}

      {semNada ? (
        <div className="card">
          <Estado icone="image" titulo="Nenhuma peça ainda" acao={botaoDoVazio ? <div className="vazio-acoes">{botaoDoVazio}</div> : undefined}>
            O Criativo é o funcionário de IA que escreve o texto dos anúncios. Ele parte da sua oferta em Minha marca e do anúncio que mais vendeu. O Compliance confere cada peça antes de ela aparecer.
          </Estado>
        </div>
      ) : (
        <>
          {andando && (
            <article className="card" aria-labelledby="lote-t" aria-busy="true">
              <div className="card-cab">
                <div>
                  <h2 id="lote-t" tabIndex={-1}>
                    {andando.titulo}
                  </h2>
                  <p className="card-sub">{andando.sub}</p>
                </div>
              </div>
              <p className="sr-only" role="status">
                O Criativo está fazendo as peças.
              </p>
              <ol className="passos" id="lote-passos">
                {andando.passos.map((s) => (
                  <li key={s.titulo}>
                    <span className={`passo${s.situacao === 'ok' ? '' : ` passo--${s.situacao}`}`} aria-hidden="true">
                      <Icone nome={s.situacao === 'ok' ? 'check' : s.situacao === 'agora' ? 'refresh' : 'arrow-right'} />
                    </span>
                    <span>
                      <b>{s.titulo}</b>
                      <small>{s.sub}</small>
                    </span>
                  </li>
                ))}
              </ol>
              <p className="eixo-nota">Leva cerca de um minuto. Você pode sair desta tela: as peças ficam aqui, em “Para decidir”.</p>
            </article>
          )}

          {falhou && (
            <article className="card" aria-labelledby="lote-t">
              <div className="card-cab">
                <div>
                  <h2 id="lote-t" tabIndex={-1}>
                    {falhou.titulo}
                  </h2>
                  <p className="card-sub">{falhou.sub}</p>
                </div>
              </div>
              <Faixa
                tipo={falhou.tipo}
                icone={<Icone nome={falhou.tipo === 'perigo' ? 'alert-circle' : 'ban'} />}
                titulo={falhou.aviso}
                texto={falhou.texto}
                acao={
                  pode ? (
                    <button className="btn btn--primary" type="button" onClick={() => aoPedir()} aria-haspopup="dialog" aria-disabled={podePedir ? undefined : 'true'}>
                      <Icone nome="refresh" />
                      Pedir de novo
                    </button>
                  ) : undefined
                }
              />
            </article>
          )}

          {decidir && (
            <article className="card" aria-labelledby="dec-t">
              <div className="card-cab">
                <div>
                  <h2 id="dec-t" tabIndex={-1}>
                    Para decidir
                  </h2>
                  <p className="card-sub">O que espera a decisão de quem opera campanhas</p>
                </div>
                {pode && decidir.passam.length > 1 && !confirmandoLote && (
                  <button className="btn btn--sm" type="button" id="cri-bt-lote" onClick={() => aoPedirLote(true)}>
                    <Icone nome="check" pequeno />
                    Aprovar as {decidir.passam.length} que passaram
                  </button>
                )}
              </div>
              <p className="lite-frase lite-frase--grande">
                {decidir.frase.map((x, i) => (x.b ? <b key={i}>{x.t}</b> : <span key={i}>{x.t}</span>))}
              </p>
              {pode && decidir.passam.length > 1 && confirmandoLote && (
                <div className="lote-confirma">
                  <p>
                    <b id="lote-confirma-t" tabIndex={-1}>
                      {decidir.confirmacao.split('?')[0]}?
                    </b>
                    {decidir.confirmacao.split('?').slice(1).join('?')}
                  </p>
                  <div className="lote-acoes">
                    <button className="btn btn--primary btn--sm" type="button" onClick={() => aoAprovarLote(decidir.passam)} disabled={ocupado !== null} aria-busy={ocupado === 'lote'}>
                      {ocupado === 'lote' ? 'Aprovando…' : `Aprovar as ${decidir.passam.length}`}
                    </button>
                    <button className="btn btn--sm" type="button" onClick={() => aoPedirLote(false)} disabled={ocupado !== null}>
                      Cancelar
                    </button>
                  </div>
                </div>
              )}
              <ul className="pecas">
                {emDecisao.map((p) => (
                  <CartaoDaPeca key={p.id} p={p} pro={pro} aoAbrir={aoAbrir} />
                ))}
              </ul>
            </article>
          )}

          <article className="card" aria-labelledby="bib-t">
            <div className="card-cab">
              <div>
                <h2 id="bib-t" tabIndex={-1}>
                  Biblioteca
                </h2>
                <p className="card-sub">As peças aprovadas e o que foi recusado, com o motivo.</p>
              </div>
            </div>
            <div className="filtros" role="group" aria-label="Filtrar as peças">
              {chip('aprovadas', 'Aprovadas', aprovadas.length)}
              {chip('recusadas', 'Recusadas', recusadas.length)}
            </div>
            {daBiblioteca.length ? (
              <ul className="pecas">
                {daBiblioteca.map((p) => (
                  <CartaoDaPeca key={p.id} p={p} pro={pro} aoAbrir={aoAbrir} />
                ))}
              </ul>
            ) : filtro === 'aprovadas' ? (
              <Estado icone="image" titulo="Nenhuma peça aprovada ainda" compacto>
                As peças que você aprovar ficam guardadas aqui.
              </Estado>
            ) : (
              <Estado icone="check-circle" titulo="Nenhuma peça recusada" compacto>
                O que você recusar fica guardado aqui, com o motivo.
              </Estado>
            )}
          </article>
        </>
      )}

      {anuncios.length > 0 && (
        <article className="card" aria-labelledby="noar-t">
          <div className="card-cab">
            <div>
              <h2 id="noar-t">O que já vende</h2>
              <p className="card-sub">Os anúncios da marca com pedidos confirmados no caixa do Regem nos últimos 7 dias. O Criativo pode partir do que vendeu.</p>
            </div>
          </div>
          <ul className="noar">
            {anuncios.map((a) => (
              <li key={a.ad_id}>
                <span className="noar-txt">
                  <b>{a.name}</b>
                  <span>
                    <TextoComNumeros texto={[{ num: a.pedidos }, { t: ` ${a.orders === 1 ? 'pedido' : 'pedidos'} em 7 dias${a.campaign ? ` · campanha ${a.campaign}` : ''}` }]} lista={fontes.lista} aoTocar={estado.mostrar} />
                  </span>
                </span>
                {pode && (
                  <button className="btn btn--sm" type="button" onClick={() => aoPedir(a.ad_id)} aria-haspopup="dialog" aria-label={`Fazer variações de ${a.name}`} aria-disabled={podePedir ? undefined : 'true'}>
                    Fazer variações
                  </button>
                )}
              </li>
            ))}
          </ul>
        </article>
      )}

      <ListaDeFontes lista={fontes.lista} estado={estado} id="cri-fontes" />
    </div>
  );
}
