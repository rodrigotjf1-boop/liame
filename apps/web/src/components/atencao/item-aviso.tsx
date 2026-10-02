'use client';

import type { AttentionItem } from '@liame/contracts';
import Link from 'next/link';
import { useId, useRef } from 'react';
import { plataforma } from '@/components/contas/textos';
import { BlocoExplicacao } from '@/components/explicar/bloco-explicacao';
import { BotaoExplicar } from '@/components/explicar/botao-explicar';
import type { PedidoDeExplicacao } from '@/components/explicar/pedir';
import { useExplicacao } from '@/components/explicar/use-explicacao';
import { disparar } from '@/lib/disparar';
import { acaoDoAviso, destinoDoAviso, gravidadeDe, oQueFazer, rotuloDaGravidade } from './textos';

// Um aviso (protótipo aprovado): gravidade, plataforma, o que aconteceu, o motivo e o que fazer. Os do ciclo
// fechado (F9) levam à tela onde se resolve, para quem vê as vendas. Os de campanha, de medição e os fora do
// normal têm "Explicar" (protótipo P4): a explicação abre dentro do próprio aviso.

type Props = {
  item: AttentionItem;
  podeVerContas: boolean;
  podeConectar: boolean;
  podeVerVendas: boolean;
  aoReconectar: () => void;
  /** Este aviso tem "Explicar"? `lia`: se a LIA responde para a empresa (o botão dela ou o neutro). */
  explicar?: { lia: boolean } | null;
  /** Recarrega a lista: é o que a explicação oferece quando o aviso dela saiu da lista com a tela aberta. */
  aoAtualizar?: () => void;
};

export function ItemAviso({ item, podeVerContas, podeConectar, podeVerVendas, aoReconectar, explicar = null, aoAtualizar }: Props) {
  const g = gravidadeDe(item.severity);
  const plat = item.provider ? plataforma(item.provider) : null;
  const acao = acaoDoAviso(item.kind);
  const destino = acao && podeVerVendas ? destinoDoAviso(acao) : null;
  const abreContas = acao === 'abrir-contas' && podeVerContas;
  const reconecta = acao === 'reconectar' && podeConectar;

  // A tela pede a explicação com o que identifica o aviso (ele é calculado na hora e não tem id).
  const pedido: PedidoDeExplicacao | null =
    explicar && item.brand_id
      ? { de: 'aviso', brand_id: item.brand_id, kind: item.kind, connected_account_id: item.connected_account_id, campaign_id: item.campaign_id, provider: item.provider }
      : null;
  const explicacao = useExplicacao(pedido);
  const idDoBloco = `aviso-${useId().replaceAll(':', '')}`;
  const botao = useRef<HTMLButtonElement>(null);

  function fechar() {
    explicacao.fechar();
    botao.current?.focus();
  }

  // O aviso saiu da lista com a tela aberta: a explicação fecha e a tela busca os avisos de agora (o foco
  // vai para o título da tela, que é quem fica).
  const atualizar = aoAtualizar
    ? () => {
        explicacao.fechar();
        aoAtualizar();
      }
    : undefined;

  // Dentro da explicação, a ação é a mesma do aviso; sem ela, os números do aviso estão em Resultados.
  const acaoDaExplicacao = destino ?? { href: '/resultados', rotulo: 'Ver em Resultados' };

  return (
    <li className="card aviso-midia" data-sev={g}>
      <div className="aviso-topo">
        <span className={`sev sev--${g}`}>{rotuloDaGravidade(g)}</span>
        {plat && <span className={`plat plat--${plat.classe}`}>{plat.nome}</span>}
      </div>
      <h2 className="aviso-titulo">{item.title}</h2>
      <p className="aviso-det">{item.detail}</p>
      <p className="aviso-fazer">
        <b>O que fazer:</b> {oQueFazer(item.action)}
      </p>
      {(pedido || abreContas || destino || reconecta) && (
        <div className="aviso-acoes">
          {pedido && explicar && (
            <BotaoExplicar
              ref={botao}
              lia={explicar.lia}
              aberto={explicacao.aberta}
              controla={`exp-${idDoBloco}`}
              rotulo={`Explicar: ${item.title}`}
              aoClicar={() => (explicacao.aberta ? fechar() : disparar(explicacao.pedir()))}
            />
          )}
          {abreContas && (
            <Link className="btn btn--sm btn--primary" href="/contas">
              Abrir Contas conectadas
            </Link>
          )}
          {destino && (
            <Link className="btn btn--sm" href={destino.href}>
              {destino.rotulo}
            </Link>
          )}
          {reconecta && (
            <button className="btn btn--sm" type="button" onClick={aoReconectar} aria-label={`Conectar de novo: ${item.title}`}>
              Conectar de novo
            </button>
          )}
        </div>
      )}
      {pedido && explicar && explicacao.estado.tipo !== 'fechada' && (
        <BlocoExplicacao
          id={idDoBloco}
          estado={explicacao.estado}
          lia={explicar.lia}
          sobre="aviso"
          nivel={3}
          solto
          podeVerContas={podeVerContas}
          aoFechar={fechar}
          aoPedirDeNovo={() => disparar(explicacao.pedir())}
          aoAtualizar={atualizar}
          acoes={
            <Link className="btn btn--sm" href={acaoDaExplicacao.href}>
              {acaoDaExplicacao.rotulo}
            </Link>
          }
        />
      )}
    </li>
  );
}
