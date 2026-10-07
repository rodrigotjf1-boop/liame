'use client';

import type { ClosedLoopResponse } from '@liame/contracts';
import Link from 'next/link';
import { type RefObject, useRef } from 'react';
import { BlocoExplicacao } from '@/components/explicar/bloco-explicacao';
import { BotaoExplicar } from '@/components/explicar/botao-explicar';
import type { PedidoDeExplicacao } from '@/components/explicar/pedir';
import { useExplicacao } from '@/components/explicar/use-explicacao';
import type { PedirNaLista } from '@/components/pedir/botao-pedir';
import { disparar } from '@/lib/disparar';
import { useModo } from '@/lib/modo';
import { AvisosResultados } from './avisos-resultados';
import { CartaoConversas } from './campanhas-lite';
import { CartaoCampanhas } from './cartao-campanhas';
import { CartaoCiclo } from './cartao-ciclo';
import { CartaoFontes, FaixaDoTopoDosResultados } from './cartao-fontes';
import { CartaoOrigem } from './cartao-origem';
import { type ConsultaDePedidos, CartaoPedidos } from './cartao-pedidos';
import { CartaoRoas } from './cartao-roas';
import { ContextoResultados } from './contexto-resultados';
import { DicaDosDesenhos } from './desenhos';
import type { GraficosDaTela } from './graficos';
import type { TelaDeResultados } from './textos';

// O corpo da tela de Resultados com os dados já lidos (o que os protótipos desenham abaixo do cabeçalho: o P1 no Pro
// e o de Resultados em gráficos, de 07/10/2026, no modo simples).
// Separado da busca para ser desenhado igual no teste e no navegador. O "Explicar" (protótipo P4) entra
// pelo número principal: o botão no cabeçalho dele e o bloco logo abaixo.

/** O que o "Explicar" dos resultados precisa: o pedido (os mesmos números da tela) e se a LIA responde. */
export type ExplicarResultados = {
  pedido: PedidoDeExplicacao;
  lia: boolean;
  /** Muitos pedidos sem origem provada: a explicação oferece o caminho para Links e cupons. */
  semOrigemAlta: boolean;
};

type Props = {
  tela: TelaDeResultados;
  /** Os desenhos do modo simples. */
  graficos: GraficosDaTela;
  modelo: ClosedLoopResponse['model'];
  /** Consulta da lista de pedidos; nula sem o Regem. */
  consulta: ConsultaDePedidos | null;
  /** Nome da loja para a gaveta do pedido (nulo quando há várias). */
  loja: string | null;
  podeVerContas: boolean;
  reserva: RefObject<HTMLElement | null>;
  /** Nulo quando não há o que explicar (hoje, sem o Regem, sem pedido com origem) ou antes de saber se a LIA responde. */
  explicar?: ExplicarResultados | null;
  /** O pedido de mudança nas campanhas (protótipo P9); nulo para quem não acompanha as campanhas. */
  pedir?: PedirNaLista | null;
};

/** "Ver por campanha": leva ao cartão das campanhas e, no Lite, abre os detalhes dele (como no protótipo). */
function verPorCampanha() {
  const titulo = document.getElementById('t-camp');
  const cartao = titulo?.closest('article');
  if (!titulo || !cartao) return;
  cartao.querySelector<HTMLButtonElement>('.detalhes-bt[aria-expanded="false"]')?.click();
  const parado = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  cartao.scrollIntoView({ block: 'start', behavior: parado ? 'auto' : 'smooth' });
  titulo.setAttribute('tabindex', '-1');
  titulo.focus({ preventScroll: true });
}

export function ResultadosConteudo({ tela, graficos, modelo, consulta, loja, podeVerContas, reserva, explicar = null, pedir = null }: Props) {
  const pro = useModo().modo === 'pro';
  const explicacao = useExplicacao(explicar?.pedido ?? null);
  const botao = useRef<HTMLButtonElement>(null);

  function fechar() {
    explicacao.fechar();
    botao.current?.focus();
  }

  return (
    <>
      <ContextoResultados contexto={tela.contexto} pro={pro} />
      <FaixaDoTopoDosResultados faixa={graficos.faixa} fontes={tela.fontes} podeVerContas={podeVerContas} />
      {/* No modo simples, os outros avisos são o estado ou uma nota do cartão a que pertencem. */}
      {pro && <AvisosResultados avisos={tela.avisos} />}
      <div className={pro ? 'res-grid res-grid--pro' : 'res-grid'}>
        <CartaoRoas
          roas={tela.roas}
          lite={graficos.retorno}
          explicar={
            explicar && (
              <BotaoExplicar ref={botao} lia={explicar.lia} aberto={explicacao.aberta} controla="exp-resultados" aoClicar={() => (explicacao.aberta ? fechar() : disparar(explicacao.pedir()))} />
            )
          }
        />
        {explicar && explicacao.estado.tipo !== 'fechada' && (
          <BlocoExplicacao
            id="resultados"
            estado={explicacao.estado}
            lia={explicar.lia}
            sobre="tela"
            podeVerContas={podeVerContas}
            aoFechar={fechar}
            aoPedirDeNovo={() => disparar(explicacao.pedir())}
            acoes={
              <>
                <button className="btn btn--sm" type="button" onClick={verPorCampanha}>
                  Ver por campanha
                </button>
                {explicar.semOrigemAlta && (
                  <Link className="btn btn--sm" href="/links">
                    Abrir Links e cupons
                  </Link>
                )}
              </>
            }
          />
        )}
        {pro && <CartaoFontes fontes={tela.fontes} />}
        <CartaoCiclo ciclo={tela.ciclo} lite={graficos.real} rotuloPeriodo={tela.base.rotuloPeriodo} datas={tela.contexto.datas} />
        <CartaoCampanhas campanhas={tela.campanhas} lite={graficos.campanhas} rotuloPeriodo={tela.base.rotuloPeriodo} pedir={pedir} />
        {!pro && <CartaoConversas linhas={graficos.conversas} />}
        <CartaoOrigem origem={tela.origem} lite={graficos.origem} podeVerContas={podeVerContas} />
        <CartaoPedidos consulta={consulta} fuso={tela.base.fuso} loja={loja} modelo={modelo} reserva={reserva} />
      </div>
      <DicaDosDesenhos />
    </>
  );
}
