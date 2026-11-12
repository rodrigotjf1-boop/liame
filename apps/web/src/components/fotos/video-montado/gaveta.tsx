'use client';

import { type BrandPhoto, VIDEO_TEMPLATE_RULES, type VideoFormat, type VideoMontageResponse, type VideoTemplate, type VideoTextsResponse } from '@liame/contracts';
import { type FormEvent, type RefObject, useEffect, useId, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { nomeDoProduto } from '../textos';
import { PreviaDoVideo } from './previa';
import {
  aceitas,
  contagem,
  type Duracao,
  DURACOES,
  duracaoTxt,
  FORMATOS,
  MAX,
  MODELOS,
  ORDEM_DOS_FORMATOS,
  ORDEM_DOS_MODELOS,
  ordinal,
  quantasLeva,
  semIaTxt,
  textoDaFase,
} from './textos';

// "Montar um vídeo" (A6 · Z15, parte 4; P43 aprovado em 11/11/2026): a gaveta com o modelo, as fotos ou o vídeo de
// Fotos (na ordem), o formato, os textos com o "Pedir ao Social media", a logo, a duração, o som e a prévia. Pedir põe o
// vídeo na fila (`POST /v1/video-montages`, conferido pelo servidor, com o Compliance); a gaveta passa a mostrar a fila,
// o andamento e o pronto, e a pessoa pode fechar: o vídeo aparece em Fotos.

type Campo = 'midia' | 'titulo' | 'preco' | 'chamada' | 'dur' | 'som' | 'logo' | 'geral';
const CAMPO_DO_CAMINHO: Record<string, Campo> = { media_ids: 'midia', title: 'titulo', price_line: 'preco', cta: 'chamada', duration_s: 'dur', sound: 'som', with_logo: 'logo' };

type Props = {
  brandId: string;
  /** As iniciais da marca, no selo da logo da prévia. */
  iniciais: string;
  fotos: readonly BrandPhoto[];
  temLogo: boolean;
  hoje: { used: number; limit: number };
  /** O pedido aberto pelo cartão da fila em Fotos: a gaveta mostra o andamento dele; nulo, a gaveta de um pedido novo. */
  pedido: VideoMontageResponse | null;
  reserva: RefObject<HTMLElement | null>;
  aoPedir: (m: VideoMontageResponse) => void;
  aoVerVideo: (photoId: string) => void;
  aoFechar: () => void;
};

type Social = null | 'carregando' | { proposta: NonNullable<VideoTextsResponse['texts']>; oferta: string | null } | { semIa: string };

export function GavetaMontarVideo(p: Props) {
  const ids = useId();
  const titulo = useRef<HTMLHeadingElement>(null);
  const statusT = useRef<HTMLHeadingElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: titulo, reserva: p.reserva });
  const [modelo, setModelo] = useState<VideoTemplate>('destaque');
  const [midias, setMidias] = useState<string[]>([]);
  const [formato, setFormato] = useState<VideoFormat>('9x16');
  const [dur, setDur] = useState<Duracao>(10);
  const [textos, setTextos] = useState({ titulo: '', preco: '', chamada: '' });
  const [logo, setLogo] = useState(false);
  const [som, setSom] = useState<'sem' | 'original'>('sem');
  const [erros, setErros] = useState<Partial<Record<Campo, string>>>({});
  const [aviso, setAviso] = useState('');
  const [social, setSocial] = useState<Social>(null);
  const [enviando, setEnviando] = useState(false);
  const [job, setJob] = useState<VideoMontageResponse | null>(p.pedido);
  const aoPedir = useRef(p.aoPedir);
  aoPedir.current = p.aoPedir;

  const regra = VIDEO_TEMPLATE_RULES[modelo];
  const lista = aceitas(p.fotos, modelo);
  const escolhidas = midias.map((id) => p.fotos.find((f) => f.id === id)).filter((f): f is BrandPhoto => Boolean(f));
  const comVideo = escolhidas.some((f) => f.kind === 'video');
  const cheio = p.hoje.used >= p.hoje.limit;

  // Na fila ou montando, a gaveta lê o andamento a cada 3 segundos (só enquanto está aberta).
  const emCurso = job !== null && (job.status === 'na_fila' || job.status === 'montando');
  const jobId = job?.id ?? null;
  useEffect(() => {
    if (!emCurso || !jobId) return;
    const t = setInterval(() => {
      disparar(
        (async () => {
          const r = await chamar(() => api.GET('/v1/video-montages/{id}', { params: { path: { id: jobId } } }));
          if (r.ok) {
            setJob(r.data);
            aoPedir.current(r.data);
          }
        })(),
      );
    }, 3000);
    return () => clearInterval(t);
  }, [emCurso, jobId]);

  function trocarModelo(m: VideoTemplate) {
    const r = VIDEO_TEMPLATE_RULES[m];
    setModelo(m);
    // Fica o que o modelo novo aceita, até o máximo dele.
    setMidias((atual) => atual.filter((id) => aceitas(p.fotos, m).some((f) => f.id === id)).slice(0, r.max));
    if (!r.price) setTextos((t) => ({ ...t, preco: '' }));
    if (!r.video) setSom('sem');
    setErros({});
    setAviso('');
    setSocial(null);
  }

  function escolher(f: BrandPhoto) {
    setErros((e) => ({ ...e, midia: undefined }));
    setAviso('');
    setMidias((atual) => {
      if (atual.includes(f.id)) {
        const sem = atual.filter((id) => id !== f.id);
        if (f.kind === 'video') setSom('sem');
        return sem;
      }
      if (regra.max === 1) return [f.id];
      if (atual.length >= regra.max) {
        setAviso(`Já são ${regra.max} fotos: tire uma para pôr outra.`);
        return atual;
      }
      return [...atual, f.id];
    });
  }

  async function pedirAoSocial() {
    if (social === 'carregando') return;
    if (escolhidas.length < regra.min) {
      setErros((e) => ({ ...e, midia: `Escolha ${quantasLeva(modelo)} antes de pedir os textos.` }));
      return;
    }
    setSocial('carregando');
    const r = await chamar(() => api.POST('/v1/video-montages/texts', { body: { brand_id: p.brandId, template: modelo, media_ids: midias } }));
    if (!r.ok) {
      setSocial({ semIa: mensagemDe(r.problema) });
      return;
    }
    if (r.data.origin === 'ia' && r.data.texts) setSocial({ proposta: r.data.texts, oferta: r.data.offer });
    else setSocial({ semIa: semIaTxt(r.data) });
  }

  function usarProposta() {
    if (!social || social === 'carregando' || !('proposta' in social)) return;
    setTextos({ titulo: social.proposta.title, preco: social.proposta.price_line ?? '', chamada: social.proposta.cta });
    setErros((e) => ({ ...e, titulo: undefined, preco: undefined, chamada: undefined }));
    setSocial(null);
  }

  function conferir(): Partial<Record<Campo, string>> {
    const e: Partial<Record<Campo, string>> = {};
    if (escolhidas.length < regra.min || escolhidas.length > regra.max) e.midia = `Este modelo leva ${quantasLeva(modelo)}.`;
    const titulo = textos.titulo.trim();
    if (!titulo) e.titulo = 'Escreva o título: ele aparece no começo do vídeo.';
    else if ([...titulo].length > MAX.titulo) e.titulo = `O título tem ${[...titulo].length} caracteres: o máximo é ${MAX.titulo}.`;
    if ([...textos.preco.trim()].length > MAX.preco) e.preco = `A linha do preço tem ${[...textos.preco.trim()].length} caracteres: o máximo é ${MAX.preco}.`;
    const chamada = textos.chamada.trim();
    if (!chamada) e.chamada = 'Escreva a chamada: ela diz o que a pessoa faz agora.';
    else if ([...chamada].length > MAX.chamada) e.chamada = `A chamada tem ${[...chamada].length} caracteres: o máximo é ${MAX.chamada}.`;
    return e;
  }

  async function pedir(ev: FormEvent) {
    ev.preventDefault();
    if (enviando || cheio) return;
    const e = conferir();
    setErros(e);
    if (Object.values(e).some(Boolean)) return;
    setEnviando(true);
    const r = await chamar(() =>
      api.POST('/v1/video-montages', {
        body: {
          brand_id: p.brandId,
          template: modelo,
          format: formato,
          duration_s: dur,
          media_ids: midias,
          title: textos.titulo.trim(),
          ...(regra.price && textos.preco.trim() ? { price_line: textos.preco.trim() } : {}),
          cta: textos.chamada.trim(),
          with_logo: logo,
          sound: som,
        },
      }),
    );
    setEnviando(false);
    if (!r.ok) {
      setErros(errosDoProblema(r.problema));
      return;
    }
    setJob(r.data);
    p.aoPedir(r.data);
    requestAnimationFrame(() => statusT.current?.focus());
  }

  const fase = job ? textoDaFase(job) : null;
  const pronto = job?.status === 'pronto' && job.photo_id;
  return (
    <dialog
      ref={ref}
      className="dialogo dialogo--lado vm-gaveta"
      aria-labelledby={`${ids}-t`}
      onClose={() => {
        p.aoFechar();
        devolverFoco();
      }}
      onClick={(e) => {
        if (e.target === ref.current && !enviando) fechar();
      }}
    >
      <form className="dialogo-form" onSubmit={(e) => disparar(pedir(e))} noValidate>
        <div className="dialogo-cab">
          <div className="dlg-titulo">
            <p className="rotulo-marca">Vídeo montado pelo Liame</p>
            <h2 id={`${ids}-t`} ref={titulo} tabIndex={-1}>
              Montar um vídeo
            </h2>
          </div>
          <button className="btn btn--icon btn--ghost" type="button" onClick={fechar} aria-label="Fechar" disabled={enviando}>
            <Icone nome="x" />
          </button>
        </div>
        <div className="dialogo-corpo">
          {job && fase ? (
            <div className={`vm-status${pronto ? ' vm-status--pronto' : job.status === 'nao_deu' ? ' vm-status--falhou' : ''}`}>
              <span className="vm-status-ic" aria-hidden="true">
                <Icone nome={pronto ? 'check' : job.status === 'na_fila' ? 'clock' : job.status === 'nao_deu' ? 'alert' : 'video'} />
              </span>
              <h3 ref={statusT} tabIndex={-1}>
                {fase.t}
              </h3>
              {job.status === 'montando' && (
                <div className="vm-progresso">
                  <b id={`${ids}-pct`}>Montando o vídeo: {job.progress}%</b>
                  <div className="ft-barra" role="progressbar" aria-labelledby={`${ids}-pct`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.progress}>
                    <span style={{ width: `${job.progress}%` }} />
                  </div>
                </div>
              )}
              <p role="status">{fase.txt}</p>
              <p className="campo-dica">O servidor do Liame monta um vídeo por vez, na ordem de chegada, num serviço só para isso: o resto do Liame segue rápido enquanto ele monta.</p>
            </div>
          ) : (
            <div className="vm-grade">
              <div className="vm-campos">
                {cheio && (
                  <div className="faixa faixa--atencao" role="status">
                    <span className="faixa-ic">
                      <Icone nome="clock" />
                    </span>
                    <span className="faixa-txt">
                      <b>A marca já montou {p.hoje.limit} vídeos hoje: o limite volta amanhã às 00:00.</b>
                      <span>O limite protege a fila: o servidor do Liame monta um vídeo por vez, para todas as marcas.</span>
                    </span>
                  </div>
                )}
                {erros.geral && (
                  <p className="dialogo-erro" role="alert">
                    <Icone nome="alert" pequeno />
                    <span>{erros.geral}</span>
                  </p>
                )}
                <div className="campo">
                  <span className="rotulo" id={`${ids}-modelo-t`}>
                    Modelo
                  </span>
                  <div className="vm-modelos" role="group" aria-labelledby={`${ids}-modelo-t`}>
                    {ORDEM_DOS_MODELOS.map((m) => (
                      <button key={m} className="vm-modelo" type="button" aria-pressed={modelo === m} onClick={() => trocarModelo(m)}>
                        <span className={`vm-mini vm-mini--${m}`} aria-hidden="true" />
                        <span>
                          <b>{MODELOS[m].nome}</b>
                          <small>{MODELOS[m].desc}</small>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="campo">
                  <span className="rotulo" id={`${ids}-midia-t`}>
                    As fotos e os vídeos <span className="campo-dica">({quantasLeva(modelo)})</span>
                  </span>
                  <span className="campo-dica" id={`${ids}-midia-d`}>
                    {regra.video ? 'As fotos e os vídeos de verdade de Fotos, como a loja enviou.' : 'Este modelo usa só fotos; o vídeo da loja entra no modelo Novidade da casa.'} O número em cada um é a ordem.
                  </span>
                  {lista.length ? (
                    <div className="vm-midias" role="group" aria-labelledby={`${ids}-midia-t`}>
                      {lista.map((f) => {
                        const n = midias.indexOf(f.id) + 1;
                        const video = f.kind === 'video';
                        return (
                          <button
                            key={f.id}
                            className="vm-op"
                            type="button"
                            aria-pressed={n > 0}
                            aria-describedby={`${ids}-midia-d${erros.midia ? ` ${ids}-midia-erro` : ''}`}
                            aria-invalid={erros.midia ? true : undefined}
                            aria-label={`${video ? 'Vídeo' : 'Foto'}: ${nomeDoProduto(f.product)}${f.description ? `, ${f.description}` : ''}${n ? `, escolhid${video ? 'o' : 'a'} em ${ordinal(n)} lugar` : ''}`}
                            onClick={() => escolher(f)}
                          >
                            <img src={f.thumbnail_url} alt="" decoding="async" loading="lazy" referrerPolicy="no-referrer" />
                            {video && (
                              <span className="vm-op-play" aria-hidden="true">
                                <Icone nome="play" />
                              </span>
                            )}
                            {n > 0 && (
                              <span className="vm-ordem" aria-hidden="true">
                                {n}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="campo-dica">Nenhuma foto de Fotos serve para este modelo ainda.</p>
                  )}
                  {aviso && (
                    <span className="campo-dica" role="status">
                      {aviso}
                    </span>
                  )}
                  {erros.midia && (
                    <span className="campo-erro" id={`${ids}-midia-erro`}>
                      {erros.midia}
                    </span>
                  )}
                </div>
                <Segmentos
                  id={`${ids}-formato`}
                  rotulo="Formato"
                  opcoes={ORDEM_DOS_FORMATOS.map((f) => [f, FORMATOS[f].nome])}
                  atual={formato}
                  aoEscolher={(v) => setFormato(v as VideoFormat)}
                  dica="Reels e Story, em pé; Feed, o post no perfil; Quadrado, para os dois."
                />
                <fieldset className="campo">
                  <legend className="rotulo">Os textos</legend>
                  <div className="vm-textos-cab">
                    <span className="campo-dica">O que aparece por cima das fotos. Curto: no vídeo, cada texto fica poucos segundos na tela.</span>
                    <button className="btn btn--sm" type="button" aria-disabled={social === 'carregando' ? true : undefined} onClick={() => disparar(pedirAoSocial())}>
                      <Icone nome="sparkles" />
                      Pedir ao Social media
                    </button>
                  </div>
                  <Proposta social={social} aoUsar={usarProposta} aoPedirOutros={() => disparar(pedirAoSocial())} />
                  <CampoTexto id={`${ids}-titulo`} rotulo="Título" dica="Aparece no começo, em cima da foto." valor={textos.titulo} max={MAX.titulo} erro={erros.titulo} aoMudar={(v) => setTextos((t) => ({ ...t, titulo: v }))} />
                  {regra.price ? (
                    <CampoTexto
                      id={`${ids}-preco`}
                      rotulo="Linha do preço"
                      opcional
                      dica="Só o preço de uma oferta em vigor em Minha marca › Ofertas. Vazia, o vídeo sai sem preço."
                      valor={textos.preco}
                      max={MAX.preco}
                      erro={erros.preco}
                      aoMudar={(v) => setTextos((t) => ({ ...t, preco: v }))}
                    />
                  ) : (
                    <p className="vm-nota">
                      <Icone nome="info" pequeno />
                      <span>Este modelo não leva preço: a faixa “Novidade” fica no lugar.</span>
                    </p>
                  )}
                  <CampoTexto id={`${ids}-chamada`} rotulo="Chamada" dica="Aparece no fim, embaixo: o que a pessoa faz agora." valor={textos.chamada} max={MAX.chamada} erro={erros.chamada} aoMudar={(v) => setTextos((t) => ({ ...t, chamada: v }))} />
                </fieldset>
                <div className="campo">
                  <span className="rotulo">A logo</span>
                  <label className="check vm-switch">
                    <input type="checkbox" role="switch" checked={logo} disabled={!p.temLogo} onChange={(e) => setLogo(e.target.checked)} aria-describedby={erros.logo ? `${ids}-logo-erro` : undefined} />
                    <span>
                      Pôr a logo da marca <span className="campo-dica">{p.temLogo ? '(a de Minha marca, no canto de cima)' : '(envie a logo em Minha marca para usar)'}</span>
                    </span>
                  </label>
                  {erros.logo && (
                    <span className="campo-erro" id={`${ids}-logo-erro`}>
                      {erros.logo}
                    </span>
                  )}
                </div>
                <Segmentos
                  id={`${ids}-dur`}
                  rotulo="Duração"
                  opcoes={DURACOES.map((s) => [String(s), duracaoTxt(s)])}
                  atual={String(dur)}
                  aoEscolher={(v) => setDur(Number(v) as Duracao)}
                  dica={comVideo ? 'Do vídeo da loja, entra o começo, até a duração escolhida.' : ''}
                  erro={erros.dur}
                />
                <Segmentos
                  id={`${ids}-som`}
                  rotulo="Som"
                  opcoes={[
                    ['sem', 'Sem música'],
                    ['original', 'O som do vídeo original', !comVideo],
                  ]}
                  atual={som}
                  aoEscolher={(v) => setSom(v as 'sem' | 'original')}
                  dica={comVideo ? 'O som do vídeo que a loja gravou (a chapa, a fritadeira). Música de biblioteca fica de fora por enquanto, por causa dos direitos.' : 'O som do vídeo original só vale com um vídeo. Música de biblioteca fica de fora por enquanto, por causa dos direitos.'}
                  erro={erros.som}
                />
              </div>
              <PreviaDoVideo
                key={`${modelo}-${dur}`}
                modelo={modelo}
                formato={formato}
                dur={dur}
                midias={escolhidas.map((f) => ({ id: f.id, url: f.kind === 'video' ? f.url : f.thumbnail_url, video: f.kind === 'video', produto: nomeDoProduto(f.product) }))}
                titulo={textos.titulo}
                preco={textos.preco}
                chamada={textos.chamada}
                logo={logo ? p.iniciais : null}
                somOriginal={som === 'original' && comVideo}
              />
            </div>
          )}
        </div>
        <div className="dialogo-acoes">
          {job ? (
            <>
              <span className="spacer" />
              <button className={`btn${pronto ? '' : ' btn--primary'}`} type="button" onClick={fechar}>
                Fechar
              </button>
              {pronto && job.photo_id && (
                <button className="btn btn--primary" type="button" onClick={() => p.aoVerVideo(job.photo_id!)}>
                  <Icone nome="play" />
                  Ver o vídeo
                </button>
              )}
            </>
          ) : (
            <>
              <span className="vm-cota">
                Hoje: {p.hoje.used} de {p.hoje.limit} vídeos da marca
              </span>
              <span className="spacer" />
              <button className="btn" type="button" onClick={fechar} disabled={enviando}>
                Cancelar
              </button>
              <button className="btn btn--primary" type="submit" aria-disabled={cheio || enviando ? true : undefined}>
                <Icone nome="video" />
                {enviando ? 'Pondo na fila…' : 'Gerar o vídeo'}
              </button>
            </>
          )}
        </div>
      </form>
    </dialog>
  );
}

function errosDoProblema(pr: Problema): Partial<Record<Campo, string>> {
  const e: Partial<Record<Campo, string>> = {};
  for (const x of pr.errors ?? []) {
    const campo = CAMPO_DO_CAMINHO[x.path] ?? 'geral';
    e[campo] = e[campo] ? `${e[campo]} ${x.message}` : x.message;
  }
  if (!Object.keys(e).length) e.geral = mensagemDe(pr);
  return e;
}

function Segmentos({ id, rotulo, opcoes, atual, aoEscolher, dica, erro }: { id: string; rotulo: string; opcoes: Array<[string, string, boolean?]>; atual: string; aoEscolher: (v: string) => void; dica?: string; erro?: string }) {
  const desc = [dica ? `${id}-d` : '', erro ? `${id}-erro` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className="campo">
      <span className="rotulo" id={`${id}-t`}>
        {rotulo}
      </span>
      <div className="seg" role="group" aria-labelledby={`${id}-t`} aria-describedby={desc}>
        {opcoes.map(([v, r, desligado]) => (
          <button key={v} type="button" aria-pressed={atual === v} disabled={desligado} onClick={() => aoEscolher(v)}>
            {r}
          </button>
        ))}
      </div>
      {dica && (
        <span className="campo-dica" id={`${id}-d`}>
          {dica}
        </span>
      )}
      {erro && (
        <span className="campo-erro" id={`${id}-erro`}>
          {erro}
        </span>
      )}
    </div>
  );
}

function CampoTexto({ id, rotulo, opcional, dica, valor, max, erro, aoMudar }: { id: string; rotulo: string; opcional?: boolean; dica: string; valor: string; max: number; erro?: string; aoMudar: (v: string) => void }) {
  const n = [...valor].length;
  return (
    <div className="campo">
      <label htmlFor={id}>
        {rotulo} {opcional && <span className="campo-dica">(opcional)</span>}
      </label>
      <input className="input" id={id} autoComplete="off" value={valor} onChange={(e) => aoMudar(e.target.value)} aria-describedby={`${id}-d ${id}-n${erro ? ` ${id}-erro` : ''}`} aria-invalid={erro ? true : undefined} />
      <span className="vm-dica-linha">
        <span className="campo-dica" id={`${id}-d`}>
          {dica}
        </span>
        <span className={`vm-contador${n > max ? ' vm-contador--passou' : ''}`} id={`${id}-n`}>
          {contagem(n, max)}
        </span>
      </span>
      {erro && (
        <span className="campo-erro" id={`${id}-erro`}>
          {erro}
        </span>
      )}
    </div>
  );
}

function Proposta({ social, aoUsar, aoPedirOutros }: { social: Social; aoUsar: () => void; aoPedirOutros: () => void }) {
  if (!social) return null;
  if (social === 'carregando') {
    return (
      <div className="vm-social" role="status">
        <p className="vm-social-espera">
          <span className="girando" aria-hidden="true" />
          <span>O Social media está escrevendo os textos, e o Compliance confere antes de chegarem aqui.</span>
        </p>
      </div>
    );
  }
  if ('semIa' in social) {
    return (
      <div className="vm-social vm-social--sem" role="status">
        <p className="vm-social-ok">
          <Icone nome="info" pequeno />
          <span>{social.semIa}</span>
        </p>
      </div>
    );
  }
  const linhas: Array<[string, string]> = [['Título', social.proposta.title], ...(social.proposta.price_line ? ([['Linha do preço', social.proposta.price_line]] as Array<[string, string]>) : []), ['Chamada', social.proposta.cta]];
  return (
    <div className="vm-social" role="region" aria-label="Proposta do Social media">
      <p className="vm-social-cab">
        <Icone nome="sparkles" pequeno />
        <b>Proposta do Social media</b>
        <span className="st st--ia">
          <Icone nome="sparkles" pequeno />
          Feito com IA
        </span>
      </p>
      <dl>
        {linhas.map(([t, v]) => (
          <div key={t}>
            <dt>{t}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <p className="vm-social-ok">
        <Icone nome="check-circle" pequeno />
        <span>
          O Compliance conferiu: sem promessa que a loja não cumpre e {social.oferta ? `o preço é o da oferta “${social.oferta}” (Minha marca › Ofertas)` : 'sem preço'}.
        </span>
      </p>
      <div className="vm-social-acoes">
        <button className="btn btn--sm btn--primary" type="button" onClick={aoUsar}>
          <Icone nome="check" />
          Usar estes
        </button>
        <button className="btn btn--sm" type="button" onClick={aoPedirOutros}>
          <Icone nome="refresh" />
          Pedir outros
        </button>
      </div>
    </div>
  );
}
