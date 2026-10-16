'use client';

import type { AdDeliveryResponse } from '@liame/contracts';
import Link from 'next/link';
import { Fragment, type RefObject, useEffect, useRef, useState } from 'react';
import { useAvisar } from '@/components/ui/avisos';
import { Icone } from '@/components/ui/icone';
import { useAgora } from '@/lib/agora';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { useDetalhes } from '@/lib/modo';
import {
  andamentoDaLeitura,
  avisoDoFim,
  type CartaoDosAnuncios,
  ENDERECO_DA_PLATAFORMA,
  ESPERA_DA_LEITURA_MS,
  falharamNoPrazo,
  type LerAgora,
  marcasDe,
  montarCartaoDosAnuncios,
  type OQueMudou,
  PASSO_DA_ESPERA_MS,
} from './anuncios';
import { BotaoDetalhes, TextoRico } from './pecas';
import type { Periodo } from './textos';

// "Como os anúncios rodaram" (protótipo P23, aprovado em 16/10/2026): os números que a Meta e o Google informam, na
// contagem deles, logo depois de "Por campanha". O cartão pede os números à API sozinho (`/v1/results/delivery`) e
// só aparece com a função ligada para a empresa. "Ler agora" pede a leitura e pergunta de 5 em 5 segundos se ela
// terminou, por até 3 minutos.

export type ConsultaDosAnuncios = { brand_id: string; from: string; to: string };
/**
 * O que a tela de Resultados passa ao cartão: a consulta, o período escolhido e o que fazer quando a leitura pedida
 * termina (a tela lê de novo os números do caixa: o gasto de "Por campanha" é o mesmo do cartão, ERR-140).
 */
export type AnunciosDaTela = { consulta: ConsultaDosAnuncios; periodo: Periodo; aoTerminarLeitura?: () => void };

type Carga = { tipo: 'carregando' } | { tipo: 'ok'; chave: string; dados: AdDeliveryResponse } | { tipo: 'erro'; chave: string; problema: Problema };

type Props = {
  /** A marca e o período da tela (a loja não entra: as contas de anúncio são da marca). */
  consulta: ConsultaDosAnuncios;
  periodo: Periodo;
  fuso: string;
  podeVerContas: boolean;
  /** Chamado uma vez quando a leitura pedida termina (bem, com falha ou no fim do prazo). */
  aoTerminarLeitura?: () => void;
};

const SUB = 'O que a Meta e o Google informam, na contagem deles: quantas vezes os anúncios apareceram, para quantas pessoas, os cliques e o gasto. O que voltou no caixa está em “Por campanha”.';

export function CartaoAnuncios({ consulta, periodo, fuso, podeVerContas, aoTerminarLeitura }: Props) {
  const avisar = useAvisar();
  // Em ref: a tela pode passar uma função nova a cada desenho, e a espera do "Ler agora" não recomeça por isso.
  const aoTerminar = useRef(aoTerminarLeitura);
  useEffect(() => {
    aoTerminar.current = aoTerminarLeitura;
  });
  const d = useDetalhes();
  const chave = JSON.stringify(consulta);
  const [carga, setCarga] = useState<Carga>({ tipo: 'carregando' });
  // Os últimos números que chegaram: ficam na tela (esmaecidos) enquanto o período novo carrega.
  const [ultima, setUltima] = useState<{ chave: string; dados: AdDeliveryResponse } | null>(null);
  const [tentativa, setTentativa] = useState(0);
  const [buscando, setBuscando] = useState(false);
  const [leitura, setLeitura] = useState<LerAgora>({ tipo: 'parado' });
  const status = useRef<HTMLParagraphElement>(null);
  // Foco na linha da leitura: ao pedir (o botão se desliga) e, no fim, só se o foco não saiu dali.
  const focar = useRef<'sempre' | 'se-ficou' | null>(null);
  const agora = useAgora(10_000, carga);

  useEffect(() => {
    let vivo = true;
    setBuscando(true);
    disparar(
      chamar(() => api.GET('/v1/results/delivery', { params: { query: JSON.parse(chave) as ConsultaDosAnuncios } })).then((r) => {
        if (!vivo) return;
        setBuscando(false);
        if (r.ok) {
          setCarga({ tipo: 'ok', chave, dados: r.data });
          setUltima({ chave, dados: r.data });
        } else {
          setCarga({ tipo: 'erro', chave, problema: r.problema });
        }
      }),
    );
    return () => {
      vivo = false;
    };
  }, [chave, tentativa]);

  // A espera do "Ler agora": uma consulta por passo; os números da tela andam junto.
  useEffect(() => {
    if (leitura.tipo !== 'lendo') return;
    let vivo = true;
    const passo = setTimeout(() => {
      disparar(
        chamar(() => api.GET('/v1/results/delivery', { params: { query: JSON.parse(chave) as ConsultaDosAnuncios } })).then((r) => {
          if (!vivo) return;
          const venceu = Date.now() - leitura.desde >= ESPERA_DA_LEITURA_MS;
          if (!r.ok) {
            setLeitura(venceu ? { tipo: 'demorou', pedidoEm: leitura.pedidoEm } : { ...leitura });
            return;
          }
          setCarga({ tipo: 'ok', chave, dados: r.data });
          setUltima({ chave, dados: r.data });
          const a = andamentoDaLeitura(r.data.accounts, leitura.pedidoEm, leitura.antes, leitura.vistas);
          let fim: LerAgora | null = null;
          // O "antes" vai junto até o fim: o cartão mostra o que a leitura mudou (P23, parte B).
          if (a.pendentes === 0) fim = { tipo: 'terminou', pedidoEm: leitura.pedidoEm, falharam: a.falharam, anterior: leitura.anterior };
          else if (venceu) {
            const f = falharamNoPrazo(r.data.accounts, leitura.pedidoEm);
            fim = f.length ? { tipo: 'terminou', pedidoEm: leitura.pedidoEm, falharam: f, anterior: leitura.anterior } : { tipo: 'demorou', pedidoEm: leitura.pedidoEm };
          }
          if (fim) {
            focar.current = 'se-ficou';
            setLeitura(fim);
            const aviso = avisoDoFim(fim, r.data.accounts, fuso);
            if (aviso) avisar(aviso, { tipo: fim.tipo === 'terminou' && !fim.falharam.length ? 'ok' : 'perigo' });
            // O resto de Resultados (o gasto de "Por campanha", a hora de cada fonte) lê de novo (ERR-140).
            aoTerminar.current?.();
            return;
          }
          setLeitura({ ...leitura, vistas: Object.fromEntries(r.data.accounts.map((c) => [c.connected_account_id, c.last_attempt_at])) });
        }),
      );
    }, PASSO_DA_ESPERA_MS);
    return () => {
      vivo = false;
      clearTimeout(passo);
    };
  }, [leitura, chave, fuso, avisar]);

  useEffect(() => {
    const modo = focar.current;
    if (!modo || !status.current) return;
    focar.current = null;
    const ativo = document.activeElement;
    if (modo === 'sempre' || ativo === status.current || ativo === document.body || ativo === null) status.current.focus({ preventScroll: true });
  });

  async function lerAgora() {
    const dados = carga.tipo === 'ok' ? carga.dados : null;
    if (!dados || leitura.tipo === 'pedindo' || leitura.tipo === 'lendo') return;
    const antes = marcasDe(dados.accounts);
    focar.current = 'sempre';
    setLeitura({ tipo: 'pedindo' });
    const r = await chamar(() => api.POST('/v1/results/delivery/refresh', { body: { brand_id: consulta.brand_id } }));
    if (!r.ok) {
      setLeitura({ tipo: 'parado' });
      // Outra pessoa da empresa leu há pouco (429): a consulta nova traz quando dá para ler de novo.
      setTentativa((x) => x + 1);
      avisar(r.problema.code === 'leitura-recente' ? mensagemDe(r.problema) : `Não deu para pedir a leitura agora. ${mensagemDe(r.problema)}`, { tipo: 'perigo' });
      return;
    }
    if (r.data.accounts === 0) {
      setLeitura({ tipo: 'parado' });
      setTentativa((x) => x + 1);
      avisar('Nenhuma conta de anúncio está pronta para ler agora.', { tipo: 'perigo' });
      return;
    }
    setLeitura({ tipo: 'lendo', pedidoEm: r.data.requested_at, desde: Date.now(), antes, vistas: {}, anterior: dados });
  }

  const naTela = carga.tipo === 'ok' && carga.chave === chave ? carga.dados : (ultima?.dados ?? null);
  // Sem nenhum número ainda (ou com a função desligada), o cartão não aparece: não se sabe se ele existe.
  if (!naTela) return null;
  if (carga.tipo === 'erro' && carga.chave === chave) {
    return (
      <article className="card" id="card-anuncios" aria-labelledby="t-anuncios">
        <Cabecalho pro={d.pro} />
        <div className="dialogo-erro" role="alert">
          <Icone nome="alert" pequeno />
          <span>
            Não deu para carregar os números das plataformas. {mensagemDe(carga.problema)}{' '}
            <button className="link-bt" type="button" onClick={() => setTentativa((x) => x + 1)} disabled={buscando} aria-busy={buscando}>
              Tentar de novo
            </button>
          </span>
        </div>
      </article>
    );
  }
  const cartao = montarCartaoDosAnuncios({ resposta: naTela, periodo, fuso, agora, leitura, podeVerContas });
  if (cartao.tipo === 'desligado') return null;
  return (
    <VistaDosAnuncios
      cartao={cartao}
      pro={d.pro}
      aberto={d.aberto}
      aoAlternar={d.alternar}
      aoLer={() => disparar(lerAgora())}
      status={status}
      recarregando={!(carga.tipo === 'ok' && carga.chave === chave)}
    />
  );
}

function Cabecalho({ pro }: { pro: boolean }) {
  return (
    <div className="card-cab">
      <div>
        <h2 id="t-anuncios">{pro ? 'Desempenho nas plataformas' : 'Como os anúncios rodaram'}</h2>
        <p className="card-sub">{SUB}</p>
      </div>
    </div>
  );
}

type Vista = {
  cartao: Exclude<CartaoDosAnuncios, { tipo: 'desligado' }>;
  pro: boolean;
  /** "Ver os números de cada campanha" aberto no modo simples. */
  aberto: boolean;
  aoAlternar: () => void;
  aoLer: () => void;
  status?: RefObject<HTMLParagraphElement | null>;
  recarregando?: boolean;
};

/**
 * Logo abaixo da linha da leitura, depois do "Ler agora" (P23, parte B): cada número que mudou, com o antes e o depois,
 * dizendo de qual leitura é o antes; ou que nada mudou; ou, na primeira leitura do período, o que entrou.
 */
function OQueMudouNaTela({ mudou }: { mudou: OQueMudou }) {
  if (mudou.tipo === 'igual') {
    return (
      <div className="an-mudou">
        <p className="an-mudou-tit">
          <b>Nenhum número mudou nesta leitura.</b> {mudou.frase}
        </p>
      </div>
    );
  }
  if (mudou.tipo === 'entrou') {
    return (
      <div className="an-mudou">
        <p className="an-mudou-tit">
          <b>O que entrou nesta leitura</b>
        </p>
        <p className="an-mudou-tit">{mudou.frase}</p>
      </div>
    );
  }
  return (
    <div className="an-mudou">
      <p className="an-mudou-tit">
        <b>O que mudou nesta leitura</b> (antes: {mudou.antes})
      </p>
      <ul className="an-mudou-lista">
        {mudou.linhas.map((l, i) => (
          <li key={i}>
            <span className="rot">{l.rotulo}</span>
            <span className="de">{l.antes}</span>
            <span aria-hidden="true">→</span>
            <b>
              <span className="sr-only">passou para </span>
              {l.depois}
            </b>
          </li>
        ))}
      </ul>
      <p className="an-mudou-nota">{mudou.nota}</p>
    </div>
  );
}

/** O cartão desenhado a partir das regras (separado da busca para ser desenhado igual no teste e no navegador). */
export function VistaDosAnuncios({ cartao, pro, aberto, aoAlternar, aoLer, status, recarregando = false }: Vista) {
  if (cartao.tipo === 'sem-plataforma') {
    return (
      <article className="card" id="card-anuncios" aria-labelledby="t-anuncios" data-anuncios="sem-plataforma">
        <Cabecalho pro={pro} />
        <div className="an-vazio">
          <p>{cartao.texto}</p>
          {cartao.contas && (
            <Link className="btn btn--sm btn--primary" href="/contas">
              <Icone nome="plug" pequeno />
              Abrir Contas conectadas
            </Link>
          )}
        </div>
      </article>
    );
  }
  const { leitura } = cartao;
  const botao = leitura.botao;
  const mostraPro = pro || aberto;
  return (
    <article className={recarregando ? 'card recarregando' : 'card'} id="card-anuncios" aria-labelledby="t-anuncios" aria-busy={recarregando}>
      <Cabecalho pro={pro} />
      <div className="an-leitura" aria-busy={botao.tipo === 'ler' && botao.ocupado ? true : undefined}>
        <p id="an-status" ref={status} tabIndex={-1} className={leitura.falha ? 'an-falha' : undefined}>
          <TextoRico frase={leitura.frase} />
        </p>
        {/* P23, parte B: "Ler agora" é o botão principal do cartão. */}
        {botao.tipo === 'ler' && (
          <button className="btn btn--primary" type="button" disabled={botao.desligado} aria-busy={botao.ocupado || undefined} onClick={aoLer}>
            <Icone nome="refresh" pequeno />
            {botao.rotulo}
          </button>
        )}
        {botao.tipo === 'contas' && (
          <Link className="btn btn--primary" href="/contas">
            <Icone nome="plug" pequeno />
            Abrir Contas conectadas
          </Link>
        )}
      </div>
      {cartao.notas.map((n) => (
        <p className="an-nota" key={n}>
          {n}
        </p>
      ))}
      {cartao.mudou && <OQueMudouNaTela mudou={cartao.mudou} />}
      {cartao.vazio ? (
        <div className="an-vazio">
          <p>{cartao.vazio}</p>
        </div>
      ) : (
        <>
          {cartao.caixas && (
            <ul className="an-numeros">
              {cartao.caixas.map((c) => (
                <li key={c.rotulo} className={c.novo ? 'an-novo' : undefined}>
                  <b>{c.valor}</b>
                  {c.rotulo}
                  {c.nota && <small>{c.nota}</small>}
                  {c.novo && <em className="an-tag">atualizado agora</em>}
                </li>
              ))}
            </ul>
          )}
          {cartao.comparar.length > 0 && (
            <p className="an-comparar">
              Comparar com a plataforma:{' '}
              {cartao.comparar.map((p, i) => (
                <Fragment key={p}>
                  {i > 0 && ' · '}
                  <a href={ENDERECO_DA_PLATAFORMA[p].url} target="_blank" rel="noopener noreferrer">
                    {ENDERECO_DA_PLATAFORMA[p].nome}
                    <Icone nome="external" pequeno />
                  </a>
                </Fragment>
              ))}
              <span className="sr-only"> (abre em outra aba)</span>
            </p>
          )}
          {!mostraPro && (
            <ul className="an-camps">
              {cartao.campanhas.map((c) => (
                <li className="an-camp" key={c.id}>
                  <div className="an-camp-cab">
                    <b>{c.nome}</b>
                    <span>{c.plataforma}</span>
                  </div>
                  <div className="funil-trilho" role="img" aria-label={c.rotuloDaBarra}>
                    <span style={{ width: `${c.barra}%` }} />
                  </div>
                  <p className="funil-txt">
                    <TextoRico frase={c.resumo} />
                  </p>
                </li>
              ))}
            </ul>
          )}
          {!pro && cartao.campanhas.length > 0 && (
            <BotaoDetalhes aberto={aberto} controla="anuncios-pro" aoAlternar={aoAlternar} rotulos={['Ver os números de cada campanha', 'Ocultar os números de cada campanha']} />
          )}
          <div className="an-pro" id="anuncios-pro" hidden={!mostraPro}>
            <ul className="an-camps">
              {cartao.campanhas.map((c) => (
                <li className="an-camp" key={c.id}>
                  <div className="an-camp-cab">
                    <b>{c.nome}</b>
                    <span>{c.plataformaETipo}</span>
                  </div>
                  <ul className="an-met">
                    {c.caixas.map((x) => (
                      <li key={x.rotulo}>
                        <b>{x.valor}</b>
                        {x.rotulo}
                        {x.nota && <small>{x.nota}</small>}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
            <p className="eixo-nota">{cartao.notaDoPro}</p>
          </div>
        </>
      )}
    </article>
  );
}
