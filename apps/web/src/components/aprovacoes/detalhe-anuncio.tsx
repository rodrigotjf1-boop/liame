'use client';

import { type RefObject, useEffect, useId, useRef, useState } from 'react';
import { TextoRico } from '@/components/resultados/pecas';
import { ListaDeFontes, TextoComNumeros, useFontes } from '@/components/resumo/numeros';
import { Icone } from '@/components/ui/icone';
import { disparar } from '@/lib/disparar';
import { quandoComHora } from '@/lib/formato';
import {
  type AcaoDeAnuncio,
  alvoNaFrase,
  caminhoDoAnuncio,
  colunasDoAnuncio,
  type MesDoPedido,
  origemDoAnuncio,
  porqueDoAnuncio,
  quemPediu,
  resultadoDoAnuncio,
  textosDoAnuncio,
} from './anuncio-textos';
import { BarraDaDecisao, type Decisao } from './barra-da-decisao';
import { aprovacaoParcial, type Grupo, identidadeDoPlano, MOTIVOS_DA_RECUSA, prazoDe, ROTULO_RISCO } from './textos';

// O pedido de anúncio aberto (mockups/prototipo-anuncios.html, P9 aprovado em 05/10/2026): mudar a verba, pausar ou
// retomar, e a volta de cada um. Esperando a decisão: a frase do que acontece, o porquê (quando nasceu de uma
// recomendação), o antes e depois, o risco e os limites, e aprovar com o código do app. Decidido: o resultado (a
// plataforma pediu para esperar, recusou, alguém mexeu depois, executado, desfeito), o caminho do pedido e o que dá
// para fazer em seguida (desfazer, que é um pedido novo; ou pedir de novo, pela gaveta).

export type Volta = { ok: true } | { ok: false; texto: string; naoDa: boolean };

type Props = {
  acao: AcaoDeAnuncio;
  grupo: Grupo | null;
  agora: Date;
  pro: boolean;
  /** Pode aprovar e recusar (`acoes.aprovar`). */
  podeDecidir: boolean;
  /** Pode pedir ação em campanha (`campanhas.operar`): desfazer e pedir de novo. */
  podeOperar: boolean;
  temApp: boolean;
  /** O mês da verba, para dizer quanto o pedido pesa até o fim dele; nulo enquanto não chegou. */
  mes: MesDoPedido | null;
  /** A gaveta "Pedir uma mudança" está aberta por este pedido. */
  pedindo: boolean;
  titulo: RefObject<HTMLHeadingElement | null>;
  campoCodigo: RefObject<HTMLInputElement | null>;
  aoVoltar: () => void;
  aoAprovar: (acao: AcaoDeAnuncio, codigo: string) => Promise<Decisao>;
  aoRecusar: (acao: AcaoDeAnuncio, motivo: string) => Promise<Decisao>;
  /** Desfazer cria o pedido de volta (que também espera a aprovação). */
  aoDesfazer: (acao: AcaoDeAnuncio) => Promise<Volta>;
  aoPedirDeNovo: (acao: AcaoDeAnuncio) => void;
  /** Abre outro pedido (a volta deste). */
  aoAbrir: (id: string) => void;
};

const MOTIVOS = MOTIVOS_DA_RECUSA.map((m) => ({ valor: m, rotulo: m }));
type FaseDaVolta = { tipo: 'nada' } | { tipo: 'confirmando'; enviando: boolean } | { tipo: 'nao-da'; texto: string } | { tipo: 'erro'; texto: string };

export function DetalheAnuncio({ acao, grupo, agora, pro, podeDecidir, podeOperar, temApp, mes, pedindo, titulo, campoCodigo, aoVoltar, aoAprovar, aoRecusar, aoDesfazer, aoPedirDeNovo, aoAbrir }: Props) {
  const ids = useId();
  const [aberto, setAberto] = useState(false);
  const [volta, setVolta] = useState<FaseDaVolta>({ tipo: 'nada' });
  const foco = useRef<HTMLElement>(null);
  const t = textosDoAnuncio(acao, mes);
  const quem = quemPediu(acao);
  const origem = origemDoAnuncio(acao);
  const plano = identidadeDoPlano(acao);
  const prazo = prazoDe(acao, agora);
  const porque = porqueDoAnuncio(acao);
  const fontes = useFontes(porque?.fontes ?? []);
  const detalhado = pro || aberto;
  const tabela = colunasDoAnuncio(acao);
  const podePedirDeNovo = podeOperar && acao.target.campaign !== null;

  // Outro pedido aberto: os detalhes abertos e a confirmação da volta eram do anterior.
  useEffect(() => {
    setAberto(false);
    setVolta({ tipo: 'nada' });
  }, [acao.id, acao.plan_hash]);

  // A confirmação da volta e o aviso de que não dá para desfazer recebem o foco quando aparecem.
  useEffect(() => {
    if (volta.tipo === 'confirmando' || volta.tipo === 'nao-da') foco.current?.focus({ preventScroll: true });
  }, [volta.tipo]);

  async function desfazer() {
    setVolta({ tipo: 'confirmando', enviando: true });
    const r = await aoDesfazer(acao);
    if (r.ok) return;
    setVolta(r.naoDa ? { tipo: 'nao-da', texto: r.texto } : { tipo: 'erro', texto: r.texto });
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
          <b>{quem.nome}</b> pediu
        </span>
        <span>
          · {quandoComHora(acao.created_at, agora)}
          {origem ? ` · ${origem}` : ''}
        </span>
      </div>
      <h2 className="det-titulo" id="ap-det-titulo" ref={titulo} tabIndex={-1}>
        {t.titulo}
      </h2>
    </>
  );
  const mudancas = (
    <div className="secao">
      <p className="rotulo-marca">{tabela.rotulo}</p>
      <div className="table-wrap">
        <table className="tabela">
          <caption className="sr-only">{tabela.legenda}</caption>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">{tabela.colunas[0]}</th>
              <th scope="col">{tabela.colunas[1]}</th>
            </tr>
          </thead>
          <tbody>
            {t.mudancas.map(([item, antes, depois]) => (
              <tr key={item}>
                <th scope="row">{item}</th>
                <td className="ap-antes num">{antes}</td>
                <td className="ap-depois num">{depois}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
  const botaoPedirDeNovo = (rotulo: string) =>
    podePedirDeNovo ? (
      <div className="desfazer">
        <button className="btn" type="button" data-pedir-de-novo aria-haspopup="dialog" aria-expanded={pedindo} onClick={() => aoPedirDeNovo(acao)}>
          <Icone nome="sliders" pequeno />
          {rotulo}
        </button>
      </div>
    ) : null;

  if (grupo !== 'pendente') {
    const r = resultadoDoAnuncio(acao, t);
    const caminho = caminhoDoAnuncio(acao, agora);
    const d = r.depois;
    return (
      <>
        {voltar}
        {cabecalho}
        <p className="plano-id">
          Plano {plano.plano} · hash <b>{plano.hash}</b>
        </p>
        <div className="secao">
          <div className={r.tom === 'neutro' ? 'resultado' : `resultado resultado--${r.tom}`} role={r.tom === 'espera' ? 'status' : undefined}>
            <Icone nome={r.icone} />
            <span>
              {r.forte && <b>{r.forte}</b>}
              <TextoRico frase={r.texto} />
              {r.tecnico && pro && (
                <span className="resultado-codigo">
                  {' '}
                  {r.tecnico.rotulo}: <code>{r.tecnico.valor}</code>.
                </span>
              )}
            </span>
          </div>
          {d.tipo === 'nota' && (
            <p className="nota">
              <Icone nome="info" />
              <span>{d.texto}</span>
            </p>
          )}
          {d.tipo === 'pedir-de-novo' && (
            <>
              {d.nota && (
                <p className="nota">
                  <Icone nome="info" />
                  <span>{d.nota}</span>
                </p>
              )}
              {botaoPedirDeNovo(d.rotulo)}
            </>
          )}
          {(d.tipo === 'volta-pendente' || d.tipo === 'volta-feita') && (
            <div className="desfazer">
              {d.tipo === 'volta-pendente' && (
                <p className="nota">
                  <Icone nome="clock" />
                  <span>A volta deste pedido já foi pedida e espera aprovação.</span>
                </p>
              )}
              <button className="btn btn--sm" type="button" onClick={() => aoAbrir(d.pedido)}>
                Ver o pedido de volta
              </button>
            </div>
          )}
          {d.tipo === 'desfazer' && volta.tipo === 'nao-da' && (
            <>
              <div className="resultado resultado--falha" role="alert">
                <Icone nome="x" />
                <span>
                  <b ref={foco} tabIndex={-1}>
                    Não dá para desfazer:
                  </b>{' '}
                  {volta.texto}
                </span>
              </div>
              {botaoPedirDeNovo('Pedir mudança')}
            </>
          )}
          {d.tipo === 'desfazer' && volta.tipo === 'confirmando' && (
            <div className="desfazer-confirma">
              <p>
                <b ref={foco} tabIndex={-1}>
                  Desfazer cria um pedido novo
                </b>{' '}
                para {t.volta}. Ele também espera a aprovação com o código do app e só é executado se ninguém mexer {alvoNaFrase(acao).no} até lá.
              </p>
              <div className="desfazer-acoes">
                <button className="btn btn--primary btn--sm" type="button" disabled={volta.enviando} aria-busy={volta.enviando || undefined} onClick={() => disparar(desfazer())}>
                  Pedir para desfazer
                </button>
                <button className="btn btn--sm" type="button" disabled={volta.enviando} onClick={() => setVolta({ tipo: 'nada' })}>
                  Cancelar
                </button>
              </div>
            </div>
          )}
          {d.tipo === 'desfazer' && (volta.tipo === 'nada' || volta.tipo === 'erro') && (
            <div className="desfazer">
              {podeOperar && (
                <button className="btn" type="button" onClick={() => setVolta({ tipo: 'confirmando', enviando: false })}>
                  <Icone nome="undo" pequeno />
                  Desfazer
                </button>
              )}
              {volta.tipo === 'erro' && (
                <p className="campo-erro" role="alert">
                  {volta.texto}
                </p>
              )}
              <p className="nota">
                <Icone nome="info" />
                <span>{d.nota}</span>
              </p>
            </div>
          )}
        </div>
        {caminho.length > 0 && (
          <div className="secao">
            <p className="rotulo-marca">O caminho do pedido</p>
            <ol className="trilha-pedido">
              {caminho.map((passo) => (
                <li key={passo.titulo}>
                  <span className={passo.situacao === 'ok' ? 'passo' : `passo passo--${passo.situacao}`} aria-hidden="true">
                    <Icone nome={passo.situacao === 'ok' ? 'check' : passo.situacao === 'espera' ? 'clock' : passo.situacao === 'falha' ? 'x' : 'arrow-right'} />
                  </span>
                  <span>
                    <b>{passo.titulo}</b>
                    {passo.sub && <small>{passo.sub}</small>}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}
        {mudancas}
      </>
    );
  }

  const parcial = aprovacaoParcial(acao);
  return (
    <>
      {voltar}
      {cabecalho}
      {!pro && (
        <div className="secao secao--lite">
          <p className="lite-frase lite-frase--grande">
            <TextoRico frase={t.frase} />
          </p>
          <div className="lite-chips">
            <span className={`risco risco--${t.risco}`}>{ROTULO_RISCO[t.risco]}</span>
            <span className="lite-chip">{t.chip}</span>
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
          Plano {plano.plano} · hash <b>{plano.hash}</b> · a aprovação vale só para este plano
        </p>
        {porque && (
          <div className="secao">
            <p className="rotulo-marca">Por quê</p>
            {porque.itens.length > 0 && (
              <div className="porque">
                {porque.itens.map((item) => (
                  <div className="porque-item" key={item.rotulo}>
                    <b className="num">
                      <TextoComNumeros texto={item.valor} lista={porque.fontes} aoTocar={fontes.mostrar} />
                    </b>
                    <span>{item.rotulo}</span>
                    {item.sub.length > 0 && (
                      <small>
                        <TextoComNumeros texto={item.sub} lista={porque.fontes} aoTocar={fontes.mostrar} />
                      </small>
                    )}
                  </div>
                ))}
              </div>
            )}
            <p className="nota">
              <Icone nome="megaphone" />
              <span>
                <TextoComNumeros texto={porque.regra} lista={porque.fontes} aoTocar={fontes.mostrar} />
              </span>
            </p>
          </div>
        )}
        {mudancas}
        <div className="secao">
          <p className="rotulo-marca">Risco e limites</p>
          <div className="politica">
            <Icone nome="shield" />
            <span>
              <b className={`risco risco--${t.risco}`}>{ROTULO_RISCO[t.risco]}.</b> {t.doRisco}
            </span>
          </div>
          <p className="nota">
            <Icone nome="check-circle" />
            <span>A plataforma confere antes: o Liame pede que ela valide a mudança e só então escreve. Se ela recusar, nada muda e o motivo aparece aqui.</span>
          </p>
          <p className="nota">
            <Icone nome="undo" />
            <span>{t.desfazer}</span>
          </p>
          <p className="nota">
            <Icone nome="clock" />
            <span>Prazo: {prazo}. Se ninguém decidir, o pedido expira e nada é feito.</span>
          </p>
        </div>
        {porque && <ListaDeFontes lista={porque.fontes} estado={fontes} id={`${ids}-fontes`} />}
      </div>
      {parcial && (
        <p className="alerta-versao" role="status">
          <Icone nome="info" pequeno />
          <span>{parcial}</span>
        </p>
      )}
      {podeDecidir ? (
        <BarraDaDecisao
          key={`${acao.id}:${acao.plan_hash}`}
          ids={ids}
          temApp={temApp}
          campoCodigo={campoCodigo}
          motivos={MOTIVOS}
          dica="O código de 6 números que o app autenticador mostra agora. A aprovação vale só para este plano."
          aoAprovar={(codigo) => aoAprovar(acao, codigo)}
          aoRecusar={(motivo) => aoRecusar(acao, motivo)}
        />
      ) : (
        <p className="nota ap-so-leitura">
          <Icone nome="lock" />
          <span>Só quem pode aprovar decide este pedido. Você acompanha por aqui.</span>
        </p>
      )}
    </>
  );
}
