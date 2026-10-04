'use client';

import type { AutonomyResponse, TeamMember, TeamResponse, TeamShadowResponse } from '@liame/contracts';
import type { ReactNode, Ref } from 'react';
import { Faixa } from '@/components/ui/faixa';
import { Icone } from '@/components/ui/icone';
import type { Modo } from '@/lib/modo';
import type { Historico } from './bloco-historico';
import type { AcoesDaProntidao } from './bloco-prontidao';
import { type AcoesDoMembro, DetalheDaProximaFase, DetalheDoMembro } from './detalhe';
import { Avatar, ConfirmaNaLinha, SeloDaSituacao } from './pecas';
import { atividadeDo, avisosDa, ehMembro, FICHAS, gruposDa, mesDe, PROXIMAS_FASES, seloDaIa } from './textos';

// "Sua equipe" (mockups/prototipo-equipe.html, P7 aprovado em 03/10/2026): a lista dos funcionários e o detalhe do
// escolhido. Desenhado só com o que chega por parâmetro: o mesmo componente serve ao navegador e aos testes.

export interface AcoesDoTopo {
  /** `parar` ou `retomar` enquanto a chamada está em andamento. */
  ocupado: string | null;
  /** A parada espera a confirmação. */
  parando: boolean;
  aoPedirParada: (pedir: boolean) => void;
  aoParar: () => void;
  aoRetomar: () => void;
}

interface Props {
  t: TeamResponse;
  autonomia: AutonomyResponse | null;
  sombra: TeamShadowResponse | null;
  /** O que cada funcionário fez, pelo que já foi pedido à API. */
  historicos: Record<string, Historico>;
  /** O funcionário escolhido: um da equipe ou um das fases seguintes. */
  escolhido: string;
  /** Numa coluna só (telas estreitas): mostra o detalhe no lugar da lista. */
  mostraDetalhe: boolean;
  modo: Modo;
  agora: Date;
  nomeDaMarca: string;
  seletor?: ReactNode;
  tituloRef?: Ref<HTMLHeadingElement>;
  topo: AcoesDoTopo;
  membro: AcoesDoMembro;
  prontidao: AcoesDaProntidao;
  aoEscolher: (chave: string) => void;
  aoVoltar: () => void;
}

function Grupo({ rotulo, quantos, children }: { rotulo: string; quantos: number; children: ReactNode }) {
  if (!quantos) return null;
  return (
    <div className="eqp-grupo">
      <p className="eqp-grupo-rot rotulo-marca">
        <span>{rotulo}</span>
        <span>{quantos}</span>
      </p>
      <ul className="eqp-itens">{children}</ul>
    </div>
  );
}

export function EquipeConteudo({ t, autonomia, sombra, historicos, escolhido, mostraDetalhe, modo, agora, nomeDaMarca, seletor, tituloRef, topo, membro, prontidao, aoEscolher, aoVoltar }: Props) {
  const mes = mesDe(t.month.from);
  const grupos = gruposDa(t);
  const avisos = avisosDa(t, agora);
  const doEscolhido = t.members.find((m) => m.key === escolhido);

  const item = (m: TeamMember) => {
    if (!ehMembro(m.key)) return null;
    const f = FICHAS[m.key];
    return (
      <li key={m.key}>
        <button className="eqp-item" type="button" id={`eqp-item-${m.key}`} aria-current={m.key === escolhido ? 'true' : undefined} onClick={() => aoEscolher(m.key)}>
          <Avatar icone={f.icone} apagado={m.status === 'desligado' || m.status === 'desligado_pela_liame'} />
          <span className="eqp-txt">
            <b>{f.nome}</b>
            <span>{atividadeDo(m, mes, agora)}</span>
          </span>
          <SeloDaSituacao m={m} />
        </button>
      </li>
    );
  };

  let parada: ReactNode = null;
  if (t.ai.enabled && t.can_stop) {
    if (t.stop?.by_company) {
      parada = (
        <button className="btn btn--sm btn--primary" type="button" id="eqp-bt-retomar" onClick={topo.aoRetomar} disabled={topo.ocupado !== null} aria-busy={topo.ocupado === 'retomar'}>
          <Icone nome="play" pequeno />
          {topo.ocupado === 'retomar' ? 'Retomando…' : 'Retomar a equipe'}
        </button>
      );
    } else if (!t.stop) {
      parada = topo.parando ? (
        <ConfirmaNaLinha
          texto="Para todos os funcionários de IA agora, em todas as marcas da empresa. As telas seguem funcionando."
          rotulo="Parar a equipe"
          rotuloOcupado="Parando…"
          ocupado={topo.ocupado === 'parar'}
          aoConfirmar={topo.aoParar}
          aoCancelar={() => topo.aoPedirParada(false)}
        />
      ) : (
        <button className="btn btn--sm btn--perigo" type="button" id="eqp-bt-parar" onClick={() => topo.aoPedirParada(true)} disabled={topo.ocupado !== null}>
          <Icone nome="pause" pequeno />
          Parar a equipe
        </button>
      );
    }
  }

  return (
    <>
      <div className="view-cab anima" style={{ ['--i' as string]: 0 }}>
        <div>
          <h1 id="h-equipe" ref={tituloRef} tabIndex={-1}>
            Sua equipe
          </h1>
          <p>
            Cada funcionário é um assistente de IA, com cargo, limites e histórico. Nesta fase, ninguém mexe em campanha: quem cuida de anúncio trabalha em sombra, aprendendo com o que você
            faz.
          </p>
        </div>
        <div className="cab-acoes eqp-topo">
          {seletor}
          <span className="lite-chip">{seloDaIa(t)}</span>
          {modo === 'lite' && <span className="lite-chip">Modelos de IA: automático</span>}
          {parada}
        </div>
      </div>
      <div className="eqp">
        {avisos.map((a) => (
          <Faixa key={a.chave} tipo={a.tipo} icone={<Icone nome={a.icone} />} titulo={a.titulo} texto={a.texto} />
        ))}
        <div className={`eqp-grade${mostraDetalhe ? ' mostra-detalhe' : ''}`}>
          <nav className="card eqp-lista" aria-label="Funcionários">
            <Grupo rotulo="Trabalhando para você" quantos={grupos.ativos.length}>
              {grupos.ativos.map(item)}
            </Grupo>
            <Grupo rotulo="Em sombra" quantos={grupos.sombra.length}>
              {grupos.sombra.map(item)}
            </Grupo>
            <Grupo rotulo="Desligados" quantos={grupos.desligados.length}>
              {grupos.desligados.map(item)}
            </Grupo>
            <Grupo rotulo="Chegam nas próximas fases" quantos={PROXIMAS_FASES.length}>
              {PROXIMAS_FASES.map((f) => (
                <li key={f.chave}>
                  <button className="eqp-item" type="button" id={`eqp-item-${f.chave}`} aria-current={f.chave === escolhido ? 'true' : undefined} onClick={() => aoEscolher(f.chave)}>
                    <Avatar icone={f.icone} apagado />
                    <span className="eqp-txt">
                      <b>{f.nome}</b>
                      <span>{f.cargo}</span>
                    </span>
                    <span className="st st--off">Na fase {f.fase}</span>
                  </button>
                </li>
              ))}
            </Grupo>
          </nav>
          <article className="card eqp-det" id="eqp-det" aria-labelledby="eqp-det-t">
            {doEscolhido && ehMembro(doEscolhido.key) ? (
              <DetalheDoMembro
                m={doEscolhido}
                chave={doEscolhido.key}
                t={t}
                autonomia={autonomia}
                sombra={sombra}
                historico={historicos[doEscolhido.key] ?? { tipo: 'carregando' }}
                modo={modo}
                agora={agora}
                acoes={membro}
                prontidao={prontidao}
                aoVoltar={aoVoltar}
              />
            ) : (
              <DetalheDaProximaFase chave={escolhido} nomeDaMarca={nomeDaMarca} aoVoltar={aoVoltar} />
            )}
          </article>
        </div>
      </div>
    </>
  );
}
