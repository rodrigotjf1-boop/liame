'use client';

import type { BrandResponse, CommentsResponse, SocialComment } from '@liame/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { haQuanto } from '@/components/avaliacoes/textos';
import { ROTULO_DO_TIPO, TAMANHO_DA_RESPOSTA_AO_COMENTARIO, textoDoComentarioValido } from '@/components/aprovacoes/comentario-textos';
import { Canal, DICA_DO_COMENTARIO } from '@/components/aprovacoes/detalhe-comentario';
import { FormularioDoTexto } from '@/components/aprovacoes/detalhe-resposta';
import { ConfirmaNaLinha } from '@/components/ui/confirma-na-linha';
import { Estado } from '@/components/ui/estado';
import { Faixa } from '@/components/ui/faixa';
import { Icone } from '@/components/ui/icone';
import { useAgora } from '@/lib/agora';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { useSessao } from '@/lib/sessao';
import { autorDoComentario, avisosDasContas, erroDoPedido, FILTROS, type Filtro, legendaDoPost, lerAgora, lidoHa, pedidoDoComentario, ROTULO_DA_SITUACAO, vazioDoFiltro } from './textos';

// "Comentários" (mockups/prototipo-comentarios.html, P38 aprovado em 07/11/2026; A6, Z11, parte 3b): os comentários
// dos posts da marca no Instagram e na Página, como o Liame os guardou (`GET /v1/comments`), com as situações que
// filtram (e quantos há em cada uma), o canal, a busca e o "Ler agora". O que tem pedido em Aprovações leva até ele: é
// lá que se decide, com o código do app. Escrever a resposta e pedir outra sugestão chegam na parte 3c.

type Carga = { tipo: 'carregando' } | { tipo: 'ok'; dados: CommentsResponse } | { tipo: 'erro'; problema: Problema };

export function ComentariosTela() {
  const { pode } = useSessao();
  const router = useRouter();
  const podeVer = pode('campanhas.ver');
  const podeVerContas = pode('contas.ver');
  // Responder, ocultar e mostrar de novo é pedir uma ação: só para quem pode pedir (o servidor confere; a tela só não oferece).
  const podePedir = pode('campanhas.operar');
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

  // O pedido de uma pessoa (A6, Z11, parte 3c): responder com o texto dela, ocultar ou mostrar de novo. Ele nasce em
  // Aprovações, e a pessoa vai para lá: a decisão é com o código do app, como a de todo pedido.
  const pedir: Pedir = async (c, ferramenta, params) => {
    const r = await chamar(() =>
      api.POST('/v1/actions', {
        body: { tool: ferramenta, brand_id: marca, provider: c.channel === 'facebook' ? 'facebook_page' : 'instagram', account_id: c.account_id, resource_id: `comentario:${c.id}`, params },
      }),
    );
    if (!r.ok) return { ok: false, texto: erroDoPedido(r.problema) };
    router.push(`/aprovacoes?pedido=${r.data.id}`);
    return { ok: true };
  };

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
                <ItemDoComentario key={`${c.account_id}:${c.id}`} c={c} legenda={legendaDoPost(dados.posts, c)} agora={agora} aoPedir={podePedir ? pedir : null} />
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

/** O que a linha pede: responder (com o texto), ocultar ou mostrar de novo; o pedido vai a Aprovações. */
export type Pedir = (c: SocialComment, ferramenta: 'comentario_responder' | 'comentario_ocultar' | 'comentario_mostrar', params: Record<string, unknown>) => Promise<{ ok: true } | { ok: false; texto: string }>;

/** Uma linha da lista: o canal, quem comentou e quando, o tipo, a situação, o texto, o post e as respostas na rede. */
function ItemDoComentario({ c, legenda, agora, aoPedir }: { c: SocialComment; legenda: string | null; agora: Date; aoPedir: Pedir | null }) {
  const autor = autorDoComentario(c);
  const situacao = ROTULO_DA_SITUACAO[c.situation] ?? { rotulo: c.situation, classe: 'neutro' as const };
  const pedido = pedidoDoComentario(c);
  const [aberto, setAberto] = useState<'nao' | 'responder' | 'ocultar' | 'mostrar'>('nao');
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  // Sem pedido em aberto, quem pode pedir responde (o que pede resposta ou não tem), oculta o que está à vista e mostra
  // de novo o oculto. Com pedido, a linha leva a Aprovações.
  const acoes = aoPedir && !pedido;
  const podeResponder = acoes && !c.hidden && (c.situation === 'pede_resposta' || c.situation === 'sem_resposta');
  async function confirmar(ferramenta: 'comentario_ocultar' | 'comentario_mostrar') {
    setOcupado(true);
    setErro(null);
    const r = await aoPedir!(c, ferramenta, {});
    setOcupado(false);
    if (!r.ok) setErro(r.texto);
  }
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
        {aberto === 'responder' && (
          <div className="com-responder">
            <FormularioDoTexto
              ids={`com-${c.id}`}
              inicial=""
              podeCancelar
              dica={DICA_DO_COMENTARIO}
              maximo={TAMANHO_DA_RESPOSTA_AO_COMENTARIO}
              validar={textoDoComentarioValido}
              aoSalvar={(texto) => aoPedir!(c, 'comentario_responder', { texto })}
              aoCancelar={() => setAberto('nao')}
            />
            <p className="eixo-nota">Salvar manda a resposta para Aprovações: ela só sai com a aprovação de quem aprova, com o código do app.</p>
          </div>
        )}
        {(aberto === 'ocultar' || aberto === 'mostrar') && (
          <div className="com-responder">
            <ConfirmaNaLinha
              texto={aberto === 'ocultar' ? 'O pedido de ocultar vai para Aprovações. Os outros deixam de ver o comentário quando ele for aprovado; dá para mostrar de novo.' : 'O pedido de mostrar de novo vai para Aprovações.'}
              rotulo={aberto === 'ocultar' ? 'Pedir para ocultar' : 'Pedir para mostrar'}
              rotuloOcupado="Pedindo…"
              ocupado={ocupado}
              aoConfirmar={() => disparar(confirmar(aberto === 'ocultar' ? 'comentario_ocultar' : 'comentario_mostrar'))}
              aoCancelar={() => {
                setAberto('nao');
                setErro(null);
              }}
            />
            {erro && (
              <p className="campo-erro" role="alert">
                {erro}
              </p>
            )}
          </div>
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
        {acoes && aberto === 'nao' && (
          <div className="com-acoes">
            {podeResponder && (
              <button className="btn btn--sm btn--primary" type="button" data-com-responder onClick={() => setAberto('responder')}>
                <Icone nome="reply" pequeno />
                Responder
              </button>
            )}
            {c.hidden ? (
              <button className="btn btn--sm" type="button" data-com-mostrar onClick={() => setAberto('mostrar')}>
                <Icone nome="eye" pequeno />
                Mostrar de novo
              </button>
            ) : (
              <button className="btn btn--sm" type="button" data-com-ocultar onClick={() => setAberto('ocultar')}>
                <Icone nome="eye-off" pequeno />
                Ocultar
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
