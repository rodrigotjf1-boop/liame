'use client';

import type { PlanContent, PlanResponse } from '@liame/contracts';
import { type RefObject, useEffect, useId, useRef, useState } from 'react';
import { TextoDaExplicacao } from '@/components/explicar/bloco-explicacao';
import { tituloDasFontes } from '@/components/explicar/textos';
import { Icone } from '@/components/ui/icone';
import { disparar } from '@/lib/disparar';
import { BarraDaDecisao, type Decisao } from './barra-da-decisao';
import { CorpoDoPlano } from './corpo-do-plano';
import { EditarPlano } from './editar-plano';
import { avisoDaVersao, cabecalhoDoPlano, caminhosNaTela, fraseDaVerba, identidadeDaVersao, type MotivoDaRecusa, motivosDoPlano, numerosDosCaminhos, resultadoDoPlano, riscoDoPlano, trechosDo } from './planos-textos';
import { prazoDe, ROTULO_RISCO } from './textos';

// O plano do Estrategista aberto em Aprovações (mockups/prototipo-resumo.html, P8 aprovado em 03/10/2026): quem
// propôs e de onde veio o pedido, o que o plano propõe, por quê (com a fonte de cada número), o risco, e a decisão.
// Aprovar pede o código do app e vale só para a versão mostrada (o hash); editar cria outra versão; recusar pede um
// motivo; pedir nova análise devolve o plano ao Estrategista. Nada é executado pela Liame: aprovado, o plano vira a
// lista do que fazer.

/** O pedido de nova análise, em caracteres (o do protótipo). */
const PEDIDO_MAXIMO = 300;

function semMovimento(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

type Props = {
  r: PlanResponse;
  agora: Date;
  pro: boolean;
  euId: string;
  /** Tem a permissão de decidir planos (`planos.decidir`): vale para pedir nova análise do plano que expirou. */
  podeDecidir: boolean;
  /** A conta de quem vê tem o app autenticador ativo (sem ele, o servidor não deixa aprovar). */
  temApp: boolean;
  /** Pode usar a conferência de frase da marca enquanto escreve (`dossie.ver`). */
  podeConferirTexto: boolean;
  titulo: RefObject<HTMLHeadingElement | null>;
  campoCodigo: RefObject<HTMLInputElement | null>;
  aoVoltar: () => void;
  aoAprovar: (codigo: string) => Promise<Decisao>;
  aoRecusar: (motivo: MotivoDaRecusa) => Promise<Decisao>;
  aoEditar: (novo: PlanContent) => Promise<Decisao>;
  aoPedirNovaAnalise: (pedido: string) => Promise<Decisao>;
  /** O aviso curto que a tela mostra (nada mudou na edição). */
  aoAvisar: (texto: string) => void;
};

export function DetalhePlano({ r, agora, pro, euId, podeDecidir, temApp, podeConferirTexto, titulo, campoCodigo, aoVoltar, aoAprovar, aoRecusar, aoEditar, aoPedirNovaAnalise, aoAvisar }: Props) {
  const ids = useId();
  const [aberto, setAberto] = useState(false);
  const [mudando, setMudando] = useState<'nada' | 'editar' | 'nova'>('nada');
  const [fontesAbertas, setFontesAbertas] = useState(false);
  const [destaque, setDestaque] = useState<number | null>(null);
  const [anuncio, setAnuncio] = useState('');
  const [pedido, setPedido] = useState('');
  const [erroDoPedido, setErroDoPedido] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const linhas = useRef<Array<HTMLDivElement | null>>([]);
  const btEditar = useRef<HTMLButtonElement>(null);
  const btNova = useRef<HTMLButtonElement>(null);
  const campoDoPedido = useRef<HTMLTextAreaElement>(null);
  const antes = useRef(mudando);

  const p = r.plan;
  const c = r.content;
  const cab = cabecalhoDoPlano(r, euId, agora);
  const id = identidadeDaVersao(p);
  const risco = riscoDoPlano(c.risk);
  const prazo = prazoDe(p, agora);
  const detalhado = pro || aberto;
  const resultado = resultadoDoPlano(r, euId, agora);
  const aviso = avisoDaVersao(r, euId);

  // Abrir e fechar "Editar" e "Pedir nova análise": o foco entra no que abriu e volta para o botão ao fechar.
  useEffect(() => {
    if (mudando === 'nova') campoDoPedido.current?.focus({ preventScroll: true });
    else if (mudando === 'nada' && antes.current === 'editar') btEditar.current?.focus({ preventScroll: true });
    else if (mudando === 'nada' && antes.current === 'nova') btNova.current?.focus({ preventScroll: true });
    antes.current = mudando;
  }, [mudando]);

  // Tocar num número abre os detalhes e a lista das fontes, na linha dele (e diz a fonte para quem ouve a tela).
  function mostrarFonte(n: number) {
    const numero = r.numbers[n];
    if (!numero) return;
    setAberto(true);
    setFontesAbertas(true);
    setDestaque(n);
    setAnuncio(`${numero.value}: ${numero.sources.join('; ')}`);
    requestAnimationFrame(() => linhas.current[n]?.scrollIntoView({ block: 'nearest', behavior: semMovimento() ? 'auto' : 'smooth' }));
  }
  const texto = (path: string, bruto: string) => <TextoDaExplicacao trechos={trechosDo(r.marked, path, bruto)} numeros={r.numbers} aoTocar={mostrarFonte} />;

  async function enviarPedido() {
    const t = pedido.trim();
    if (t.length < 3) {
      setErroDoPedido('Escreva o que o Estrategista deve mudar.');
      campoDoPedido.current?.focus({ preventScroll: true });
      return;
    }
    setErroDoPedido(null);
    setEnviando(true);
    const res = await aoPedirNovaAnalise(t);
    setEnviando(false);
    if (!res.ok) setErroDoPedido(res.texto);
  }

  const voltar = (
    <button className="btn btn--ghost btn--sm voltar" type="button" onClick={aoVoltar}>
      <Icone nome="chevron-left" />
      Voltar para a lista
    </button>
  );
  const cabecalho = (
    <>
      <div className="det-cab">
        <span>
          <b>Estrategista</b> propôs
        </span>
        <span>
          · {cab.quando} · {cab.origem}
        </span>
      </div>
      <h2 className="det-titulo" id="ap-det-titulo" ref={titulo} tabIndex={-1}>
        {p.title}
      </h2>
    </>
  );
  const frase = (
    <p className="lite-frase lite-frase--grande">
      {texto('summary', c.summary)}
      {c.kind === 'noventa_dias' && <> {fraseDaVerba(c.budget)}</>}
    </p>
  );
  // A lista das fontes traz só os números que estão na tela (o plano decidido mostra menos textos que o pendente).
  const naTela = numerosDosCaminhos(r.marked, caminhosNaTela(c, !resultado ? 'pendente' : resultado.aprovado ? 'aprovado' : 'decidido')).filter((i) => r.numbers[i]);
  const fontes = naTela.length > 0 && (
    <details className="fontes-num" open={fontesAbertas} onToggle={(ev) => setFontesAbertas(ev.currentTarget.open)}>
      <summary>
        <Icone nome="chevron-down" pequeno />
        {tituloDasFontes(naTela.length)}
      </summary>
      <dl>
        {naTela.map((i) => (
          <div
            key={i}
            className={destaque === i ? 'destaque' : undefined}
            ref={(el) => {
              linhas.current[i] = el;
            }}
          >
            <dt>{r.numbers[i]!.value}</dt>
            {r.numbers[i]!.sources.map((fonte) => (
              <dd key={fonte}>{fonte}</dd>
            ))}
          </div>
        ))}
      </dl>
    </details>
  );
  const falado = (
    <p className="sr-only" role="status" aria-live="polite">
      {anuncio}
    </p>
  );
  const afazer = c.to_do.length > 0 && (
    <ol className="afazer">
      {c.to_do.map((t, i) => (
        <li key={i}>
          <span className="num" aria-hidden="true">
            {i + 1}
          </span>
          <span>{texto(`to_do.${i}`, t)}</span>
        </li>
      ))}
    </ol>
  );
  const novaAnalise = (
    <div className="nova-analise" id={`${ids}-nova`} hidden={mudando !== 'nova'}>
      <div className="campo">
        <label htmlFor={`${ids}-nova-txt`}>O que o Estrategista deve mudar?</label>
        <textarea
          ref={campoDoPedido}
          className="area"
          id={`${ids}-nova-txt`}
          maxLength={PEDIDO_MAXIMO}
          rows={2}
          placeholder="Ex.: quero a promoção também no sábado"
          value={pedido}
          aria-invalid={erroDoPedido ? true : undefined}
          aria-describedby={erroDoPedido ? `${ids}-nova-erro` : undefined}
          onChange={(e) => {
            setPedido(e.target.value);
            setErroDoPedido(null);
          }}
        />
      </div>
      {erroDoPedido && (
        <p className="campo-erro" id={`${ids}-nova-erro`} role="alert">
          {erroDoPedido}
        </p>
      )}
      <div className="discordar-acoes">
        <button className="btn btn--sm btn--primary" type="button" onClick={() => disparar(enviarPedido())} disabled={enviando} aria-busy={enviando}>
          {enviando ? 'Enviando…' : 'Enviar o pedido'}
        </button>
        <button className="btn btn--sm" type="button" onClick={() => setMudando('nada')} disabled={enviando}>
          Cancelar
        </button>
      </div>
    </div>
  );
  const btNovaAnalise = (
    <button ref={btNova} className="btn btn--sm" type="button" aria-expanded={mudando === 'nova'} aria-controls={`${ids}-nova`} onClick={() => setMudando((m) => (m === 'nova' ? 'nada' : 'nova'))}>
      <Icone nome="refresh" pequeno />
      Pedir nova análise
    </button>
  );

  // ---------------------------------------------------------------- o plano que não espera mais decisão
  if (resultado) {
    return (
      <>
        {voltar}
        {cabecalho}
        <p className="plano-id">
          Plano {id.plano} · versão {id.versao} · hash <b>{id.hash}</b>
        </p>
        <div className="secao">
          <div className="politica">
            <Icone nome={resultado.icone} />
            <span>{resultado.texto}</span>
          </div>
          {resultado.aprovado && afazer && (
            <>
              <p className="rotulo-marca">O que fazer agora</p>
              {afazer}
            </>
          )}
          {resultado.aprovado && (
            <p className="nota">
              <Icone nome="calendar" />
              <span>{texto('after', c.after)}</span>
            </p>
          )}
        </div>
        {p.status === 'expirado' && podeDecidir && (
          <div className="secao plano-mudar">
            <div className="plano-mudar-bts">{btNovaAnalise}</div>
            {novaAnalise}
          </div>
        )}
        <CorpoDoPlano content={c} marked={r.marked} numbers={r.numbers} aoTocar={mostrarFonte} />
        {fontes}
        {falado}
      </>
    );
  }

  // ---------------------------------------------------------------- o plano que espera decisão
  return (
    <>
      {voltar}
      {cabecalho}
      {!pro && (
        <div className="secao secao--lite">
          {frase}
          <div className="lite-chips">
            <span className={`risco risco--${risco}`}>{ROTULO_RISCO[risco]}</span>
            <span className="lite-chip">Nada vai ao ar sozinho</span>
            <span className="lite-chip">{prazo}</span>
          </div>
          <button className="detalhes-bt" type="button" aria-expanded={aberto} aria-controls={`${ids}-detalhes`} onClick={() => setAberto((x) => !x)}>
            {aberto ? 'Ocultar detalhes' : 'Ver detalhes'}
            <Icone nome="chevron-down" pequeno />
          </button>
        </div>
      )}
      <div id={`${ids}-detalhes`} hidden={!detalhado}>
        <p className="plano-id">
          Plano {id.plano} · versão {id.versao} · hash <b>{id.hash}</b> · a aprovação vale só para esta versão
        </p>
        {pro && <div className="secao">{frase}</div>}
        <div className="secao">
          <p className="rotulo-marca">Por quê</p>
          <div className="porque">
            {c.reasons.map((motivo, i) => (
              <div className="porque-item" key={i}>
                <span>{texto(`reasons.${i}`, motivo)}</span>
              </div>
            ))}
          </div>
        </div>
        <CorpoDoPlano content={c} marked={r.marked} numbers={r.numbers} aoTocar={mostrarFonte} />
        <div className="secao">
          <p className="rotulo-marca">Risco e limites</p>
          <div className="politica">
            <Icone nome="shield" />
            <span>
              <b className={`risco risco--${risco}`}>{ROTULO_RISCO[risco]}:</b> {texto('risk_reason', c.risk_reason)}
            </span>
          </div>
          <p className="nota">
            <Icone nome="info" />
            <span>Nada vai ao ar sozinho: aprovado, o plano vira a lista do que fazer, para quem cuida das campanhas. Publicar pela Liame chega numa próxima fase.</span>
          </p>
          <p className="nota">
            <Icone nome="clock" />
            <span>Prazo: {prazo}. Se ninguém decidir, o plano expira e nada é feito.</span>
          </p>
        </div>
        <div className="secao">
          <p className="rotulo-marca">Depois de aprovado</p>
          {afazer}
          <p className="nota">
            <Icone nome="calendar" />
            <span>{texto('after', c.after)}</span>
          </p>
        </div>
        {fontes}
      </div>
      {aviso && (
        <p className="alerta-versao" role="status">
          <Icone nome="info" pequeno />
          <span>{aviso}</span>
        </p>
      )}
      {r.can_decide ? (
        <>
          <div className="secao plano-mudar">
            <p className="rotulo-marca">Quer mudar algo antes de decidir?</p>
            <div className="plano-mudar-bts">
              <button ref={btEditar} className="btn btn--sm" type="button" aria-expanded={mudando === 'editar'} aria-controls={`${ids}-editar`} onClick={() => setMudando((m) => (m === 'editar' ? 'nada' : 'editar'))}>
                <Icone nome="pencil" pequeno />
                Editar o plano
              </button>
              {btNovaAnalise}
            </div>
            <div id={`${ids}-editar`} hidden={mudando !== 'editar'}>
              {mudando === 'editar' && (
                <EditarPlano
                  content={c}
                  versao={p.version}
                  marca={p.brand_id}
                  podeConferirTexto={podeConferirTexto}
                  aoSalvar={aoEditar}
                  aoCancelar={() => setMudando('nada')}
                  aoNadaMudou={() => {
                    setMudando('nada');
                    aoAvisar(`Nada mudou: o plano segue na versão ${p.version}.`);
                  }}
                />
              )}
            </div>
            {novaAnalise}
          </div>
          <BarraDaDecisao
            ids={ids}
            temApp={temApp}
            campoCodigo={campoCodigo}
            motivos={motivosDoPlano(p.kind)}
            dica={`O código de 6 números que o app autenticador mostra agora. A aprovação vale só para a versão ${p.version}.`}
            aoAprovar={aoAprovar}
            aoRecusar={(motivo) => aoRecusar(motivo as MotivoDaRecusa)}
          />
        </>
      ) : (
        <p className="nota ap-so-leitura">
          <Icone nome="lock" />
          <span>Só quem pode decidir os planos aprova este. Você acompanha por aqui.</span>
        </p>
      )}
      {falado}
    </>
  );
}
