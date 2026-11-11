'use client';

import type { BrandResponse, CommentsResponse, SocialComment } from '@liame/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { haQuanto } from '@/components/avaliacoes/textos';
import { Canal } from '@/components/aprovacoes/detalhe-comentario';
import { ROTULO_DO_TIPO } from '@/components/aprovacoes/comentario-textos';
import { Estado } from '@/components/ui/estado';
import { Faixa } from '@/components/ui/faixa';
import { Icone } from '@/components/ui/icone';
import { useAgora } from '@/lib/agora';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { useSessao } from '@/lib/sessao';
import { autorDoComentario, avisosDasContas, FILTROS, type Filtro, legendaDoPost, lerAgora, lidoHa, pedidoDoComentario, ROTULO_DA_SITUACAO, vazioDoFiltro } from './textos';

// "Comentários" (mockups/prototipo-comentarios.html, P38 aprovado em 07/11/2026; A6, Z11, parte 3b): os comentários
// dos posts da marca no Instagram e na Página, como o Liame os guardou (`GET /v1/comments`), com as situações que
// filtram (e quantos há em cada uma), o canal, a busca e o "Ler agora". O que tem pedido em Aprovações leva até ele: é
// lá que se decide, com o código do app. Escrever a resposta e pedir outra sugestão chegam na parte 3c.

type Carga = { tipo: 'carregando' } | { tipo: 'ok'; dados: CommentsResponse } | { tipo: 'erro'; problema: Problema };

export function ComentariosTela() {
  const { pode } = useSessao();
  const podeVer = pode('campanhas.ver');
  const podeVerContas = pode('contas.ver');
  const titulo = useRef<HTMLHeadingElement>(null);
  const [marcas, setMarcas] = useState<BrandResponse[] | null>(null);
  const [erroMarcas, setErroMarcas] = useState<Problema | null>(null);
  const [marca, setMarca] = useState<string | null>(null);
  const [filtro, setFiltro] = useState<Filtro>('pedem');
  const [canal, setCanal] = useState<'' | 'instagram' | 'facebook'>('');
  const [busca, setBusca] = useState('');
  const [buscando, setBuscando] = useState('');
  const [carga, setCarga] = useState<Carga>({ tipo: 'carregando' });
  const [tentativa, setTentativa] = useState(0);
  const [lendo, setLendo] = useState<'nao' | 'pedindo' | 'pedido'>('nao');
  const [erroLer, setErroLer] = useState<string | null>(null);
  // Só a resposta mais nova vale (trocar de marca ou de filtro no meio de uma leitura não mistura as listas).
  const seq = useRef(0);
  const agora = useAgora(60_000, null);

  const carregarMarcas = useCallback(async () => {
    setErroMarcas(null);
    const r = await chamar(() => api.GET('/v1/brands'));
    if (!r.ok) return setErroMarcas(r.problema);
    const ativas = r.data.items.filter((b) => !b.archived_at);
    setMarcas(ativas);
    setMarca((m) => (m && ativas.some((b) => b.id === m) ? m : (ativas[0]?.id ?? null)));
  }, []);

  useEffect(() => {
    if (podeVer) disparar(carregarMarcas());
  }, [podeVer, carregarMarcas]);

  // A busca vai ao servidor um instante depois de a pessoa parar de digitar.
  useEffect(() => {
    const t = setTimeout(() => setBuscando(busca.trim()), 350);
    return () => clearTimeout(t);
  }, [busca]);

  useEffect(() => {
    if (!marca) return;
    const id = ++seq.current;
    setCarga((c) => (c.tipo === 'ok' ? c : { tipo: 'carregando' }));
    const query = { brand_id: marca, filter: filtro, ...(canal ? { channel: canal } : {}), ...(buscando ? { q: buscando } : {}) };
    disparar(
      chamar(() => api.GET('/v1/comments', { params: { query } })).then((r) => {
        if (id !== seq.current) return;
        setCarga(r.ok ? { tipo: 'ok', dados: r.data } : { tipo: 'erro', problema: r.problema });
      }),
    );
  }, [marca, filtro, canal, buscando, tentativa]);

  async function pedirLeitura() {
    if (!marca) return;
    setLendo('pedindo');
    setErroLer(null);
    const r = await chamar(() => api.POST('/v1/comments/refresh', { body: { brand_id: marca } }));
    if (!r.ok) {
      setLendo('nao');
      return setErroLer(mensagemDe(r.problema));
    }
    setLendo('pedido');
    // A leitura leva alguns segundos no worker: a lista é lida de novo logo depois.
    setTimeout(() => setTentativa((t) => t + 1), 8_000);
  }

  if (!podeVer) {
    return (
      <Estado icone="lock" titulo="Esta tela é de quem acompanha as campanhas">
        O seu nível nesta empresa não mostra os comentários. Se precisar, peça ao dono da conta.
      </Estado>
    );
  }

  const problema = erroMarcas ?? (carga.tipo === 'erro' ? carga.problema : null);
  const dados = carga.tipo === 'ok' ? carga.dados : null;
  let corpo;
  if (problema) {
    corpo = (
      <div className="card">
        <Estado
          icone="alert-circle"
          perigo
          titulo="Não foi possível carregar os comentários"
          acao={
            <div className="vazio-acoes">
              <button
                className="btn btn--primary"
                type="button"
                onClick={() => {
                  disparar(carregarMarcas());
                  setTentativa((t) => t + 1);
                }}
              >
                <Icone nome="refresh" pequeno />
                Tentar de novo
              </button>
            </div>
          }
        >
          {mensagemDe(problema)} Nada foi perdido.
        </Estado>
      </div>
    );
  } else if (marcas && !marcas.length) {
    corpo = (
      <div className="card">
        <Estado icone="info" titulo="Nenhuma marca ativa nesta empresa">
          Os comentários são lidos por marca: quando a empresa tiver uma marca ativa, eles aparecem aqui.
        </Estado>
      </div>
    );
  } else if (!dados) {
    corpo = (
      <div className="av" aria-busy="true">
        <p className="sr-only">Carregando os comentários…</p>
        <div className="card res-esqueleto" aria-hidden="true">
          <span className="esqueleto esqueleto--medio" />
          <span className="esqueleto esqueleto--medio" />
          <span className="esqueleto esqueleto--medio" />
        </div>
      </div>
    );
  } else if (dados.state === 'desligada') {
    corpo = (
      <div className="card">
        <Estado icone="message" titulo="Os comentários ainda não estão ligados para esta empresa">
          Quando a leitura dos comentários for ligada, os comentários dos posts do Instagram e da Página aparecem aqui, com o que pede resposta primeiro.
        </Estado>
      </div>
    );
  } else if (dados.state === 'sem_conta') {
    corpo = (
      <div className="card">
        <Estado
          icone="plug"
          titulo="Nenhuma conta da rede ligada a esta marca"
          acao={
            podeVerContas ? (
              <div className="vazio-acoes">
                <Link className="btn btn--primary" href="/contas">
                  Abrir Contas conectadas
                </Link>
              </div>
            ) : undefined
          }
        >
          Para ler os comentários, ligue o Instagram ou a Página do Facebook da marca em Contas conectadas.
        </Estado>
      </div>
    );
  } else {
    const avisos = avisosDasContas(dados.accounts);
    const vazio = vazioDoFiltro(filtro, buscando);
    const comAs2Redes = new Set(dados.accounts.map((a) => a.channel)).size > 1;
    corpo = (
      <div className="av com">
        {avisos.map((a) => (
          <Faixa
            key={a.conta}
            tipo={a.tom === 'perigo' ? 'perigo' : a.tom === 'aviso' ? 'atencao' : undefined}
            icone={<Icone nome={a.tom === 'info' ? 'clock' : 'alert'} />}
            titulo={a.conta}
            texto={a.texto}
            acao={
              a.contas && podeVerContas ? (
                <Link className="btn btn--sm" href="/contas">
                  Contas conectadas
                </Link>
              ) : undefined
            }
          />
        ))}
        <article className="card" id="com-lista" aria-labelledby="t-com-lista">
          <div className="card-cab">
            <div>
              <h2 className="card-tit" id="t-com-lista">
                Os comentários dos posts
              </h2>
              <p className="card-sub">Os dos últimos 30 dias, com o que pede resposta primeiro, do mais antigo para o mais novo.</p>
            </div>
          </div>
          <div className="filtros" role="group" aria-label="Filtrar os comentários">
            {FILTROS.map(([id, rotulo]) => (
              <button key={id} className="chip" type="button" id={`com-filtro-${id}`} aria-pressed={filtro === id} onClick={() => setFiltro(id)}>
                {rotulo}
                <span className="num">{dados.counts[id]}</span>
              </button>
            ))}
          </div>
          <div className="com-busca">
            <label className="res-campo">
              <span>Buscar</span>
              <input className="input" id="com-busca" type="search" value={busca} placeholder="No texto ou em quem comentou" onChange={(e) => setBusca(e.target.value)} />
            </label>
            {comAs2Redes && (
              <label className="res-campo">
                <span>Canal</span>
                <select className="input" id="com-canal" value={canal} onChange={(e) => setCanal(e.target.value as '' | 'instagram' | 'facebook')}>
                  <option value="">Instagram e Facebook</option>
                  <option value="instagram">Instagram</option>
                  <option value="facebook">Facebook</option>
                </select>
              </label>
            )}
          </div>
          {dados.items.length ? (
            <ul className="av-lista" aria-label="Comentários dos posts">
              {dados.items.map((c) => (
                <ItemDoComentario key={`${c.account_id}:${c.id}`} c={c} legenda={legendaDoPost(dados.posts, c)} agora={agora} />
              ))}
            </ul>
          ) : (
            <Estado icone="message" titulo={vazio.titulo} compacto>
              {vazio.texto}
            </Estado>
          )}
        </article>
      </div>
    );
  }

  const lido = dados && dados.state === 'pronta' ? lidoHa(dados.accounts, agora) : null;
  const ler = dados && dados.state === 'pronta' ? lerAgora(dados.refresh) : null;

  return (
    <section aria-labelledby="h-comentarios">
      <div className="view-cab anima" style={{ ['--i' as string]: 0 }}>
        <div>
          <h1 id="h-comentarios" ref={titulo} tabIndex={-1}>
            Comentários
          </h1>
          <p>Os comentários dos posts da sua marca no Instagram e na Página do Facebook, com o que pede resposta primeiro.</p>
        </div>
        {ler && (
          <div className="com-leitura">
            {lido && (
              <span className="lite-chip" id="com-lido">
                {lido}
              </span>
            )}
            <button className="btn btn--sm" type="button" id="com-ler" disabled={!ler.pode || lendo === 'pedindo'} aria-busy={lendo === 'pedindo'} onClick={() => disparar(pedirLeitura())}>
              <Icone nome="refresh" pequeno />
              {lendo === 'pedindo' ? 'Pedindo…' : 'Ler agora'}
            </button>
          </div>
        )}
      </div>
      {ler && !ler.pode && ler.dica && <p className="eixo-nota">{ler.dica}</p>}
      {lendo === 'pedido' && (
        <p className="eixo-nota" role="status">
          O Liame está lendo os comentários de novo. A lista se atualiza em alguns segundos.
        </p>
      )}
      {erroLer && (
        <p className="campo-erro" role="alert">
          {erroLer}
        </p>
      )}
      {marcas && marcas.length > 1 && (
        <div className="av-filtros">
          <label className="res-campo">
            <span>Marca</span>
            <select className="input" id="com-marca" value={marca ?? ''} onChange={(e) => setMarca(e.target.value)}>
              {marcas.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {corpo}
    </section>
  );
}

/** Uma linha da lista: o canal, quem comentou e quando, o tipo, a situação, o texto, o post e as respostas na rede. */
function ItemDoComentario({ c, legenda, agora }: { c: SocialComment; legenda: string | null; agora: Date }) {
  const autor = autorDoComentario(c);
  const situacao = ROTULO_DA_SITUACAO[c.situation] ?? { rotulo: c.situation, classe: 'neutro' as const };
  const pedido = pedidoDoComentario(c);
  return (
    <li className="av-item">
      <div>
        <div className="av-item-cab">
          <Canal canal={c.channel} />
          <span>{[autor, haQuanto(c.published_at, agora)].filter(Boolean).join(' · ')}</span>
          {c.kind && ROTULO_DO_TIPO[c.kind] && <span className={`co-tipo co-tipo--${c.kind === 'ofensivo' ? 'golpe' : c.kind}`}>{ROTULO_DO_TIPO[c.kind]}</span>}
        </div>
        <p className="av-item-txt">{c.message}</p>
        {legenda && <p className="com-post">No post: “{legenda}”</p>}
        {c.replies.length > 0 && (
          <ul className="com-respostas" aria-label="Respostas na rede">
            {c.replies.map((r) => (
              <li key={r.id}>
                <b>{r.by_brand ? 'A marca' : (r.author ?? 'Alguém')}</b>: {r.message}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="av-item-acao">
        <span className={`st st--${situacao.classe}`}>
          <span className="dot" aria-hidden="true" />
          {situacao.rotulo}
        </span>
        {pedido && (
          <Link className="btn btn--sm btn--primary" href={pedido.href}>
            {pedido.rotulo}
          </Link>
        )}
      </div>
    </li>
  );
}
