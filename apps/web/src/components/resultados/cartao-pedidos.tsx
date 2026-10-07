'use client';

import type { ClosedLoopResponse, OrderOrigin } from '@liame/contracts';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { Estado } from '@/components/ui/estado';
import { Icone } from '@/components/ui/icone';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { reaisDeMicros } from '@/lib/formato';
import { useDetalhes } from '@/lib/modo';
import { GavetaOrigem } from './gaveta-origem';
import { BotaoDetalhes } from './pecas';
import { confiancaDe, contarPedidos, FILTROS, type FiltroPedidos, filtrarPedidos, LIMITE_DE_PEDIDOS, nomeDoCanal, numeroDoPedido, origemDoPedido } from './pedidos';
import { diaHoraNoFuso } from './textos';

// "Pedido a pedido" (protótipo P1): de onde veio cada pedido, com a evidência e a confiança, sem nome e
// sem telefone. A lista só é pedida à API quando aparece (Pro ou "Ver detalhes"); cada pedido abre a
// gaveta com a origem.

export type ConsultaDePedidos = { brand_id: string; unit_id?: string; from: string; to: string };

type Carga = { tipo: 'parado' } | { tipo: 'carregando' } | { tipo: 'ok'; itens: OrderOrigin[] } | { tipo: 'erro'; problema: Problema };

type Props = {
  /** Nula sem o Regem conectado (não há pedido para mostrar). */
  consulta: ConsultaDePedidos | null;
  fuso: string;
  loja: string | null;
  modelo: ClosedLoopResponse['model'];
  reserva: RefObject<HTMLElement | null>;
};

export function CartaoPedidos({ consulta, fuso, loja, modelo, reserva }: Props) {
  const d = useDetalhes();
  const [carga, setCarga] = useState<Carga>({ tipo: 'parado' });
  const [filtro, setFiltro] = useState<FiltroPedidos>('todos');
  const [aberto, setAberto] = useState<OrderOrigin | null>(null);
  const [anuncio, setAnuncio] = useState('');
  const [tentativa, setTentativa] = useState(0);
  const chave = consulta ? JSON.stringify(consulta) : null;
  // Chave da lista que está na tela: abrir e fechar "Ver detalhes" não pede de novo.
  const naTela = useRef<string | null>(null);

  useEffect(() => {
    if (!d.mostraPro || !chave) return;
    const alvo = `${chave}#${tentativa}`;
    if (naTela.current === alvo) return;
    let vivo = true;
    setCarga({ tipo: 'carregando' });
    const query = { ...(JSON.parse(chave) as ConsultaDePedidos), limit: LIMITE_DE_PEDIDOS };
    disparar(
      chamar(() => api.GET('/v1/results/orders', { params: { query } })).then((r) => {
        if (!vivo) return;
        if (r.ok) naTela.current = alvo;
        setCarga(r.ok ? { tipo: 'ok', itens: r.data.items } : { tipo: 'erro', problema: r.problema });
      }),
    );
    return () => {
      vivo = false;
    };
  }, [d.mostraPro, chave, tentativa]);

  const cabecalho = (
    <div className="card-cab">
      <div>
        <h2 id="t-ped">Pedido a pedido</h2>
        <p className="card-sub">De onde veio cada pedido, com a evidência e a confiança. Sem nome e sem telefone.</p>
      </div>
    </div>
  );

  if (!consulta) {
    return (
      <article className="card" aria-labelledby="t-ped">
        {cabecalho}
        <Estado compacto icone="plug" titulo="Sem o Regem, não há pedidos para mostrar">
          Os pedidos e a origem de cada um aparecem aqui depois da primeira leitura do Regem (os últimos 90 dias).
        </Estado>
      </article>
    );
  }

  const lista = carga.tipo === 'ok' ? carga.itens : [];
  const contagem = contarPedidos(lista);
  const visiveis = filtrarPedidos(lista, filtro);

  function filtrar(f: FiltroPedidos) {
    setFiltro(f);
    const rotulo = FILTROS.find((x) => x.id === f)?.rotulo ?? f;
    setAnuncio(`Filtro: ${rotulo}, ${contagem[f]} ${contagem[f] === 1 ? 'pedido' : 'pedidos'}`);
  }

  return (
    <article className="card" aria-labelledby="t-ped">
      {cabecalho}
      {!d.pro && <BotaoDetalhes aberto={d.aberto} controla="ped-pro" aoAlternar={d.alternar} />}
      <div className="res-pro" id="ped-pro" hidden={!d.mostraPro}>
        {(carga.tipo === 'carregando' || carga.tipo === 'parado') && (
          <div className="ped-carregando" aria-busy="true">
            <p className="sr-only">Carregando os pedidos…</p>
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className="esqueleto" aria-hidden="true" />
            ))}
          </div>
        )}
        {carga.tipo === 'erro' && (
          <div className="dialogo-erro" role="alert">
            <Icone nome="alert" pequeno />
            <span>
              Não deu para carregar os pedidos. {mensagemDe(carga.problema)}{' '}
              <button className="link-bt" type="button" onClick={() => setTentativa((t) => t + 1)}>
                Tentar de novo
              </button>
            </span>
          </div>
        )}
        {carga.tipo === 'ok' && !lista.length && (
          <Estado compacto icone="clock" titulo="Nenhum pedido no período">
            Quando entrar pedido, ele aparece aqui com a origem.
          </Estado>
        )}
        {carga.tipo === 'ok' && lista.length > 0 && (
          <>
            <div className="filtros" role="group" aria-label="Filtrar pedidos">
              {FILTROS.map((f) => (
                <button key={f.id} className="chip" type="button" aria-pressed={filtro === f.id} onClick={() => filtrar(f.id)}>
                  {f.rotulo} <span className="num">{contagem[f.id]}</span>
                </button>
              ))}
            </div>
            <div className="table-wrap">
              <table className="tabela tabela--pedidos">
                <caption className="sr-only">Pedidos do período e a origem de cada um</caption>
                <thead>
                  <tr>
                    <th scope="col">Pedido</th>
                    <th scope="col">Confirmado em</th>
                    <th scope="col">Canal</th>
                    <th scope="col" className="n">
                      Valor
                    </th>
                    <th scope="col">Origem</th>
                    <th scope="col">Confiança</th>
                  </tr>
                </thead>
                <tbody>
                  {visiveis.map((o) => {
                    const numero = numeroDoPedido(o.external_id);
                    const origem = origemDoPedido(o);
                    const conf = confiancaDe(o);
                    const esteAberto = aberto?.order_id === o.order_id;
                    return (
                      <tr key={o.order_id} className={o.status === 'cancelado' ? 'cancelado' : undefined}>
                        <th scope="row">
                          <button
                            className="link-bt num"
                            type="button"
                            aria-haspopup="dialog"
                            aria-expanded={esteAberto}
                            aria-controls={esteAberto ? 'dlg-origem' : undefined}
                            aria-label={`Ver a origem do pedido ${numero.completo}`}
                            title={numero.curto === numero.completo ? undefined : numero.completo}
                            onClick={() => setAberto(o)}
                          >
                            {numero.curto}
                          </button>
                        </th>
                        <td className="num">{diaHoraNoFuso(o.confirmed_at, fuso)}</td>
                        <td>{nomeDoCanal(o)}</td>
                        <td className="n num">
                          <span className="valor">{reaisDeMicros(o.revenue_micros)}</span>
                        </td>
                        <td>
                          {origem.forte ? <b>{origem.principal}</b> : <span>{origem.principal}</span>}
                          {origem.sub && <span className="sub">{origem.sub}</span>}
                        </td>
                        <td>
                          <span className={`st st--${conf.classe}`}>
                            {conf.ponto && <span className="dot" aria-hidden="true" />}
                            {conf.rotulo}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!visiveis.length && <p className="eixo-nota">Nenhum pedido com este filtro.</p>}
            <p className="eixo-nota">
              {lista.length >= LIMITE_DE_PEDIDOS ? `Os ${LIMITE_DE_PEDIDOS} pedidos mais recentes do período. ` : ''}
              Abra um pedido para ver a evidência, a janela e o que o modelo considerou.
            </p>
          </>
        )}
        <p className="sr-only" role="status" aria-live="polite">
          {anuncio}
        </p>
      </div>
      {aberto && <GavetaOrigem pedido={aberto} fuso={fuso} loja={loja} modelo={modelo} reserva={reserva} aoFechar={() => setAberto(null)} />}
    </article>
  );
}
