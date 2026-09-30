'use client';

import type { ClosedLoopResponse } from '@liame/contracts';
import type { RefObject } from 'react';
import { useModo } from '@/lib/modo';
import { AvisosResultados } from './avisos-resultados';
import { CartaoCampanhas } from './cartao-campanhas';
import { CartaoCiclo } from './cartao-ciclo';
import { CartaoFontes } from './cartao-fontes';
import { CartaoOrigem } from './cartao-origem';
import { type ConsultaDePedidos, CartaoPedidos } from './cartao-pedidos';
import { CartaoRoas } from './cartao-roas';
import { ContextoResultados } from './contexto-resultados';
import type { TelaDeResultados } from './textos';

// O corpo da tela de Resultados com os dados já lidos (o que o protótipo P1 desenha abaixo do cabeçalho).
// Separado da busca para ser desenhado igual no teste e no navegador.

type Props = {
  tela: TelaDeResultados;
  modelo: ClosedLoopResponse['model'];
  /** Consulta da lista de pedidos; nula sem o Regem. */
  consulta: ConsultaDePedidos | null;
  /** Nome da loja para a gaveta do pedido (nulo quando há várias). */
  loja: string | null;
  podeVerContas: boolean;
  reserva: RefObject<HTMLElement | null>;
};

export function ResultadosConteudo({ tela, modelo, consulta, loja, podeVerContas, reserva }: Props) {
  const pro = useModo().modo === 'pro';
  return (
    <>
      <ContextoResultados contexto={tela.contexto} fontes={tela.fontes} pro={pro} />
      <AvisosResultados avisos={tela.avisos} podeVerContas={podeVerContas} />
      <div className={pro ? 'res-grid res-grid--pro' : 'res-grid'}>
        <CartaoRoas roas={tela.roas} />
        {pro && <CartaoFontes fontes={tela.fontes} />}
        <CartaoCiclo ciclo={tela.ciclo} rotuloPeriodo={tela.base.rotuloPeriodo} datas={tela.contexto.datas} />
        <CartaoCampanhas campanhas={tela.campanhas} rotuloPeriodo={tela.base.rotuloPeriodo} />
        <CartaoOrigem origem={tela.origem} podeVerContas={podeVerContas} />
        <CartaoPedidos consulta={consulta} fuso={tela.base.fuso} loja={loja} modelo={modelo} reserva={reserva} />
      </div>
    </>
  );
}
