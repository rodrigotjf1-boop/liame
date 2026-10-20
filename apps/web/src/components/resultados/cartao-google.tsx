'use client';

import type { GoogleVisibilityResponse } from '@liame/contracts';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { useDetalhes } from '@/lib/modo';
import { BarraDividida } from './desenhos';
import { BUSCAS_NO_SIMPLES, type BuscaNaTela, type CartaoDoGoogle, type LinhaDosCliques, montarCartaoDoGoogle, type ParteDoGoogle, type Variacao } from './google';
import { BotaoDetalhes, TextoRico } from './pecas';
import type { Periodo } from './textos';

// "Como te acham no Google" (protótipo P18, aprovado em 15/10/2026), depois de "De onde vieram os pedidos": o perfil
// da empresa no Google e o site no Search Console, e as buscas da última semana fechada. O cartão pede os números à
// API sozinho (`/v1/results/google-visibility`) e só aparece com a função do perfil ou a do Search Console ligada.

export type ConsultaDoGoogle = { brand_id: string; days: '7' | '30' };
/** O que a tela de Resultados passa ao cartão: a marca, os dias (em "Hoje", 7) e o período escolhido. */
export type GoogleDaTela = { consulta: ConsultaDoGoogle; periodo: Periodo };

type Carga = { tipo: 'carregando' } | { tipo: 'ok'; chave: string; dados: GoogleVisibilityResponse } | { tipo: 'erro'; chave: string; problema: Problema };

type Props = { consulta: ConsultaDoGoogle; periodo: Periodo; podeVerContas: boolean };

const TITULO = 'Como te acham no Google';

export function CartaoGoogle({ consulta, periodo, podeVerContas }: Props) {
  const d = useDetalhes();
  const chave = JSON.stringify(consulta);
  const [carga, setCarga] = useState<Carga>({ tipo: 'carregando' });
  // Os últimos números que chegaram: ficam na tela (esmaecidos) enquanto o período novo carrega.
  const [ultima, setUltima] = useState<{ chave: string; dados: GoogleVisibilityResponse } | null>(null);
  const [tentativa, setTentativa] = useState(0);
  const [buscando, setBuscando] = useState(false);

  useEffect(() => {
    let vivo = true;
    setBuscando(true);
    disparar(
      chamar(() => api.GET('/v1/results/google-visibility', { params: { query: JSON.parse(chave) as ConsultaDoGoogle } })).then((r) => {
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

  const naTela = carga.tipo === 'ok' && carga.chave === chave ? carga.dados : (ultima?.dados ?? null);
  // Sem nenhum número ainda (ou com as funções desligadas), o cartão não aparece: não se sabe se ele existe.
  if (!naTela) return null;
  if (carga.tipo === 'erro' && carga.chave === chave) {
    return (
      <article className="card" id="card-google" aria-labelledby="t-google">
        <div className="card-cab">
          <div>
            <h2 id="t-google">{TITULO}</h2>
          </div>
        </div>
        <div className="dialogo-erro" role="alert">
          <Icone nome="alert" pequeno />
          <span>
            Não deu para carregar os números do Google. {mensagemDe(carga.problema)}{' '}
            <button className="link-bt" type="button" onClick={() => setTentativa((x) => x + 1)} disabled={buscando} aria-busy={buscando}>
              Tentar de novo
            </button>
          </span>
        </div>
      </article>
    );
  }
  const cartao = montarCartaoDoGoogle(naTela, periodo, podeVerContas);
  if (cartao.tipo === 'desligado') return null;
  return <VistaDoGoogle cartao={cartao} pro={d.pro} aberto={d.aberto} aoAlternar={d.alternar} recarregando={!(carga.tipo === 'ok' && carga.chave === chave)} />;
}

function VariacaoNaTela({ variacao }: { variacao: Variacao }) {
  return (
    <p className="variacao">
      {variacao.sentido !== 'igual' && (
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path className={variacao.sentido === 'sobe' ? 'sobe' : 'cai'} d={variacao.sentido === 'sobe' ? 'M5 1 9.5 9h-9z' : 'M5 9 .5 1h9z'} />
        </svg>
      )}
      <span>
        <TextoRico frase={variacao.frase} />
      </span>
    </p>
  );
}

/** Os cliques do site por dia, numa linha só (sem colunas: aqui não há gasto). */
function CliquesPorDia({ dias }: { dias: LinhaDosCliques }) {
  const ultimo = dias.pontos.length - 1;
  const passo = 100 / ultimo;
  return (
    <div className="mini">
      <div className="mini-topo">
        <span className="mini-leg">
          <span>
            <i className="lg-linha" aria-hidden="true" />
            cliques por dia
          </span>
        </span>
        <span>
          <b>{dias.ultimo.valor}</b> {dias.ultimo.quando}
        </span>
      </div>
      <div className="faisca" role="img" tabIndex={0} aria-label={dias.rotulo}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <path className="area" d={dias.area} />
          <path className="fio" d={dias.linha} />
        </svg>
        <span className="pt" style={{ left: '100%', top: `${dias.ultimo.y}%` }} />
        {/* A área de cada dia vai até a metade do caminho para o vizinho; nas pontas, só a metade de dentro. */}
        {dias.pontos.map((p, i) => (
          <span
            key={i}
            className={i === 0 ? 'alvo alvo--ini' : i === ultimo ? 'alvo alvo--fim' : 'alvo'}
            style={i === 0 || i === ultimo ? { width: `${passo / 2}%` } : { left: `${p.x}%`, width: `${passo}%` }}
            data-dica={p.dica}
          />
        ))}
      </div>
      <div className="faisca-dias" aria-hidden="true">
        {dias.marcas.map((m) => (
          <span key={m.x} className={m.extra ? 'faisca-dia-extra' : undefined} style={{ left: `${m.x}%` }}>
            {m.texto}
          </span>
        ))}
      </div>
    </div>
  );
}

function Convite({ texto, contas }: { texto: string; contas: boolean }) {
  return (
    <div className="gl-vazio">
      <p>{texto}</p>
      {contas && (
        <Link className="btn btn--sm" href="/contas">
          <Icone nome="plug" pequeno />
          Abrir Contas conectadas
        </Link>
      )}
    </div>
  );
}

function Parte({ id, titulo, icone, parte }: { id: string; titulo: string; icone: 'map-pin' | 'search'; parte: ParteDoGoogle }) {
  if (parte.tipo === 'fora') return null;
  return (
    <section className="gl-parte" aria-labelledby={id}>
      <h3 id={id}>
        <Icone nome={icone} />
        {titulo}
      </h3>
      {parte.tipo === 'convite' && <Convite texto={parte.texto} contas={parte.contas} />}
      {parte.tipo === 'aviso' && (
        <div className="gl-vazio">
          <p>
            <b>{parte.destaque}</b> {parte.texto}
          </p>
        </div>
      )}
      {parte.tipo === 'perfil' && (
        <>
          {parte.ate && <p className="gl-sub">{parte.ate}</p>}
          <p className="gl-num">
            <b>{parte.total}</b>vezes que o perfil apareceu
          </p>
          {parte.variacao && <VariacaoNaTela variacao={parte.variacao} />}
          <BarraDividida barra={parte.barra} />
          <p className="gl-sub">E as pessoas fizeram:</p>
          <ul className="gl-acoes">
            {parte.acoes.map((a) => (
              <li key={a.rotulo}>
                <b>{a.valor}</b>
                {a.rotulo}
              </li>
            ))}
          </ul>
        </>
      )}
      {parte.tipo === 'site' && (
        <>
          {parte.ate && <p className="gl-sub">{parte.ate}</p>}
          <p className="gl-num">
            <b>{parte.cliques}</b>cliques vindos das buscas
          </p>
          {parte.variacao && <VariacaoNaTela variacao={parte.variacao} />}
          <p className="gl-sub">
            <TextoRico frase={parte.sub} />
          </p>
          {parte.dias && <CliquesPorDia dias={parte.dias} />}
        </>
      )}
    </section>
  );
}

type Vista = {
  cartao: Exclude<CartaoDoGoogle, { tipo: 'desligado' }>;
  pro: boolean;
  /** "Ver as N buscas" aberto no modo simples. */
  aberto: boolean;
  aoAlternar: () => void;
  recarregando?: boolean;
};

/** O cartão desenhado a partir das regras (separado da busca para ser desenhado igual no teste e no navegador). */
export function VistaDoGoogle({ cartao, pro, aberto, aoAlternar, recarregando = false }: Vista) {
  const { buscas } = cartao;
  const mostraTudo = pro || aberto;
  const total = buscas?.lista.length ?? 0;
  const duas = cartao.perfil.tipo !== 'fora' && cartao.site.tipo !== 'fora';
  return (
    <article className={recarregando ? 'card recarregando' : 'card'} id="card-google" aria-labelledby="t-google" aria-busy={recarregando}>
      <div className="card-cab">
        <div>
          <h2 id="t-google">{TITULO}</h2>
          <p className="card-sub">{cartao.sub}</p>
        </div>
      </div>
      <div className={duas ? 'gl-grade' : 'gl-grade gl-grade--uma'}>
        <Parte id="t-gl-perfil" titulo="No seu perfil do Google" icone="map-pin" parte={cartao.perfil} />
        <Parte id="t-gl-site" titulo="No seu site" icone="search" parte={cartao.site} />
      </div>
      {buscas && (
        <section className="gl-buscas" aria-labelledby="t-gl-buscas">
          <h3 id="t-gl-buscas">
            <Icone nome="search" />O que as pessoas buscaram
          </h3>
          <p className="gl-sub">As buscas que mais trouxeram cliques ao site na semana {buscas.semana}.</p>
          {buscas.vazia ? (
            <p className="gl-sub">Nenhuma busca trouxe cliques ao site nesta semana.</p>
          ) : (
            <>
              {/* O alvo do "Ver as N buscas" existe sempre (V107); no simples fechado, a lista curta fica no lugar. */}
              {!mostraTudo && (
                <ul className="funil gl-funil">
                  {buscas.lista.slice(0, BUSCAS_NO_SIMPLES).map((b) => (
                    <LinhaDaBusca key={b.busca} b={b} completa={false} />
                  ))}
                </ul>
              )}
              <ul className="funil gl-funil" id="google-buscas" hidden={!mostraTudo}>
                {buscas.lista.map((b) => (
                  <LinhaDaBusca key={b.busca} b={b} completa />
                ))}
              </ul>
              {buscas.poucas && <p className="gl-sub">{buscas.poucas}</p>}
              <p className="eixo-nota">A busca feita por poucas pessoas o Google não mostra: ela só entra nos cliques do site, e por isso a soma das buscas fica abaixo do total.</p>
            </>
          )}
        </section>
      )}
      {!pro && total > BUSCAS_NO_SIMPLES && (
        <BotaoDetalhes aberto={aberto} controla="google-buscas" aoAlternar={aoAlternar} rotulos={[`Ver as ${total} buscas`, 'Ver só as 5 primeiras']} />
      )}
    </article>
  );
}

function LinhaDaBusca({ b, completa }: { b: BuscaNaTela; completa: boolean }) {
  return (
    <li>
      <span className="gl-busca">“{b.busca}”</span>
      <div className="funil-trilho" role="img" aria-label={b.rotulo}>
        <span style={{ width: `${b.largura}%` }} />
      </div>
      <span className="funil-txt">
        <TextoRico frase={completa ? b.completa : b.curta} />
      </span>
    </li>
  );
}
