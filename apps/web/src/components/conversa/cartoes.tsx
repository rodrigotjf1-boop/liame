'use client';

import type { ConversationCard, ConversationMeeting, ExplanationNumber, ExplanationSegment, SupportContact } from '@liame/contracts';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { TextoDaExplicacao } from '@/components/explicar/bloco-explicacao';
import { seloDoRisco } from '@/components/explicar/textos';
import { copiar } from '@/components/links/copiar';
import { regraDoPedido, validadeDoPedido } from '@/components/links/cupons-textos';
import { ConfirmaNaLinha } from '@/components/ui/confirma-na-linha';
import { Icone, type NomeIcone } from '@/components/ui/icone';
import { disparar } from '@/lib/disparar';
import { quandoComHora, vencimento } from '@/lib/formato';
import { cartaoDaDemanda, prazoDoAtendimento, situacaoDaProposta } from './textos';

// Os cartões da conversa (protótipo P5): o registro do que a LIA fez em nome da pessoa (a demanda aberta e a proposta
// de cupom mandada para Aprovações), a reunião de decisão e o contato do atendimento. No máximo duas ações em cada um.

export interface AcoesDosCartoes {
  euId: string;
  agora: Date;
  pode: (permissao: string) => boolean;
  /** O que está sendo cancelado agora (`demanda:<id>` ou `proposta:<id>`), ou nulo. */
  ocupado: string | null;
  aoCancelarDemanda: (id: string) => void;
  aoCancelarProposta: (acaoId: string) => void;
}

function Moldura({ icone, titulo, selo, linhas, nota, children }: { icone: NomeIcone; titulo: string; selo: { classe: string; rotulo: string; ponto: boolean }; linhas: Array<[string, string]>; nota: string; children?: React.ReactNode }) {
  return (
    <div className="artefato">
      <div className="artefato-cab">
        <p className="artefato-tit">
          <Icone nome={icone} />
          <span>{titulo}</span>
        </p>
        <span className={selo.classe}>
          {selo.ponto && <span className="dot" aria-hidden="true" />}
          {selo.rotulo}
        </span>
      </div>
      <dl className="artefato-dados">
        {linhas.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <p className="artefato-nota">{nota}</p>
      {children}
    </div>
  );
}

/** Um botão que pede confirmação na linha antes de cancelar; desistir devolve o foco a ele. */
function Cancelar({ rotulo, pergunta, ocupado, aoConfirmar }: { rotulo: string; pergunta: string; ocupado: boolean; aoConfirmar: () => void }) {
  const [pedindo, setPedindo] = useState(false);
  const botao = useRef<HTMLButtonElement>(null);
  const desistiu = useRef(false);
  useEffect(() => {
    if (!pedindo && desistiu.current) {
      desistiu.current = false;
      botao.current?.focus();
    }
  }, [pedindo]);
  if (pedindo) {
    return (
      <ConfirmaNaLinha
        texto={pergunta}
        rotulo="Sim, cancelar"
        rotuloOcupado="Cancelando…"
        voltar="Manter"
        ocupado={ocupado}
        aoConfirmar={aoConfirmar}
        aoCancelar={() => {
          desistiu.current = true;
          setPedindo(false);
        }}
      />
    );
  }
  return (
    <button ref={botao} className="btn btn--sm" type="button" onClick={() => setPedindo(true)}>
      {rotulo}
    </button>
  );
}

export function CartaoDaConversa({ cartao, numeros, aoTocarNumero, acoes }: { cartao: ConversationCard; numeros: ExplanationNumber[]; aoTocarNumero: (n: number) => void; acoes: AcoesDosCartoes }) {
  if (cartao.kind === 'demanda' && cartao.demand) {
    const d = cartao.demand;
    const c = cartaoDaDemanda(d, acoes.euId, acoes.agora);
    return (
      <Moldura {...c}>
        {d.status === 'aberta' && acoes.pode('demanda.abrir') && (
          <div className="artefato-acoes">
            <Cancelar rotulo="Cancelar a demanda" pergunta="Cancelar esta demanda?" ocupado={acoes.ocupado === `demanda:${d.id}`} aoConfirmar={() => acoes.aoCancelarDemanda(d.id)} />
          </div>
        )}
      </Moldura>
    );
  }
  if (cartao.kind === 'proposta_cupom' && cartao.coupon) {
    const p = cartao.coupon.request;
    const s = situacaoDaProposta(p);
    const esperando = p.status === 'aguardando_aprovacao';
    const quem = p.requested_by.id === acoes.euId ? 'você' : p.requested_by.name;
    const linhas: Array<[string, string]> = [
      ['Cupom', p.code],
      ['Desconto', regraDoPedido(p)],
      ['Validade', validadeDoPedido(p)],
      ['Campanha', p.campaign ? `${p.campaign.name}${p.exclusive ? ' · exclusivo dela' : ''}` : 'Sem campanha'],
      ['Loja', cartao.coupon.store_name],
      ['Pedido por', `${quem}, pela LIA · ${quandoComHora(p.requested_at, acoes.agora)}`],
    ];
    if (esperando) linhas.push(['Prazo', `${vencimento(p.expires_at, acoes.agora)}, se ninguém aprovar`]);
    return (
      <Moldura icone="ticket" titulo={esperando ? 'Proposta enviada para Aprovações' : s.fim ? `Proposta: ${s.rotulo.toLocaleLowerCase('pt-BR')}` : 'Proposta de cupom'} selo={s} linhas={linhas} nota={s.nota}>
        {esperando && (
          <div className="artefato-acoes">
            {acoes.pode('campanhas.ver') && (
              <Link className="btn btn--sm btn--primary" href="/aprovacoes">
                Abrir em Aprovações
              </Link>
            )}
            {acoes.pode('cupons.criar') && (
              <Cancelar rotulo="Cancelar o pedido" pergunta="Cancelar este pedido de cupom?" ocupado={acoes.ocupado === `proposta:${p.action_id}`} aoConfirmar={() => acoes.aoCancelarProposta(p.action_id)} />
            )}
          </div>
        )}
      </Moldura>
    );
  }
  if (cartao.kind === 'reuniao' && cartao.meeting) return <Reuniao r={cartao.meeting} numeros={numeros} aoTocarNumero={aoTocarNumero} />;
  // Cartão de tipo novo (V23): a tela não inventa o que não conhece.
  return null;
}

const VOZES: Record<string, NomeIcone> = { analista: 'chart', estrategista: 'calendar', voz_contraria: 'alert' };

function Reuniao({ r, numeros, aoTocarNumero }: { r: ConversationMeeting; numeros: ExplanationNumber[]; aoTocarNumero: (n: number) => void }) {
  const texto = (t: ExplanationSegment[]) => <TextoDaExplicacao trechos={t} numeros={numeros} aoTocar={aoTocarNumero} />;
  const risco = seloDoRisco(r.risk);
  return (
    <div className="artefato">
      <div className="artefato-cab">
        <p className="artefato-tit">
          <Icone nome="users" />
          <span>Reunião de decisão</span>
        </p>
      </div>
      <p className="reuniao-pergunta">
        Em pauta: <b>{texto(r.topic)}</b>
      </p>
      <ul className="reuniao-vozes">
        {r.voices.map((v) => (
          <li key={v.agent} className={v.agent === 'voz_contraria' ? 'reuniao-voz reuniao-voz--contra' : 'reuniao-voz'}>
            <span className="av-func" aria-hidden="true">
              <Icone nome={VOZES[v.agent] ?? 'sparkles'} />
            </span>
            <b>
              {v.name}
              <small>{v.role}</small>
            </b>
            <p>{texto(v.text)}</p>
          </li>
        ))}
      </ul>
      <div className="reuniao-rec">
        <h3>Recomendação</h3>
        <p>{texto(r.recommendation)}</p>
        <p className="explica-risco">
          <span className={`st ${risco.classe}`}>
            <span className="dot" aria-hidden="true" />
            {risco.rotulo}
          </span>
          <span>{texto(r.risk_reason)}</span>
        </p>
      </div>
      <p className="artefato-nota">Quem decide é você. Nesta fase a Liame não altera campanha: a mudança é feita por você na plataforma de anúncios, e a leitura diária percebe.</p>
    </div>
  );
}

/** O contato do atendimento ("Falar com uma pessoa"): o e-mail para copiar ou abrir. A conversa com a LIA não vai junto. */
export function ContatoDoAtendimento({ contato, focarAoAparecer = false }: { contato: SupportContact; focarAoAparecer?: boolean }) {
  const [copiado, setCopiado] = useState<'sim' | 'nao' | null>(null);
  const botao = useRef<HTMLButtonElement>(null);
  const volta = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (focarAoAparecer) botao.current?.focus({ preventScroll: true });
  }, [focarAoAparecer]);
  useEffect(
    () => () => {
      if (volta.current) clearTimeout(volta.current);
    },
    [],
  );
  async function copiarEmail() {
    const ok = await copiar(contato.email);
    setCopiado(ok ? 'sim' : 'nao');
    if (volta.current) clearTimeout(volta.current);
    volta.current = setTimeout(() => setCopiado(null), 2400);
  }
  return (
    <>
      <p className="artefato-email">{contato.email}</p>
      <p className="artefato-nota">Conte o nome da empresa e o que aconteceu. A conversa com a LIA não vai junto. {prazoDoAtendimento(contato)}</p>
      <div className="artefato-acoes">
        <button ref={botao} className="btn btn--sm btn--primary" type="button" onClick={() => disparar(copiarEmail())}>
          <Icone nome="copy" pequeno />
          <span aria-live="polite">{copiado === 'sim' ? 'E-mail copiado' : copiado === 'nao' ? 'Selecione o e-mail acima' : 'Copiar o e-mail'}</span>
        </button>
        <a className="btn btn--sm" href={`mailto:${contato.email}`}>
          <Icone nome="mail" pequeno />
          Abrir o e-mail
        </a>
      </div>
    </>
  );
}
