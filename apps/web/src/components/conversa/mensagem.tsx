'use client';

import type { ConversationMessage, ConversationStep, ExplanationSegment, SupportContact } from '@liame/contracts';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { TextoDaExplicacao } from '@/components/explicar/bloco-explicacao';
import { seloDoRisco, tituloDasFontes } from '@/components/explicar/textos';
import { IconeLia } from '@/components/marca/logo';
import { Icone } from '@/components/ui/icone';
import { horaDe } from '@/lib/formato';
import type { Modo } from '@/lib/modo';
import { type AcoesDosCartoes, CartaoDaConversa, ContatoDoAtendimento } from './cartoes';
import { RetornoDaMensagem } from './retorno-da-mensagem';
import { avisoDoSistema, caminhosDa, gruposDe, NOTA_DO_SISTEMA, registradoNoAviso, textoDaResposta } from './textos';

// As mensagens da conversa (protótipo P5). A da pessoa, como foi guardada (sem dado pessoal); a da LIA, em blocos já
// conferidos, com a fonte de cada número, o que ela leu e o que ela registrou; e o aviso do sistema, que nunca é
// escrito por IA. Durante a resposta, aparece o que a LIA está lendo. O pedido que o sistema conhece é respondido por
// regra, sem IA (`by_system`): a resposta aparece como "Resumo do sistema", com o selo "Sem IA", como no Explicar.

/** O aviso que ficou no lugar de uma resposta. `cards`: o que a LIA já tinha registrado antes dele (a demanda, a proposta de cupom). */
type AvisoDoServidor = Pick<ConversationMessage, 'notice' | 'retry_at' | 'budget_window' | 'stale_sources' | 'contact' | 'cards'>;

export type Item =
  | { de: 'eu'; id: string; em: string; texto: string; nota: string | null }
  | { de: 'lia'; id: string; em: string; fase: 'saudacao'; paragrafos: string[] }
  | { de: 'lia'; id: string; em: string; fase: 'respondendo'; passos: ConversationStep[] }
  | { de: 'lia'; id: string; em: string; fase: 'parada' | 'pronta'; m: ConversationMessage }
  | { de: 'sistema'; id: string; em: string; m: AvisoDoServidor; focar?: boolean };

function semMovimento(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function MensagemDaPessoa({ item }: { item: Extract<Item, { de: 'eu' }> }) {
  return (
    <li className="msg msg--eu" id={`msg-${item.id}`}>
      <p className="msg-bolha">
        <span className="sr-only">Você: </span>
        {item.texto}
      </p>
      {item.nota && (
        <p className="msg-nota">
          <Icone nome="lock" pequeno />
          <span>{item.nota}</span>
        </p>
      )}
    </li>
  );
}

function Cabecalho({ em, saudacao = false, parada = false, doSistema = false }: { em: string; saudacao?: boolean; parada?: boolean; doSistema?: boolean }) {
  // O resumo montado por regra não é da LIA: leva o nome e o selo do sistema.
  if (doSistema) {
    return (
      <div className="msg-cab">
        <span className="av-sistema" aria-hidden="true">
          <Icone nome="file" />
        </span>
        <b>Resumo do sistema</b>
        <span className="st st--espera">Sem IA</span>
        <time dateTime={em}>{horaDe(em)}</time>
      </div>
    );
  }
  return (
    <div className="msg-cab">
      <IconeLia />
      <b>LIA</b>
      {/* A saudação é da tela, e a resposta interrompida não tem texto: nenhuma das duas leva o selo. */}
      {!saudacao && !parada && (
        <span className="st st--ia">
          <Icone nome="sparkles" />
          Feito com IA
        </span>
      )}
      {parada && <span className="st st--espera">Interrompida por você</span>}
      <time dateTime={em}>{horaDe(em)}</time>
    </div>
  );
}

export function MensagemDaLia({
  item,
  modo,
  pode,
  cartoes,
  ultima,
  aoPerguntarDeNovo,
  aoPedirAnalise,
}: {
  item: Extract<Item, { de: 'lia' }>;
  modo: Modo;
  pode: (permissao: string) => boolean;
  cartoes: AcoesDosCartoes;
  /** É a última mensagem da conversa: só nela "Perguntar de novo" faz sentido. */
  ultima: boolean;
  aoPerguntarDeNovo: () => void;
  /** Depois de um resumo do sistema, a pessoa pode pedir a análise da LIA (a pergunta seguinte, já escrita). */
  aoPedirAnalise: () => void;
}) {
  const [fontesAbertas, setFontesAbertas] = useState(false);
  const [destaque, setDestaque] = useState<number | null>(null);
  const [anuncio, setAnuncio] = useState('');
  const linhas = useRef<Array<HTMLDivElement | null>>([]);

  if (item.fase === 'saudacao') {
    return (
      <li className="msg msg--lia" id={`msg-${item.id}`}>
        <Cabecalho em={item.em} saudacao />
        <div className="msg-corpo">
          {item.paragrafos.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </div>
      </li>
    );
  }
  if (item.fase === 'respondendo') {
    return (
      <li className="msg msg--lia" id={`msg-${item.id}`} aria-busy="true">
        <Cabecalho em={item.em} />
        {item.passos.length > 0 && (
          <ul className="msg-passos">
            {item.passos.map((p) => (
              <li key={p.id}>
                {p.status === 'lendo' ? <span className="girando" aria-hidden="true" /> : <Icone nome={p.status === 'falhou' ? 'alert' : 'check'} />}
                <span>
                  {p.label}
                  {p.status === 'lendo' ? '…' : p.status === 'falhou' ? ' (não deu para ler)' : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p>
          <span className="digitando" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="sr-only">A LIA está respondendo</span>
        </p>
      </li>
    );
  }

  const m = item.m;
  if (item.fase === 'parada') {
    // Parar não desfaz o que a LIA já tinha registrado: o cartão da demanda ou da proposta aparece, e aí não se
    // oferece perguntar de novo (a mesma pergunta registraria outro pedido).
    const registrou = m.cards.length > 0;
    return (
      <li className="msg msg--lia" id={`msg-${item.id}`}>
        <Cabecalho em={item.em} parada />
        {registrou && (
          <div className="msg-corpo">
            {m.cards.map((c, i) => (
              <CartaoDaConversa key={`${c.kind}-${i}`} cartao={c} numeros={m.numbers} aoTocarNumero={() => {}} acoes={cartoes} />
            ))}
          </div>
        )}
        {ultima && !registrou && (
          <div className="explica-acoes">
            <button className="btn btn--sm" type="button" onClick={aoPerguntarDeNovo}>
              <Icone nome="refresh" pequeno />
              Perguntar de novo
            </button>
          </div>
        )}
      </li>
    );
  }

  // Tocar num número abre a lista na linha dele (e diz a fonte para quem ouve a tela).
  function mostrarFonte(n: number) {
    const numero = m.numbers[n];
    if (!numero) return;
    setFontesAbertas(true);
    setDestaque(n);
    setAnuncio(`${numero.value}: ${numero.sources.join('; ')}`);
    requestAnimationFrame(() => linhas.current[n]?.scrollIntoView({ block: 'nearest', behavior: semMovimento() ? 'auto' : 'smooth' }));
  }
  const texto = (t: ExplanationSegment[]) => <TextoDaExplicacao trechos={t} numeros={m.numbers} aoTocar={mostrarFonte} />;
  const caminhos = caminhosDa(m.read, pode);
  const doSistema = m.by_system;
  const pedirAnalise = doSistema && ultima;

  return (
    <li className="msg msg--lia" id={`msg-${item.id}`}>
      <Cabecalho em={item.em} doSistema={doSistema} />
      <div className="msg-corpo">
        {gruposDe(m.blocks).map((g, i) => {
          if (g.tipo === 'paragrafo') return <p key={i}>{texto(g.texto)}</p>;
          if (g.tipo === 'risco') {
            const selo = seloDoRisco(g.risco);
            return (
              <p className="explica-risco" key={i}>
                <span className={`st ${selo.classe}`}>
                  <span className="dot" aria-hidden="true" />
                  {selo.rotulo}
                </span>
                <span>{texto(g.texto)}</span>
              </p>
            );
          }
          const lista = (
            <ul className={g.tipo === 'fazer' ? 'explica-lista explica-lista--fazer' : 'explica-lista'}>
              {g.itens.map((t, k) => (
                <li key={k}>{texto(t)}</li>
              ))}
            </ul>
          );
          return g.tipo === 'fazer' ? (
            <div className="explica-sec" key={i}>
              <h3>O que fazer</h3>
              {lista}
            </div>
          ) : (
            <div key={i}>{lista}</div>
          );
        })}
        {m.cards.map((c, i) => (
          <CartaoDaConversa key={`${c.kind}-${i}`} cartao={c} numeros={m.numbers} aoTocarNumero={mostrarFonte} acoes={cartoes} />
        ))}
        {doSistema && <p className="explica-nota">{NOTA_DO_SISTEMA}</p>}
      </div>
      {(caminhos.length > 0 || pedirAnalise) && (
        <div className="explica-acoes">
          {caminhos.map((c) => (
            <Link className="btn btn--sm" href={c.href} key={c.href}>
              {c.rotulo}
            </Link>
          ))}
          {pedirAnalise && (
            <button className="btn btn--sm" type="button" onClick={aoPedirAnalise}>
              <Icone nome="sparkles" pequeno />
              Pedir a análise da LIA
            </button>
          )}
        </div>
      )}
      {modo === 'pro' && m.read.length > 0 && (
        <p className="msg-leu">
          <span>Leu:</span>
          {m.read.map((l) => (
            <span className="lite-chip" key={l}>
              {l}
            </span>
          ))}
        </p>
      )}
      {m.numbers.length > 0 && (
        <details className="fontes-num" open={fontesAbertas} onToggle={(ev) => setFontesAbertas(ev.currentTarget.open)}>
          <summary>
            <Icone nome="chevron-down" pequeno />
            {tituloDasFontes(m.numbers.length)}
          </summary>
          <dl>
            {m.numbers.map((n, i) => (
              <div
                key={i}
                className={destaque === i ? 'destaque' : undefined}
                ref={(el) => {
                  linhas.current[i] = el;
                }}
              >
                <dt>{n.value}</dt>
                {n.sources.map((fonte) => (
                  <dd key={fonte}>{fonte}</dd>
                ))}
              </div>
            ))}
          </dl>
          {m.read.length > 0 && (
            <p className="explica-nota">
              {doSistema ? 'O sistema leu' : 'A LIA leu'}: {m.read.join('; ')}.
            </p>
          )}
        </details>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {anuncio}
      </p>
      <RetornoDaMensagem id={item.id} usageId={m.usage_id} texto={textoDaResposta(m)} />
    </li>
  );
}

export function MensagemDoSistema({
  item,
  podeVerContas,
  ultima,
  contato,
  cartoes,
  aoTentarDeNovo,
}: {
  item: Extract<Item, { de: 'sistema' }>;
  podeVerContas: boolean;
  ultima: boolean;
  cartoes: AcoesDosCartoes;
  /** O contato do atendimento (da lista de conversas), para o aviso que não trouxe o dele. */
  contato: SupportContact | null;
  aoTentarDeNovo: () => void;
}) {
  const a = avisoDoSistema(item.m);
  const doAtendimento = item.m.contact ?? contato;
  // O texto da LIA não apareceu, mas o que ela registrou antes disso (a demanda, a proposta) continua valendo: o aviso
  // mostra o cartão e não oferece tentar de novo (a mesma pergunta registraria outro pedido).
  const registrado = registradoNoAviso(item.m.cards);
  return (
    <li className="msg msg--sistema" id={`msg-${item.id}`}>
      <div className="msg-cab">
        <span className="av-sistema" aria-hidden="true">
          <Icone nome="file" />
        </span>
        <b>Aviso do sistema</b>
        <span className="st st--espera">{a.selo}</span>
        <time dateTime={item.em}>{horaDe(item.em)}</time>
      </div>
      <div className="artefato artefato--sistema">
        <p className="artefato-tit">
          <Icone nome={a.icone} />
          <span>{a.titulo}</span>
        </p>
        <div className="msg-corpo">
          {a.paragrafos.map((p) => (
            <p key={p}>{p}</p>
          ))}
          {registrado && <p>{registrado}</p>}
        </div>
        {a.acao === 'contato' && doAtendimento && <ContatoDoAtendimento contato={doAtendimento} focarAoAparecer={item.focar} />}
        {a.acao === 'tentar' && ultima && !registrado && (
          <div className="artefato-acoes">
            <button className="btn btn--sm" type="button" onClick={aoTentarDeNovo}>
              <Icone nome="refresh" pequeno />
              Tentar de novo
            </button>
          </div>
        )}
        {a.acao === 'ver-conexao' && podeVerContas && (
          <div className="artefato-acoes">
            <Link className="btn btn--sm" href="/contas">
              Ver a conexão
            </Link>
          </div>
        )}
      </div>
      {registrado && (
        <div className="msg-corpo">
          {item.m.cards.map((c, i) => (
            <CartaoDaConversa key={`${c.kind}-${i}`} cartao={c} numeros={[]} aoTocarNumero={() => {}} acoes={cartoes} />
          ))}
        </div>
      )}
    </li>
  );
}
