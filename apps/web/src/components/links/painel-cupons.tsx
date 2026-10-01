'use client';

import type { CouponItem, CouponListResponse, CouponRequest, CouponStore } from '@liame/contracts';
import Link from 'next/link';
import type { RefObject } from 'react';
import { enderecoDoPedido } from '@/components/aprovacoes/textos';
import { Estado } from '@/components/ui/estado';
import { Faixa } from '@/components/ui/faixa';
import { Icone } from '@/components/ui/icone';
import { mensagemDe, type Problema } from '@/lib/api';
import { reaisDeMicros } from '@/lib/formato';
import { bloqueioDaCriacao, faixaAguardando, faixaDoPedidoEncerrado, fonteDosCupons, nomeDaLoja, pedidosEmAndamento, type PlataformaDaLoja, semUsoComGasto, situacaoDoPedido } from './cupons-textos';
import { TabelaCupons } from './tabela-cupons';

// Aba Cupons (protótipo P3 com a plataforma de pedidos): de onde vêm os cupons da loja, os avisos (criação no
// Regem desligada ou não liberada pela loja; pedido aguardando aprovação; pedido que terminou sem cupom; cupom
// exclusivo sem uso com a campanha gastando) e a tabela. Informar cupom de outra plataforma e ligar a campanha
// pedem `atribuicao.gerenciar`; pedir a criação no Regem (e cancelar o pedido), `cupons.criar`.

export type CargaCupons = { tipo: 'carregando' } | { tipo: 'ok'; dados: CouponListResponse } | { tipo: 'erro'; problema: Problema };

type Props = {
  carga: CargaCupons;
  loja: CouponStore | null;
  itens: CouponItem[];
  /** Pedidos de criação da loja: em andamento e os que terminaram sem cupom nos últimos dias. */
  pedidos: CouponRequest[];
  plataforma: PlataformaDaLoja;
  agora: Date;
  podeGerenciar: boolean;
  podeCriarCupom: boolean;
  podeVerContas: boolean;
  /** Vê a tela Aprovações (`campanhas.ver`): a faixa do pedido que espera leva até lá. */
  podeVerAprovacoes?: boolean;
  botaoInformar: RefObject<HTMLButtonElement | null>;
  botaoCriar: RefObject<HTMLButtonElement | null>;
  aoInformar: () => void;
  aoCriarNoRegem: () => void;
  aoCancelarPedido: (p: CouponRequest) => Promise<boolean>;
  aoLigar: (c: CouponItem) => void;
  aoDesligar: (c: CouponItem) => Promise<boolean>;
  aoTentar: () => void;
};

export function PainelCupons(p: Props) {
  const { carga, loja, itens, pedidos, plataforma, agora } = p;
  const dados = carga.tipo === 'ok' ? carga.dados : null;
  const externo = !!loja?.unit && plataforma.info.cupomExterno;
  const fonte = loja ? fonteDosCupons(loja, plataforma, agora) : null;
  // A criação pelo Liame: ligada para a empresa (flag) e liberada pela loja na autorização do Regem.
  const ligada = !!dados?.create_in_regem;
  const bloqueio = ligada && loja ? bloqueioDaCriacao(loja) : null;
  const podePedir = p.podeCriarCupom && ligada && !bloqueio;

  const cabecalho = (
    <div className="painel-cab">
      <p className="painel-desc">
        {fonte ? (
          <>
            <span className={`ponto${fonte.ponto === 'ok' ? '' : ` ponto--${fonte.ponto}`}`} aria-hidden="true" />
            {fonte.texto}
          </>
        ) : dados ? (
          <>
            <span className="ponto ponto--off" aria-hidden="true" />
            Os cupons vêm do Regem, que ainda não está conectado.
          </>
        ) : (
          'Os cupons da loja, prontos para ligar a uma campanha.'
        )}
      </p>
      {dados && loja && (
        <div className="painel-acoes">
          {externo && p.podeGerenciar && (
            <button ref={p.botaoInformar} className="btn btn--primary" type="button" aria-haspopup="dialog" onClick={p.aoInformar}>
              <Icone nome="ticket" />
              Informar cupom {plataforma.info.de}
            </button>
          )}
          {p.podeCriarCupom && (
            <button
              ref={p.botaoCriar}
              className={externo && p.podeGerenciar ? 'btn' : 'btn btn--primary'}
              type="button"
              aria-haspopup={podePedir ? 'dialog' : undefined}
              aria-disabled={!podePedir}
              onClick={p.aoCriarNoRegem}
            >
              <Icone nome="plus" />
              Criar cupom no Regem
            </button>
          )}
        </div>
      )}
    </div>
  );

  if (carga.tipo === 'carregando') {
    return (
      <>
        {cabecalho}
        <div className="card res-esqueleto" aria-hidden="true">
          <span className="esqueleto esqueleto--curto" />
          <span className="esqueleto" />
          <span className="esqueleto" />
        </div>
      </>
    );
  }
  if (carga.tipo === 'erro') {
    return (
      <>
        {cabecalho}
        <div className="card">
          <Estado
            icone="alert-circle"
            perigo
            titulo="Não foi possível ler os cupons"
            acao={
              <div className="vazio-acoes">
                <button className="btn btn--primary" type="button" onClick={p.aoTentar}>
                  <Icone nome="refresh" />
                  Tentar de novo
                </button>
              </div>
            }
          >
            {mensagemDe(carga.problema)} Os cupons continuam valendo no caixa; aqui eles voltam quando a leitura der certo.
          </Estado>
        </div>
      </>
    );
  }
  if (!loja) {
    return (
      <>
        {cabecalho}
        <div className="card">
          <Estado
            icone="plug"
            titulo="Conecte o Regem para ver os cupons da loja"
            acao={
              p.podeVerContas ? (
                <div className="vazio-acoes">
                  <Link className="btn btn--primary" href="/contas">
                    Conectar o Regem
                  </Link>
                </div>
              ) : undefined
            }
          >
            Os cupons vivem no Regem, onde são usados. Com a conexão, eles aparecem aqui prontos para ligar a uma campanha, e o Liame conta os usos.
          </Estado>
        </div>
      </>
    );
  }

  const emAndamento = pedidosEmAndamento(pedidos);
  const encerrados = pedidos.filter((x) => !emAndamento.includes(x));
  const aguardando = faixaAguardando(pedidos);
  const esperando = emAndamento.filter((x) => situacaoDoPedido(x) === 'aguardando');

  return (
    <>
      {cabecalho}
      {p.podeCriarCupom && !ligada && (
        <Faixa
          icone={<Icone nome="lock" />}
          titulo="A criação de cupons está desligada para a sua empresa"
          texto="Enquanto isso, crie o cupom direto no Regem: ele aparece aqui na próxima leitura, pronto para ligar a uma campanha."
        />
      )}
      {p.podeCriarCupom && bloqueio && (
        <Faixa
          icone={<Icone nome="lock" />}
          titulo={bloqueio.titulo}
          texto={bloqueio.texto}
          acao={
            p.podeVerContas ? (
              <Link className="btn btn--sm" href="/contas">
                Abrir Contas conectadas
              </Link>
            ) : undefined
          }
        />
      )}
      {aguardando && (
        <Faixa
          tipo="acao"
          icone={<Icone nome="clock" />}
          titulo={aguardando.titulo}
          texto={aguardando.texto}
          acao={
            p.podeVerAprovacoes ? (
              // Um pedido só: abre direto nele; vários: a fila.
              <Link className="btn btn--sm" href={esperando.length === 1 ? enderecoDoPedido(esperando[0]!.action_id) : '/aprovacoes'}>
                Abrir em Aprovações
              </Link>
            ) : undefined
          }
        />
      )}
      {encerrados.map((x) => {
        const f = faixaDoPedidoEncerrado(x);
        return <Faixa key={x.action_id} tipo="atencao" icone={<Icone nome="alert" />} titulo={f.titulo} texto={f.texto} />;
      })}
      {itens.filter(semUsoComGasto).map((c) => (
        <Faixa
          key={c.id}
          tipo="atencao"
          icone={<Icone nome="alert" />}
          titulo={`O cupom ${c.code} não teve nenhum uso, e a campanha dele gastou ${reaisDeMicros(c.link!.campaign_spend_7d_micros!)} em 7 dias`}
          texto={`Ele está ligado à campanha ${c.link!.campaign.name} como exclusivo. Confira se o código aparece no anúncio e na conversa do WhatsApp.`}
        />
      ))}
      {itens.length || emAndamento.length ? (
        <TabelaCupons
          itens={itens}
          pedidos={emAndamento}
          loja={loja}
          agora={agora}
          podeGerenciar={p.podeGerenciar}
          podeCriarCupom={p.podeCriarCupom}
          aoLigar={p.aoLigar}
          aoDesligar={p.aoDesligar}
          aoCancelarPedido={p.aoCancelarPedido}
        />
      ) : (
        <div className="card">
          <Estado
            icone="ticket"
            titulo={`Nenhum cupom na ${nomeDaLoja(loja)}`}
            acao={
              (externo && p.podeGerenciar) || podePedir ? (
                <div className="vazio-acoes">
                  {externo && p.podeGerenciar && (
                    <button className="btn btn--primary" type="button" aria-haspopup="dialog" onClick={p.aoInformar}>
                      Informar cupom {plataforma.info.de}
                    </button>
                  )}
                  {podePedir && (
                    <button className={externo && p.podeGerenciar ? 'btn' : 'btn btn--primary'} type="button" aria-haspopup="dialog" onClick={p.aoCriarNoRegem}>
                      Criar cupom no Regem
                    </button>
                  )}
                </div>
              ) : undefined
            }
          >
            {externo
              ? `Crie um cupom no ${plataforma.info.nome} para cada campanha e informe o código aqui. Cupom exclusivo de campanha é o jeito de medir as vendas que chegam sem o clique do anúncio.`
              : podePedir
                ? 'Crie um cupom no Regem ou por aqui, com aprovação. Cupom exclusivo de campanha é o jeito de medir vendas no balcão e nas plataformas de pedidos, que não têm clique.'
                : 'Crie um cupom no Regem: ele aparece aqui na próxima leitura. Cupom exclusivo de campanha é o jeito de medir vendas no balcão e nas plataformas de pedidos, que não têm clique.'}
          </Estado>
        </div>
      )}
    </>
  );
}
