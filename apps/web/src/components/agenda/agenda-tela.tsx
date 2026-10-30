'use client';

import type { BrandPhoto, BrandResponse, PostListResponse, PostResponse } from '@liame/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Estado } from '@/components/ui/estado';
import { useAvisar } from '@/components/ui/avisos';
import { Icone } from '@/components/ui/icone';
import { useAgora } from '@/lib/agora';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { useSessao } from '@/lib/sessao';
import { GavetaNovoPost } from './gaveta-novo-post';
import { GavetaPacote } from './gaveta-pacote';
import { GavetaPost } from './gaveta-post';
import { avisoDoNovo, type DiaDaAgenda, ehPacote, inicioDaSemana, noFuso, periodo, somaDias, telaDaAgenda } from './textos';

// A Agenda (mockups/prototipo-post.html, P19 aprovado em 21/10/2026; Z5c da A6): os posts da marca na semana, de
// segunda a domingo, no fuso da empresa (`GET /v1/posts`, de quem acompanha as campanhas). Cada post abre a gaveta dele.
// A miniatura de cada post vem das Fotos (`GET /v1/brand-photos`, com endereços de 5 minutos): sem elas, o cartão fica
// sem a imagem e o resto segue. O pacote pronto (mockups/prototipo-pacote.html, P22; Z8): o cartão com a borda
// pontilhada ("Você publica") e a gaveta dos quatro passos. Sem conta conectada, a semana segue, com o aviso: o pacote
// não precisa de conta (D-A6-44).

type Carga = { tipo: 'carregando' } | { tipo: 'ok'; dados: PostListResponse; semana: string } | { tipo: 'erro'; problema: Problema };

/** O fuso do navegador, só para a primeira semana (o da empresa chega com a primeira leitura). */
const fusoDoNavegador = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Sao_Paulo';

export function AgendaTela() {
  const { pode } = useSessao();
  const podeVer = pode('campanhas.ver');
  const podeOperar = pode('campanhas.operar');
  const podeVerContas = pode('contas.ver');
  const podeAprovar = pode('acoes.aprovar');
  const podeVerFotos = pode('fotos.ver');
  const titulo = useRef<HTMLHeadingElement>(null);
  const seguinte = useRef<HTMLButtonElement>(null);
  const [marcas, setMarcas] = useState<BrandResponse[] | null>(null);
  const [erroMarcas, setErroMarcas] = useState<Problema | null>(null);
  const [marca, setMarca] = useState<string | null>(null);
  const [semana, setSemana] = useState<string>(() => inicioDaSemana(noFuso(new Date(), fusoDoNavegador()).dia));
  /** A pessoa já mudou de semana: a semana do fuso da empresa não passa por cima da escolha dela. */
  const navegou = useRef(false);
  const [carga, setCarga] = useState<Carga>({ tipo: 'carregando' });
  const [fotos, setFotos] = useState<Map<string, BrandPhoto>>(new Map());
  /** As fotos para o novo post (a mais nova primeiro); nula quando as Fotos não estão ligadas ou não abriram. */
  const [fotosLista, setFotosLista] = useState<BrandPhoto[] | null>(null);
  const [aberto, setAberto] = useState<string | null>(null);
  const [novoAberto, setNovoAberto] = useState(false);
  /** O post que acabou de ser mandado: o foco vai para o cartão dele quando a semana chega. */
  const focarPost = useRef<string | null>(null);
  const avisar = useAvisar();
  const [buscando, setBuscando] = useState(false);
  const [tentativa, setTentativa] = useState(0);
  const focarTitulo = useRef(false);
  // Só a resposta mais nova vale (trocar de semana ou de marca no meio de uma leitura não mistura os posts).
  const seq = useRef(0);
  const seqFotos = useRef(0);
  const agora = useAgora(60_000, carga.tipo === 'ok' ? carga.dados : null);
  const fuso = carga.tipo === 'ok' ? carga.dados.timezone : fusoDoNavegador();
  const hoje = noFuso(agora, fuso).dia;

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

  const carregarFotos = useCallback(async (brand: string) => {
    if (!podeVerFotos) return;
    const id = ++seqFotos.current;
    const r = await chamar(() => api.GET('/v1/brand-photos', { params: { query: { brand_id: brand } } }));
    if (id !== seqFotos.current) return;
    // Sem as Fotos (desligadas ou fora do ar), os cartões ficam sem a miniatura e o novo post diz por quê; a Agenda segue.
    setFotos(r.ok ? new Map(r.data.items.map((f) => [f.id, f])) : new Map());
    setFotosLista(r.ok && r.data.enabled ? r.data.items : null);
  }, [podeVerFotos]);

  useEffect(() => {
    if (!marca) return;
    const id = ++seq.current;
    // Trocar de semana mantém a semana de antes na tela (e os botões, com o foco) até a nova chegar.
    setCarga((c) => (c.tipo === 'ok' && c.dados.items.every((p) => p.brand_id === marca) ? c : { tipo: 'carregando' }));
    setBuscando(true);
    disparar(
      chamar(() => api.GET('/v1/posts', { params: { query: { brand_id: marca, from: semana, to: somaDias(semana, 6) } } })).then((r) => {
        if (id !== seq.current) return;
        setBuscando(false);
        if (!r.ok) return setCarga({ tipo: 'erro', problema: r.problema });
        // A primeira semana veio do fuso do navegador: a da empresa vale, se a pessoa ainda não navegou.
        const daEmpresa = inicioDaSemana(noFuso(new Date(), r.data.timezone).dia);
        if (!navegou.current && daEmpresa !== semana) {
          navegou.current = true;
          setSemana(daEmpresa);
          return;
        }
        setCarga({ tipo: 'ok', dados: r.data, semana });
      }),
    );
  }, [marca, semana, tentativa]);

  useEffect(() => {
    if (marca) disparar(carregarFotos(marca));
  }, [marca, carregarFotos]);

  useEffect(() => {
    if (!focarTitulo.current || carga.tipo === 'carregando') return;
    focarTitulo.current = false;
    titulo.current?.focus({ preventScroll: true });
  }, [carga]);

  // O post recém-mandado: quando a semana dele chega, o foco vai para o cartão (quem usa o teclado continua dali).
  useEffect(() => {
    const id = focarPost.current;
    if (!id || carga.tipo !== 'ok' || !carga.dados.items.some((p) => p.id === id)) return;
    focarPost.current = null;
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-post="${id}"]`)?.focus());
  }, [carga]);

  const tela = useMemo(() => (carga.tipo === 'ok' ? telaDaAgenda(carga.dados, carga.semana, hoje) : null), [carga, hoje]);
  const postAberto = carga.tipo === 'ok' && aberto ? (carga.dados.items.find((p) => p.id === aberto) ?? null) : null;

  if (!podeVer) {
    return (
      <Estado icone="lock" titulo="Esta tela é de quem acompanha as campanhas">
        O seu nível nesta empresa não mostra a Agenda. Se precisar, peça ao dono da conta.
      </Estado>
    );
  }

  function irPara(n: number) {
    navegou.current = true;
    setSemana((s) => (n === 0 ? inicioDaSemana(hoje) : somaDias(s, n)));
    // "Esta semana" some na semana de hoje: o foco vai para o botão da semana seguinte, em vez de cair no corpo.
    if (n === 0) requestAnimationFrame(() => seguinte.current?.focus());
  }

  function tentarDeNovo() {
    focarTitulo.current = true;
    disparar(carregarMarcas());
    setTentativa((t) => t + 1);
  }

  function trocarPost(post: PostResponse) {
    setCarga((c) => (c.tipo === 'ok' ? { ...c, dados: { ...c.dados, items: c.dados.items.map((p) => (p.id === post.id ? post : p)) } } : c));
  }

  /**
   * O post mandado para aprovação (ou o pacote que ficou pronto): a Agenda vai para a semana dele, lê de novo (o pacote
   * de cada rede aparece junto) e avisa o que aconteceu.
   */
  function mandou(post: PostResponse, canais: string[]) {
    const { dia } = noFuso(new Date(post.publish_at), fuso);
    navegou.current = true;
    focarPost.current = post.id;
    setSemana(inicioDaSemana(dia));
    setTentativa((t) => t + 1);
    avisar(avisoDoNovo(post, canais, fuso, hoje));
  }

  /** O pacote tirado da Agenda: o cartão sai (o cancelado não vai à semana) e a tela avisa. */
  function tirou(post: PostResponse) {
    trocarPost(post);
    avisar('Pacote tirado da Agenda. Nada foi publicado pelo Liame.');
  }

  const problema = erroMarcas ?? (carga.tipo === 'erro' ? carga.problema : null);
  const naSemanaDeHoje = semana === inicioDaSemana(hoje);
  let corpo;
  if (problema) {
    corpo = (
      <div className="faixa faixa--perigo" role="alert">
        <span className="faixa-ic">
          <Icone nome="alert-circle" />
        </span>
        <span className="faixa-txt">
          <b>Não deu para carregar a Agenda</b>
          <span>{mensagemDe(problema)} Os posts aprovados continuam marcados e saem na hora.</span>
        </span>
        <button className="btn btn--sm" type="button" onClick={tentarDeNovo}>
          <Icone nome="refresh" pequeno />
          Tentar de novo
        </button>
      </div>
    );
  } else if (marcas && !marcas.length) {
    corpo = (
      <div className="card">
        <Estado icone="info" titulo="Nenhuma marca ativa nesta empresa">
          Os posts são de cada marca: quando a empresa tiver uma marca ativa, a Agenda dela aparece aqui.
        </Estado>
      </div>
    );
  } else if (!tela) {
    corpo = (
      <div aria-busy="true">
        <p className="sr-only">Carregando a Agenda</p>
        <div className="ag-esq" aria-hidden="true">
          {Array.from({ length: 7 }, (_, i) => (
            <span key={i} className="esqueleto" />
          ))}
        </div>
      </div>
    );
  } else if (tela.tipo === 'desligada') {
    corpo = (
      <div className="card">
        <Estado icone="calendar" titulo="Os posts ainda não estão ligados para esta empresa">
          Quem liga é a Liame, a pedido do dono. Com a função desligada, nenhum post é publicado.
        </Estado>
      </div>
    );
  } else {
    corpo = (
      <>
        {tela.semConta ? (
          <p className="po-nota ag-falta">
            <Icone nome="plug" pequeno />
            <span>
              O Instagram e a Página do Facebook não estão conectados a esta marca: o Liame não publica por enquanto. O pacote pronto do TikTok e do YouTube, que você publica, segue igual.
            </span>
            {podeVerContas && (
              <Link className="btn btn--sm" href="/contas">
                <Icone nome="plug" pequeno />
                Abrir Contas conectadas
              </Link>
            )}
          </p>
        ) : (
          tela.faltam.length > 0 && (
            <p className="po-nota ag-falta">
              <Icone nome="info" pequeno />
              <span>
                {tela.faltam.join(' e ')} não {tela.faltam.length > 1 ? 'estão conectados' : 'está conectada'} a esta marca: os posts saem só nos outros canais.
                {podeVerContas ? ' Para ligar, abra Contas conectadas.' : ''}
              </span>
            </p>
          )
        )}
        <div className="ag-semana" aria-busy={buscando || undefined}>
          {tela.dias.map((d) => (
            <Dia key={d.iso} dia={d} fotos={fotos} aoAbrir={setAberto} />
          ))}
        </div>
        <p className="ag-legenda" aria-hidden="true">
          <span>
            <Icone nome="check-circle" pequeno />
            publicado
          </span>
          <span>
            <Icone nome="clock" pequeno />
            agendado: aprovado, sai na hora
          </span>
          <span>
            <Icone nome="alert" pequeno />
            espera a aprovação
          </span>
          <span>
            <Icone nome="send" pequeno />
            você publica: o pacote pronto
          </span>
        </p>
      </>
    );
  }

  const mostraNavegacao = tela && tela.tipo === 'semana';

  return (
    <section aria-labelledby="h-agenda">
      <div className="view-cab anima" style={{ ['--i' as string]: 0 }}>
        <div>
          <h1 id="h-agenda" ref={titulo} tabIndex={-1}>
            Agenda
          </h1>
          <p>Os posts da marca na semana: o que saiu, o que está marcado, o que espera a aprovação e o pacote que você publica.</p>
        </div>
        {mostraNavegacao && (
          <div className="ag-acoes">
            <div className="ag-semana-nav" role="group" aria-label="Semana">
              <button className="btn btn--icon btn--sm" type="button" onClick={() => irPara(-7)} aria-label="Semana anterior">
                <Icone nome="chevron-left" />
              </button>
              <span className="ag-periodo" aria-live="polite">
                {periodo(semana)}
              </span>
              <button className="btn btn--icon btn--sm" type="button" ref={seguinte} onClick={() => irPara(7)} aria-label="Semana seguinte">
                <Icone nome="chevron-right" />
              </button>
              {!naSemanaDeHoje && (
                <button className="btn btn--sm" type="button" onClick={() => irPara(0)}>
                  Esta semana
                </button>
              )}
            </div>
            {podeOperar && (
              <button className="btn btn--primary" type="button" aria-haspopup="dialog" aria-expanded={novoAberto} onClick={() => setNovoAberto(true)}>
                <Icone nome="plus" />
                Novo post
              </button>
            )}
          </div>
        )}
      </div>
      {marcas && marcas.length > 1 && (
        <div className="av-filtros">
          <label className="res-campo">
            <span>Marca</span>
            <select className="input" id="ag-marca" value={marca ?? ''} onChange={(e) => setMarca(e.target.value)}>
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
      {postAberto && carga.tipo === 'ok' && ehPacote(postAberto) && (
        <GavetaPacote
          key={`pacote-${postAberto.id}`}
          post={postAberto}
          fuso={carga.dados.timezone}
          hoje={hoje}
          foto={postAberto.photo_id ? (fotos.get(postAberto.photo_id) ?? null) : null}
          podeOperar={podeOperar}
          reserva={titulo}
          aoMudar={trocarPost}
          aoTirar={tirou}
          aoFalharImagem={() => marca && disparar(carregarFotos(marca))}
          aoFechar={() => setAberto(null)}
        />
      )}
      {postAberto && carga.tipo === 'ok' && !ehPacote(postAberto) && (
        <GavetaPost
          key={`gaveta-${postAberto.id}`}
          post={postAberto}
          fuso={carga.dados.timezone}
          hoje={hoje}
          foto={postAberto.photo_id ? (fotos.get(postAberto.photo_id) ?? null) : null}
          podeOperar={podeOperar}
          podeAprovar={podeAprovar}
          podeVerContas={podeVerContas}
          reserva={titulo}
          aoMudar={trocarPost}
          aoFalharImagem={() => marca && disparar(carregarFotos(marca))}
          aoFechar={() => setAberto(null)}
        />
      )}
      {novoAberto && carga.tipo === 'ok' && marca && (
        <GavetaNovoPost
          marca={marca}
          fotos={fotosLista}
          canais={carga.dados.channels}
          postLink={carga.dados.post_link}
          fuso={carga.dados.timezone}
          hoje={hoje}
          podeVerContas={podeVerContas}
          podeVerFotos={podeVerFotos}
          reserva={titulo}
          aoMandar={mandou}
          aoFechar={() => setNovoAberto(false)}
        />
      )}
    </section>
  );
}

function Dia({ dia, fotos, aoAbrir }: { dia: DiaDaAgenda; fotos: Map<string, BrandPhoto>; aoAbrir: (id: string) => void }) {
  const idTitulo = `ag-d-${dia.iso}`;
  return (
    <section className={`ag-dia${dia.hoje ? ' ag-dia--hoje' : ''}${dia.passado ? ' ag-dia--passado' : ''}`} aria-labelledby={idTitulo}>
      <div className="ag-dia-cab">
        <h2 id={idTitulo}>
          <span>{dia.curto}</span> <span className="num">{dia.num}</span>
          <span className="sr-only">/{dia.iso.slice(5, 7)}</span>
        </h2>
        {dia.hoje && <span className="ag-hoje">hoje</span>}
      </div>
      {dia.posts.length > 0 ? (
        <ul className="ag-itens" aria-label={`Posts de ${dia.longo}`}>
          {dia.posts.map((p) => {
            const foto = p.post.photo_id ? fotos.get(p.post.photo_id) : undefined;
            const tom = p.situacao.tom;
            return (
              <li key={p.post.id}>
                <button
                  className={`ag-post${ehPacote(p.post) ? ' ag-post--pacote' : p.post.status === 'esperando_aprovacao' ? ' ag-post--espera' : tom === 'falha' ? ' ag-post--falha' : ''}`}
                  type="button"
                  aria-haspopup="dialog"
                  aria-label={p.rotulo}
                  data-post={p.post.id}
                  onClick={() => aoAbrir(p.post.id)}
                >
                  <span className="ag-mini" aria-hidden="true">
                    {foto ? <img src={foto.thumbnail_url} alt="" referrerPolicy="no-referrer" /> : <Icone nome="image" />}
                  </span>
                  <span className="ag-post-txt">
                    <b>{p.hora}</b>
                    <span className="ag-canais">{p.canais}</span>
                  </span>
                  <span className={`ag-st${tom ? ` ag-st--${tom}` : ''}`}>
                    <Icone nome={p.situacao.icone} pequeno />
                    {p.situacao.rotulo}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="ag-vazio-dia">{dia.passado ? 'Nada saiu.' : 'Nada marcado.'}</p>
      )}
    </section>
  );
}
