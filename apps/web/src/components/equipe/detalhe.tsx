'use client';

import type { AutonomyResponse, TeamMember, TeamResponse, TeamShadowResponse } from '@liame/contracts';
import Link from 'next/link';
import { useState } from 'react';
import { useConversa } from '@/components/conversa/contexto';
import { Faixa } from '@/components/ui/faixa';
import { Icone } from '@/components/ui/icone';
import type { Modo } from '@/lib/modo';
import { chaveDaLinha, gestorNaLista, LIMITES_DO_GESTOR, RESUMO_DO_GESTOR, rodadaDoGestor, temModoAprovacao } from './aprovacao-textos';
import { BlocoDaLinha, BlocoModos, BlocoRodadaDoGestor } from './bloco-aprovacao';
import { BlocoHistorico, type Historico } from './bloco-historico';
import { type AcoesDaProntidao, BlocoProntidao } from './bloco-prontidao';
import { BlocoRodada, BlocoSombra } from './bloco-sombra';
import { Avatar, BlocoNumeros, ConfirmaNaLinha, SeloDaSituacao } from './pecas';
import { acertoDo, agoraDoCriativo, type ChaveDoMembro, criativoNaoLigado, custoDo, FICHAS, mesDe, modoDo, notaDaCotacao, perguntaSobre, podeConversarSobre, PROXIMAS_FASES, quandoNaFrase } from './textos';

// O detalhe de um funcionário (protótipo P7): quem é, a situação, o que pode e não pode, o acerto e o custo do mês e
// o que fez. O Gestor de tráfego mostra a sombra e a prontidão no lugar do acerto. O Criativo (protótipo P12) só
// trabalha a pedido: a ficha dele diz o que está escrevendo, o que espera a pessoa e por que não escreve, e leva a Criativos.

export interface AcoesDoMembro {
  /** `desligar:<chave>` ou `ligar:<chave>` enquanto a chamada está em andamento. */
  ocupado: string | null;
  /** O funcionário cujo desligamento espera a confirmação. */
  desligando: string | null;
  aoPedirDesligar: (chave: string | null) => void;
  aoDesligar: (chave: ChaveDoMembro, motivo: string) => void;
  aoLigar: (chave: ChaveDoMembro) => void;
  aoIrParaPro: () => void;
  aoRecarregarHistorico: (chave: ChaveDoMembro) => void;
}

const minuscula = (s: string) => s.charAt(0).toLocaleLowerCase('pt-BR') + s.slice(1);

function Voltar({ aoVoltar }: { aoVoltar: () => void }) {
  return (
    <button className="btn btn--ghost btn--sm eqp-voltar" type="button" onClick={aoVoltar}>
      <Icone nome="chevron-left" pequeno />
      Voltar para a equipe
    </button>
  );
}

/** O funcionário de uma fase seguinte: ainda não trabalha. */
export function DetalheDaProximaFase({ chave, nomeDaMarca, aoVoltar }: { chave: string; nomeDaMarca: string; aoVoltar: () => void }) {
  const f = PROXIMAS_FASES.find((x) => x.chave === chave);
  if (!f) return null;
  return (
    <>
      <Voltar aoVoltar={aoVoltar} />
      <div className="eqp-cab">
        <Avatar icone={f.icone} grande apagado />
        <div className="eqp-cab-txt">
          <h2 id="eqp-det-t" tabIndex={-1}>
            {f.nome}
          </h2>
          <p>{f.cargo}</p>
          <div className="eqp-tags">
            <span className="st st--off">Na fase {f.fase}</span>
          </div>
        </div>
      </div>
      <p className="eqp-resumo">{f.resumo}</p>
      <div className="eqp-bloco">
        <p>
          Ele entra na fase <b>{f.fase}</b> do roadmap. Até lá, não trabalha para a {nomeDaMarca}.
        </p>
      </div>
    </>
  );
}

function AcoesDoFuncionario({ m, chave, t, acoes }: { m: TeamMember; chave: ChaveDoMembro; t: TeamResponse; acoes: AcoesDoMembro }) {
  const f = FICHAS[chave];
  const [motivo, setMotivo] = useState('');
  const conversa = useConversa();
  // "Conversar sobre ele" (P7): abre a conversa com a LIA já com a pergunta sobre o trabalho deste funcionário.
  // No Criativo (P12), o atalho é para a tela onde o trabalho dele está.
  const conversar = chave === 'criativo' ? (
    <Link className="btn" href="/criativos" id="eqp-bt-criativos">
      <Icone nome="image" pequeno />
      Abrir Criativos
    </Link>
  ) : podeConversarSobre(chave, t, conversa.disponivel) ? (
    <button className="btn" type="button" id="eqp-bt-conversar" onClick={() => conversa.abrir({ pergunta: perguntaSobre(chave) })}>
      <Icone nome="message" pequeno />
      Conversar sobre ele
    </button>
  ) : null;
  const soConversar = conversar ? <div className="eqp-acoes">{conversar}</div> : null;
  // Com a IA desligada para a empresa, não há o que ligar ou desligar aqui (como no protótipo).
  if (!t.ai.enabled) return null;
  if (!m.can_pause) {
    return (
      <div className="eqp-acoes">
        {conversar}
        <span className="eixo-nota">O Compliance não desliga: sem ele, nenhum texto de IA aparece.</span>
      </div>
    );
  }
  if (!t.can_manage) return soConversar;
  if (m.status === 'desligado') {
    return (
      <div className="eqp-acoes">
        {conversar}
        <button className="btn btn--primary" type="button" id="eqp-bt-ligar" onClick={() => acoes.aoLigar(chave)} disabled={acoes.ocupado !== null} aria-busy={acoes.ocupado === `ligar:${chave}`}>
          <Icone nome="power" pequeno />
          {acoes.ocupado === `ligar:${chave}` ? 'Ligando…' : 'Ligar de novo'}
        </button>
      </div>
    );
  }
  // Desligado pela Liame (fora do plano, ou a sombra ainda não ligada): desligar aqui não mudaria nada.
  // O Criativo que a Liame ainda não ligou não tem peça para abrir.
  if (m.status === 'desligado_pela_liame') return chave === 'criativo' ? null : soConversar;
  if (acoes.desligando === chave) {
    const curto = motivo.trim().length > 0 && motivo.trim().length < 3;
    return (
      <div className="eqp-acoes">
        <ConfirmaNaLinha
          texto={`Desligar ${f.nome} nesta marca? ${chave === 'lia' ? 'Ela' : 'Ele'} para de trabalhar e de custar; o histórico fica guardado.`}
          rotulo="Desligar"
          rotuloOcupado="Desligando…"
          ocupado={acoes.ocupado === `desligar:${chave}`}
          impedido={curto}
          aoConfirmar={() => acoes.aoDesligar(chave, motivo.trim())}
          aoCancelar={() => acoes.aoPedirDesligar(null)}
        >
          <label className="eqp-motivo">
            <span>Motivo (opcional{curto ? '; com pelo menos 3 letras' : ''})</span>
            <input className="input" type="text" maxLength={300} value={motivo} onChange={(e) => setMotivo(e.target.value)} />
          </label>
        </ConfirmaNaLinha>
      </div>
    );
  }
  return (
    <div className="eqp-acoes">
      {conversar}
      <button className="btn btn--perigo" type="button" id="eqp-bt-desligar" onClick={() => acoes.aoPedirDesligar(chave)} disabled={acoes.ocupado !== null}>
        <Icone nome="power" pequeno />
        Desligar este funcionário
      </button>
    </div>
  );
}

export function DetalheDoMembro({
  m,
  chave,
  t,
  autonomia,
  sombra,
  historico,
  modo,
  agora,
  acoes,
  prontidao,
  aoVoltar,
}: {
  m: TeamMember;
  chave: ChaveDoMembro;
  t: TeamResponse;
  autonomia: AutonomyResponse | null;
  sombra: TeamShadowResponse | null;
  historico: Historico;
  modo: Modo;
  agora: Date;
  acoes: AcoesDoMembro;
  prontidao: AcoesDaProntidao;
  aoVoltar: () => void;
}) {
  const f = FICHAS[chave];
  const mes = mesDe(t.month.from);
  const selo = modoDo(m, autonomia?.items ?? null);
  const custo = custoDo(m, t);
  const cotacao = notaDaCotacao(t.usd_brl);
  const acerto = acertoDo(m, mes);
  const pronome = chave === 'lia' ? 'ela' : 'ele';
  const doCriativo = chave === 'criativo' ? agoraDoCriativo(m, t, agora) : null;
  // Não ligado pela Liame (P12): não há peça nem custo para mostrar.
  const naoLigado = criativoNaoLigado(m, t);
  // Com o modo Aprovação (P11), a ficha do Gestor de tráfego mostra o modo de cada conta e ação; a linha escolhida
  // é a que a pessoa tocou ou, sem escolha, a primeira (a proposta pendente vem na frente).
  const comAprovacao = chave === 'trafego' && temModoAprovacao(autonomia);
  const linha = comAprovacao && autonomia ? (autonomia.items.find((a) => chaveDaLinha(a) === prontidao.linha) ?? autonomia.items[0] ?? null) : null;
  return (
    <>
      <Voltar aoVoltar={aoVoltar} />
      <div className="eqp-cab">
        <Avatar icone={f.icone} grande apagado={m.status === 'desligado' || m.status === 'desligado_pela_liame'} />
        <div className="eqp-cab-txt">
          <h2 id="eqp-det-t" tabIndex={-1}>
            {f.nome}
          </h2>
          <p>{f.cargo}</p>
          <div className="eqp-tags">
            <SeloDaSituacao m={m} selo={comAprovacao && autonomia ? gestorNaLista(m, rodadaDoGestor(sombra, autonomia.items, t, agora))?.selo : undefined} />
            <span className={selo.classe}>Modo: {selo.rotulo}</span>
          </div>
        </div>
      </div>
      <p className="eqp-resumo">{comAprovacao ? RESUMO_DO_GESTOR : f.resumo}</p>
      <AcoesDoFuncionario key={chave} m={m} chave={chave} t={t} acoes={acoes} />
      {m.status === 'desligado' && (
        <Faixa
          icone={<Icone nome="power" />}
          titulo={m.paused ? `Desligado ${m.paused.by ? `por ${m.paused.by.name} ` : ''}${quandoNaFrase(m.paused.at, agora)}` : 'Desligado nesta marca'}
          texto={
            chave === 'criativo'
              ? `${m.paused?.reason ? `Motivo: "${m.paused.reason}". ` : ''}Enquanto estiver desligado, ninguém pede peça nova nem outra versão, e ele não custa nada. As peças que já existem seguem em Criativos: dá para editar, aprovar ou recusar.`
              : `${m.paused?.reason ? `Motivo: "${m.paused.reason}". ` : ''}Enquanto estiver desligado, ${pronome} não trabalha e não custa nada.`
          }
        />
      )}
      {m.status === 'desligado_pela_liame' && t.ai.enabled && (
        <Faixa
          icone={<Icone nome="info" />}
          titulo={chave === 'trafego' ? 'A sombra ainda não está ligada para esta empresa' : chave === 'criativo' ? 'O Criativo ainda não está ligado para esta empresa' : 'Desligado pela Liame nesta empresa'}
          texto={
            chave === 'trafego'
              ? 'Enquanto isso, ele não registra recomendações. Quem liga é a Liame, a pedido do dono.'
              : chave === 'criativo'
                ? 'Quem liga é a Liame, a pedido do dono. Enquanto isso, ninguém pede peça e ele não custa nada.'
                : `${pronome === 'ela' ? 'Ela' : 'Ele'} não trabalha para esta empresa agora. Quem liga é a Liame, a pedido do dono.`
          }
        />
      )}
      {doCriativo?.faixa && (
        <Faixa
          tipo={doCriativo.faixa.tipo}
          icone={<Icone nome={doCriativo.faixa.icone} />}
          titulo={doCriativo.faixa.titulo}
          texto={doCriativo.faixa.texto}
          acao={
            doCriativo.faixa.marca ? (
              <Link className="btn btn--sm" href="/marca">
                Abrir Minha marca
              </Link>
            ) : undefined
          }
        />
      )}
      {doCriativo?.bloco && (
        <div className="eqp-bloco" id="eqp-criativo-agora">
          <div className="eqp-bloco-cab">
            <h3>{doCriativo.bloco.titulo}</h3>
          </div>
          <p className="lite-frase">{doCriativo.bloco.frase.map((p, i) => (p.forte ? <b key={i}>{p.texto}</b> : <span key={i}>{p.texto}</span>))}</p>
        </div>
      )}
      {autonomia && linha ? (
        <>
          <BlocoRodadaDoGestor sombra={sombra} autonomia={autonomia} equipe={t} modo={modo} agora={agora} />
          <BlocoModos autonomia={autonomia} modo={modo} alvo={linha} aoEscolher={prontidao.aoEscolherLinha} />
          <BlocoDaLinha autonomia={autonomia} alvo={linha} modo={modo} agora={agora} acoes={prontidao} />
          <BlocoSombra m={m} mes={mes} sombra={sombra} modo={modo} agora={agora} comAprovacao />
        </>
      ) : chave === 'trafego' ? (
        <>
          {modo === 'pro' && sombra && <BlocoRodada sombra={sombra} agora={agora} />}
          <BlocoSombra m={m} mes={mes} sombra={sombra} modo={modo} agora={agora} />
          <BlocoProntidao autonomia={autonomia} modo={modo} agora={agora} acoes={prontidao} />
        </>
      ) : (
        acerto.length > 0 && !naoLigado && <BlocoNumeros titulo={chave === 'criativo' ? `Peças em ${mes}` : 'Acerto'} numeros={acerto} />
      )}
      {!naoLigado && (
        <BlocoNumeros titulo={`Custo em ${mes}`} numeros={[custo]}>
          <p className="explica-nota">
            O custo de cada {chave === 'criativo' ? 'pedido' : 'resposta'} é medido pelo Liame e entra no teto da empresa.{cotacao ? ` ${cotacao}` : ''}
          </p>
        </BlocoNumeros>
      )}
      <div className="eqp-bloco">
        <div className="eqp-bloco-cab">
          <h3>O que pode e o que não pode</h3>
        </div>
        <ul className="eqp-lite">
          <li>
            <b>Faz:</b> {comAprovacao ? LIMITES_DO_GESTOR.faz : `${f.faz.map(minuscula).join('; ')}.`}
          </li>
          {comAprovacao && (
            <li>
              <b>No Google:</b> {LIMITES_DO_GESTOR.noGoogle}
            </li>
          )}
          {comAprovacao ? (
            <li>
              <b>Nunca:</b> {LIMITES_DO_GESTOR.nunca}
            </li>
          ) : chave === 'trafego' ? (
            <li>
              <b>Nunca, nesta fase:</b> pausar, mudar verba ou criar campanha. Mexer em anúncio entra na fase A4, com aprovação.
            </li>
          ) : (
            <li>
              <b>Nunca:</b> {f.nunca.map(minuscula).join('; ')}.
            </li>
          )}
        </ul>
      </div>
      <BlocoHistorico historico={historico} modo={modo} agora={agora} aoIrParaPro={acoes.aoIrParaPro} aoTentarDeNovo={() => acoes.aoRecarregarHistorico(chave)} />
    </>
  );
}
