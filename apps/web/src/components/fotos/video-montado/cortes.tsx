'use client';

import type { VideoCutsResponse } from '@liame/contracts';
import { useEffect, useId, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { api, chamar } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { contagem } from './textos';
import { type CorteNaTela, comChave, motivoDosCortesTxt, mover, outrosTxt, quadrosTxt, REGUA_DOS_CORTES, segundosTxt, situacaoDoTotal, tempoTxt } from './momentos';

// Os cortes dos "Melhores momentos" (A6 · Z16; P46): "Pedir os cortes ao Social media" (`POST /v1/video-montages/cuts`),
// a espera relida a cada 3 segundos (o serviço de montagem tira os quadros e o worker pede ao Social media), a proposta
// conferida, que a pessoa tira, troca de ordem e muda as legendas, o total e "Pedir outros cortes" (até 2 vezes). O
// começo e o fim de cada corte são os que o Social media escolheu (nesta versão, D-A6-150).

/** Relê o pedido a cada 3 segundos, até 3 minutos; depois, "Ver de novo". */
const RELER_MS = 3_000;
const RELEITURAS = 60;

export type VideoDoCorte = { id: string; produto: string; capa: string };

type Props = {
  brandId: string;
  /** Os vídeos escolhidos, na ordem (o "Vídeo 1", "Vídeo 2" dos cortes). */
  videos: VideoDoCorte[];
  dur: number;
  cortes: CorteNaTela[];
  /** A pessoa já tocou em "Usar estes". */
  usados: boolean;
  erro?: string;
  errosDasLegendas: Record<string, string>;
  /** A proposta que chegou do Social media (substitui os cortes da tela). */
  aoReceber: (cortes: CorteNaTela[]) => void;
  /** A pessoa tirou, trocou a ordem ou mudou uma legenda. */
  aoMudar: (cortes: CorteNaTela[]) => void;
  aoUsar: () => void;
};

type Fase = null | 'pedindo' | 'lendo' | 'demorou' | { falhou: string };
const emCurso = (s: VideoCutsResponse['status']) => s === 'pedido' || s === 'quadros_prontos' || s === 'lendo';

export function BlocoDosCortes(p: Props) {
  const ids = useId();
  const [pedido, setPedido] = useState<VideoCutsResponse | null>(null);
  const [fase, setFase] = useState<Fase>(null);
  const titulo = useRef<HTMLElement>(null);
  const aoReceber = useRef(p.aoReceber);
  aoReceber.current = p.aoReceber;

  function chegou(r: VideoCutsResponse) {
    setPedido(r);
    if (r.status === 'pronta' && r.cuts) {
      aoReceber.current(comChave(r.cuts, r.id));
      setFase(null);
      requestAnimationFrame(() => titulo.current?.focus());
    } else if (r.status === 'falhou') {
      setFase({ falhou: motivoDosCortesTxt(r.reason) });
    }
  }

  // Lendo: relê o pedido a cada 3 segundos, até 3 minutos (só enquanto a gaveta está aberta).
  const pedidoId = pedido?.id ?? null;
  useEffect(() => {
    if (fase !== 'lendo' || !pedidoId) return;
    let vezes = 0;
    const t = setInterval(() => {
      vezes += 1;
      disparar(
        (async () => {
          const r = await chamar(() => api.GET('/v1/video-montages/cuts/{id}', { params: { path: { id: pedidoId } } }));
          if (r.ok && !emCurso(r.data.status)) chegou(r.data);
          else if (vezes >= RELEITURAS) setFase('demorou');
        })(),
      );
    }, RELER_MS);
    return () => clearInterval(t);
    // `chegou` usa só setters e a ref; o laço recomeça quando a fase ou o pedido mudam.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fase, pedidoId]);

  async function pedir(outros: boolean) {
    if (fase === 'pedindo' || fase === 'lendo') return;
    setFase('pedindo');
    const r = await chamar(() =>
      api.POST('/v1/video-montages/cuts', {
        body: { brand_id: p.brandId, media_ids: p.videos.map((v) => v.id), duration_s: p.dur as 10 | 15 | 20, ...(outros && pedido ? { previous_id: pedido.id } : {}) },
      }),
    );
    if (!r.ok) {
      setFase({ falhou: motivoDosCortesTxt(r.problema.code) });
      return;
    }
    setPedido(r.data);
    if (emCurso(r.data.status)) setFase('lendo');
    else chegou(r.data);
  }

  async function verDeNovo() {
    if (!pedido) return;
    const r = await chamar(() => api.GET('/v1/video-montages/cuts/{id}', { params: { path: { id: pedido.id } } }));
    if (!r.ok) return;
    if (emCurso(r.data.status)) setFase('lendo');
    else chegou(r.data);
  }

  const n = p.videos.length;
  const ocupado = fase === 'pedindo' || fase === 'lendo';
  const restam = pedido?.others_left ?? 0;
  const temCortes = p.cortes.length > 0;
  const recebeu = Boolean(pedido && pedido.status === 'pronta');
  const descricao = [`${ids}-d`, p.erro ? `${ids}-erro` : ''].filter(Boolean).join(' ');

  let lugar: React.ReactNode;
  if (ocupado) {
    lugar = (
      <div className="vm-social" role="status">
        <p className="vm-social-espera">
          <span className="girando" aria-hidden="true" />
          <span>
            O Social media está vendo {n === 1 ? 'o vídeo' : `os ${n} vídeos`}: ele olha {quadrosTxt(n)} e não ouve o som. Ele escolhe os pedaços, a ordem e a legenda; o Compliance confere as legendas antes de chegarem aqui.
          </span>
        </p>
      </div>
    );
  } else if (fase === 'demorou') {
    lugar = (
      <div className="vm-social vm-social--sem" role="status">
        <p className="vm-social-ok">
          <Icone nome="clock" pequeno />
          <span>Ainda lendo os vídeos. Pode esperar aqui, ou ver de novo daqui a pouco.</span>
        </p>
        <div className="vm-social-acoes">
          <button className="btn btn--sm" type="button" onClick={() => disparar(verDeNovo())}>
            <Icone nome="refresh" />
            Ver de novo
          </button>
        </div>
      </div>
    );
  } else if (recebeu || temCortes) {
    const s = situacaoDoTotal(p.cortes, p.dur);
    lugar = (
      <div className={p.usados ? 'vm-cortes-usados' : 'vm-social'} role="region" aria-labelledby={`${ids}-prop-t`}>
        <p className="vm-social-cab">
          <Icone nome="sparkles" pequeno />
          <b id={`${ids}-prop-t`} ref={titulo as React.RefObject<HTMLElement>} tabIndex={-1}>
            {p.usados ? 'Os cortes do vídeo, na ordem' : 'Proposta do Social media'}
          </b>
          <span className="st st--ia">
            <Icone nome="sparkles" pequeno />
            {p.usados ? 'Escolhidos pelo Social media (IA)' : 'Feito com IA'}
          </span>
        </p>
        {!p.usados && (
          <p className="vm-cortes-viu">
            Ele viu {quadrosTxt(n)}, sem o som. O Compliance conferiu as legendas.
          </p>
        )}
        {temCortes ? (
          <ol className="vm-cortes" aria-labelledby={`${ids}-prop-t`}>
            {p.cortes.map((c, i) => (
              <ItemDoCorte key={c.chave} corte={c} i={i} n={p.cortes.length} videos={p.videos} erro={p.errosDasLegendas[c.chave]} aoMudarLista={p.aoMudar} lista={p.cortes} />
            ))}
          </ol>
        ) : (
          <p className="vm-nota vm-nota--aviso">
            <Icone nome="alert" pequeno />
            <span>Nenhum corte: todos foram tirados.{restam > 0 ? ' Peça outros cortes ao Social media.' : ''}</span>
          </p>
        )}
        <p className={`vm-cortes-total vm-cortes-total--${s.tipo}`}>
          <Icone nome={s.tipo === 'ok' ? 'check' : 'alert'} pequeno />
          <span>
            <b>{s.total}</b> · {s.txt}
          </span>
        </p>
        <div className="vm-social-acoes">
          {!p.usados && (
            <button className="btn btn--sm btn--primary" type="button" aria-disabled={temCortes ? undefined : true} onClick={() => temCortes && p.aoUsar()}>
              <Icone nome="check" />
              Usar estes
            </button>
          )}
          {pedido && (
            <button className="btn btn--sm" type="button" aria-describedby={`${ids}-resta`} aria-disabled={restam <= 0 ? true : undefined} onClick={() => restam > 0 && disparar(pedir(true))}>
              <Icone nome="refresh" />
              Pedir outros cortes
            </button>
          )}
        </div>
        {pedido && (
          <p className="campo-dica" id={`${ids}-resta`}>
            {outrosTxt(restam)}
          </p>
        )}
      </div>
    );
  } else if (fase && typeof fase === 'object') {
    lugar = (
      <div className="vm-social vm-social--sem" role="status">
        <p className="vm-social-ok">
          <Icone nome="info" pequeno />
          <span>{fase.falhou}</span>
        </p>
      </div>
    );
  } else {
    lugar = (
      <p className="vm-nota">
        <Icone nome="info" pequeno />
        <span>{n ? `O Social media vê ${n === 1 ? 'o vídeo' : `os ${n} vídeos`} e propõe de ${REGUA_DOS_CORTES.minimo} a ${REGUA_DOS_CORTES.maximo} cortes, na ordem, com a legenda de cada um. Você tira, troca a ordem e muda as legendas.` : 'Escolha os vídeos acima; depois, peça os cortes.'}</span>
      </p>
    );
  }

  const mostraPedir = !ocupado && fase !== 'demorou' && !recebeu && !temCortes;
  return (
    <fieldset className="campo" aria-describedby={descricao}>
      <legend className="rotulo">Os cortes</legend>
      <div className="vm-textos-cab">
        <span className="campo-dica" id={`${ids}-d`}>
          O Social media vê quadros dos vídeos e não ouve o som; o vídeo continua guardado no Liame. Nesta versão, o começo e o fim de cada corte são os que ele escolheu.
        </span>
        {mostraPedir && (
          <button className="btn btn--sm" type="button" aria-disabled={n ? undefined : true} onClick={() => n > 0 && disparar(pedir(false))}>
            <Icone nome="sparkles" />
            Pedir os cortes ao Social media
          </button>
        )}
      </div>
      {lugar}
      {p.erro && (
        <span className="campo-erro" id={`${ids}-erro`} role="alert">
          {p.erro}
        </span>
      )}
    </fieldset>
  );
}

function ItemDoCorte({ corte, i, n, videos, erro, lista, aoMudarLista }: { corte: CorteNaTela; i: number; n: number; videos: VideoDoCorte[]; erro?: string; lista: CorteNaTela[]; aoMudarLista: (c: CorteNaTela[]) => void }) {
  const id = useId();
  const vn = videos.findIndex((v) => v.id === corte.media_id);
  const video = videos[vn];
  const len = [...corte.caption].length;
  const descricao = [`${id}-n`, erro ? `${id}-erro` : ''].filter(Boolean).join(' ');
  return (
    <li className="vm-corte">
      <span className="vm-corte-mini" aria-hidden="true">
        {video && <img src={video.capa} alt="" decoding="async" loading="lazy" referrerPolicy="no-referrer" />}
        <span className="vm-ordem">{i + 1}</span>
      </span>
      <p className="vm-corte-de">
        <b>
          Vídeo {vn + 1} · de {tempoTxt(corte.start_ms)} a {tempoTxt(corte.end_ms)}
        </b>
        <span className="vm-corte-s">
          {segundosTxt(corte.end_ms - corte.start_ms)} s{video ? ` · ${video.produto}` : ''}
        </span>
      </p>
      <div className="vm-corte-leg">
        <label htmlFor={`${id}-leg`}>
          Legenda<span className="sr-only"> do corte {i + 1}</span>
        </label>
        <input
          className="input"
          id={`${id}-leg`}
          autoComplete="off"
          value={corte.caption}
          aria-describedby={descricao}
          aria-invalid={erro ? true : undefined}
          onChange={(e) => aoMudarLista(lista.map((c) => (c.chave === corte.chave ? { ...c, caption: e.target.value } : c)))}
        />
        <span className="vm-dica-linha">
          <span className={`vm-contador${len > REGUA_DOS_CORTES.legenda ? ' vm-contador--passou' : ''}`} id={`${id}-n`}>
            {contagem(len, REGUA_DOS_CORTES.legenda)}
          </span>
        </span>
        {erro && (
          <span className="campo-erro" id={`${id}-erro`} role="alert">
            {erro}
          </span>
        )}
      </div>
      <div className="vm-corte-acoes" role="group" aria-label={`Corte ${i + 1}`}>
        <button className="btn btn--sm btn--icon" type="button" aria-label={`Subir o corte ${i + 1}`} aria-disabled={i === 0 ? true : undefined} onClick={() => i > 0 && aoMudarLista(mover(lista, i, -1))}>
          <Icone nome="chevron-up" />
        </button>
        <button className="btn btn--sm btn--icon" type="button" aria-label={`Descer o corte ${i + 1}`} aria-disabled={i === n - 1 ? true : undefined} onClick={() => i < n - 1 && aoMudarLista(mover(lista, i, 1))}>
          <Icone nome="chevron-down" />
        </button>
        <button className="btn btn--sm" type="button" aria-label={`Tirar o corte ${i + 1}`} onClick={() => aoMudarLista(lista.filter((c) => c.chave !== corte.chave))}>
          <Icone nome="minus" />
          Tirar
        </button>
      </div>
    </li>
  );
}
