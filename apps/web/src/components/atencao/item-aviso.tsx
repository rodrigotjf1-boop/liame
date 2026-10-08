'use client';

import type { AttentionItem } from '@liame/contracts';
import Link from 'next/link';
import { useId, useRef } from 'react';
import { plataforma } from '@/components/contas/textos';
import { BlocoExplicacao } from '@/components/explicar/bloco-explicacao';
import { BotaoExplicar } from '@/components/explicar/botao-explicar';
import type { PedidoDeExplicacao } from '@/components/explicar/pedir';
import { useExplicacao } from '@/components/explicar/use-explicacao';
import { Icone } from '@/components/ui/icone';
import { disparar } from '@/lib/disparar';
import { acaoDoAviso, destinoDoAviso, destinoPedeVendas, gravidadeDe, oQueFazer, type RecomendacaoDoAviso, rotuloDaGravidade } from './textos';

// Um aviso (protótipo aprovado): gravidade, plataforma, o que aconteceu, o motivo e o que fazer. Os do ciclo
// fechado (F9) levam à tela onde se resolve, para quem vê as vendas. Os de campanha, de medição e os fora do
// normal têm "Explicar" (protótipo P4): a explicação abre dentro do próprio aviso. A sugestão do Gestor de tráfego
// vira o cartão da recomendação (protótipo P9): "Pedir esta mudança" abre a gaveta do pedido já com a mudança, e
// "Agora não" tira o cartão e registra que a pessoa não quis.

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
  /** A recomendação por trás da sugestão, já em palavras; nula nos outros avisos. */
  recomendacao?: RecomendacaoDoAviso | null;
  /** A gaveta do pedido está aberta por este cartão (o botão diz que controla um diálogo aberto). */
  pedindo?: boolean;
  /** "Agora não" em andamento: os dois botões esperam. */
  dispensando?: boolean;
  aoPedir?: (r: RecomendacaoDoAviso) => void;
  aoDispensar?: (r: RecomendacaoDoAviso) => void;
};

export function ItemAviso({ item, podeVerContas, podeConectar, podeVerVendas, aoReconectar, explicar = null, aoAtualizar, recomendacao = null, pedindo = false, dispensando = false, aoPedir, aoDispensar }: Props) {
  const rec = recomendacao;
  // A recomendação leva o azul de informação, como no protótipo; a gravidade do servidor segue valendo no filtro e no menu.
  const g = rec ? 'info' : gravidadeDe(item.severity);
  const plat = item.provider ? plataforma(item.provider) : null;
  const acao = acaoDoAviso(item.kind);
  const destino = acao && (podeVerVendas || !destinoPedeVendas(acao)) ? destinoDoAviso(acao) : null;
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
    <li className={rec ? 'card aviso-midia aviso--rec' : 'card aviso-midia'} data-sev={g} data-recomendacao={rec?.id}>
      <div className="aviso-topo">
        <span className={`sev sev--${g}`}>{rec ? 'Recomendação' : rotuloDaGravidade(g)}</span>
        {plat && <span className={`plat plat--${plat.classe}`}>{plat.nome}</span>}
        {rec && (
          <span className="lite-chip">
            <Icone nome="megaphone" />
            Gestor de tráfego · {rec.modo}
          </span>
        )}
      </div>
      <h2 className="aviso-titulo">{rec ? rec.titulo : item.title}</h2>
      <p className="aviso-det">{item.detail}</p>
      {rec && (rec.estado.tipo === 'pedida' || rec.estado.tipo === 'feita') ? (
        <p className="aviso-estado">
          <Icone nome={rec.estado.tipo === 'feita' ? 'check' : 'clock'} pequeno />
          <span>{rec.estado.frase}</span>
        </p>
      ) : (
        <p className="aviso-fazer">
          <b>O que fazer:</b> {rec?.estado.tipo === 'aberta' ? rec.estado.fazer : oQueFazer(item.action)}
        </p>
      )}
      {rec?.estado.tipo === 'aberta' && rec.estado.nota && (
        <p className="aviso-estado aviso-estado--nota">
          <Icone nome="info" pequeno />
          <span>{rec.estado.nota}</span>
        </p>
      )}
      {(pedido || abreContas || destino || reconecta || (rec && rec.estado.tipo !== 'manual')) && (
        <div className="aviso-acoes">
          {rec?.estado.tipo === 'aberta' && (
            <>
              <button className="btn btn--primary btn--sm" type="button" data-pedir-recomendacao aria-haspopup="dialog" aria-expanded={pedindo} disabled={dispensando} onClick={() => aoPedir?.(rec)}>
                Pedir esta mudança
              </button>
              <button className="btn btn--sm" type="button" disabled={dispensando} onClick={() => aoDispensar?.(rec)}>
                Agora não
              </button>
            </>
          )}
          {rec && (rec.estado.tipo === 'pedida' || rec.estado.tipo === 'feita') && (
            <Link className="btn btn--sm" href={`/aprovacoes?pedido=${rec.estado.pedido}`}>
              Ver o pedido
            </Link>
          )}
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
