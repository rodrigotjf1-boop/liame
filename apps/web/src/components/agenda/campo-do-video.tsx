'use client';

import type { BrandPhoto } from '@liame/contracts';
import type { RefObject } from 'react';
import { duracaoCurta } from '@/components/fotos/textos';
import { Icone } from '@/components/ui/icone';
import { avisoDasFaixas, dicaDaMidiaDoStory } from './story-do-post';
import {
  AVISO_DO_DEITADO,
  CAPA_NO_PACOTE,
  type CapaDoNovo,
  dicaDaCapa,
  duracaoDoVideo,
  QUADRO_DO_MEIO,
  rotuloDoQuadro,
  rotuloDoVideoNoPost,
  temposDosQuadros,
  type VideoDasFotos,
  videoDeitado,
  videoNoTempo,
} from './video-do-post';

// O vídeo e a capa no novo post (P37, parte B; A6, Z10, parte 4a; D-A6-70): os vídeos prontos das Fotos e vídeos, como a
// loja gravou, com a duração; o aviso do deitado; e a capa, por um quadro do próprio vídeo (cinco, o do meio marcado: é a
// capa guardada com ele) ou por uma das Fotos. Os quadros o navegador mostra pelo tempo, sem ler os bytes do vídeo. A capa
// é a do Reels (A6, Z10, parte 4c; D-A6-79): só com o pacote marcado, ela sai da tela, e a nota diz quem escolhe.

type Props = {
  /** O Story (A6, Z13): sem capa, com a dica e o aviso dele. */
  story?: boolean;
  /** Só o pacote (o TikTok e o YouTube) está marcado: a capa não vale. */
  soPacote?: boolean;
  /** O pacote está marcado junto com o Instagram ou a Página: a dica da capa diz o que vale no pacote. */
  comPacote?: boolean;
  ids: string;
  videos: VideoDasFotos[];
  /** As fotos das Fotos, para a capa. */
  fotos: BrandPhoto[];
  escolhido: string | null;
  aoEscolher: (id: string) => void;
  capa: CapaDoNovo;
  aoMudarCapa: (c: CapaDoNovo) => void;
  erroVideo?: string;
  erroCapa?: string;
  enviando: boolean;
  podeVerFotos: boolean;
  primeiro: RefObject<HTMLButtonElement | null>;
};

export function CampoDoVideo({
  ids,
  videos,
  fotos,
  escolhido,
  aoEscolher,
  capa,
  aoMudarCapa,
  erroVideo,
  erroCapa,
  enviando,
  podeVerFotos,
  primeiro,
  soPacote = false,
  comPacote = false,
  story = false,
}: Props) {
  const video = videos.find((v) => v.id === escolhido) ?? null;
  return (
    <>
      <div className="campo" role="group" aria-labelledby={`${ids}-videos-t`} aria-describedby={erroVideo ? `${ids}-video-erro` : `${ids}-videos-d`}>
        <span className="rotulo" id={`${ids}-videos-t`}>
          O vídeo
        </span>
        <span className="campo-dica" id={`${ids}-videos-d`}>
          {story ? dicaDaMidiaDoStory(true) : 'Os vídeos de verdade da tela Fotos, como a loja gravou: MP4 ou MOV, de 3 a 90 segundos.'}
        </span>
        {videos.length ? (
          <ul className="po-fotos" aria-label="Vídeos da marca">
            {videos.map((v, i) => (
              <li key={v.id}>
                <button
                  className="po-foto-op po-video-op"
                  type="button"
                  ref={i === 0 ? primeiro : undefined}
                  aria-pressed={escolhido === v.id}
                  aria-label={rotuloDoVideoNoPost(v)}
                  onClick={() => aoEscolher(v.id)}
                  disabled={enviando}
                >
                  {v.video.has_cover ? (
                    <img src={v.thumbnail_url} alt="" referrerPolicy="no-referrer" />
                  ) : (
                    <video src={videoNoTempo(v.url, 100)} muted playsInline preload="metadata" aria-hidden="true" tabIndex={-1} />
                  )}
                  <span className="po-video-tocar" aria-hidden="true">
                    <Icone nome="play" pequeno />
                  </span>
                  <span className="po-video-dur" aria-hidden="true">
                    {duracaoDoVideo(v)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="po-nota">
            <Icone nome="video" pequeno />
            <span>Ainda não há vídeo pronto em Fotos.{podeVerFotos ? ' Envie pela tela Fotos, em "Enviar fotos e vídeos".' : ''}</span>
          </p>
        )}
        {video && videoDeitado(video) && (
          <p className="po-aviso">
            <Icone nome="alert" pequeno />
            <span>{story ? avisoDasFaixas(video) : AVISO_DO_DEITADO}</span>
          </p>
        )}
        {erroVideo && (
          <span className="campo-erro" id={`${ids}-video-erro`}>
            {erroVideo}
          </span>
        )}
      </div>

      {video && soPacote && !story && (
        <p className="po-nota" data-po-capa-pacote="">
          <Icone nome="image" pequeno />
          <span>{CAPA_NO_PACOTE}</span>
        </p>
      )}
      {video && !soPacote && !story && (
        <fieldset className="campo po-capa" aria-describedby={erroCapa ? `${ids}-capa-erro` : `${ids}-capa-d`}>
          <legend>A capa</legend>
          <div className="seg" role="group" aria-label="De onde vem a capa">
            <button type="button" aria-pressed={capa.modo === 'quadro'} onClick={() => aoMudarCapa({ modo: 'quadro', quadro: QUADRO_DO_MEIO })} disabled={enviando}>
              Um quadro do vídeo
            </button>
            <button type="button" aria-pressed={capa.modo === 'foto'} onClick={() => aoMudarCapa({ modo: 'foto', foto: null })} disabled={enviando}>
              Uma das Fotos
            </button>
          </div>
          {capa.modo === 'quadro' ? (
            <ul className="po-capa-quadros po-capa-quadros--video" aria-label="Quadros do vídeo">
              {temposDosQuadros(video.video.duration_ms).map((t, i) => (
                <li key={t}>
                  <button
                    className={`po-capa-quadro${videoDeitado(video) ? ' po-capa-quadro--deitado' : ''}`}
                    type="button"
                    aria-pressed={capa.quadro === i}
                    aria-label={rotuloDoQuadro(t)}
                    onClick={() => aoMudarCapa({ modo: 'quadro', quadro: i })}
                    disabled={enviando}
                  >
                    {i === QUADRO_DO_MEIO && video.video.has_cover ? (
                      <img src={video.thumbnail_url} alt="" referrerPolicy="no-referrer" />
                    ) : (
                      <video src={videoNoTempo(video.url, t)} muted playsInline preload="metadata" aria-hidden="true" tabIndex={-1} />
                    )}
                    <span aria-hidden="true">{duracaoCurta(t)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : fotos.length ? (
            <ul className="po-capa-quadros" aria-label="Fotos para a capa">
              {fotos.map((f) => (
                <li key={f.id}>
                  <button
                    className="po-capa-quadro"
                    type="button"
                    aria-pressed={capa.foto === f.id}
                    aria-label={`${f.product ?? 'Sem produto'}${f.description ? `: ${f.description}` : ''}`}
                    onClick={() => aoMudarCapa({ modo: 'foto', foto: f.id })}
                    disabled={enviando}
                  >
                    <img src={f.thumbnail_url} alt="" referrerPolicy="no-referrer" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="po-nota">
              <Icone nome="camera" pequeno />
              <span>Nenhuma foto pronta nas Fotos desta marca para a capa: use um quadro do vídeo.</span>
            </p>
          )}
          <span className="campo-dica" id={`${ids}-capa-d`}>
            {dicaDaCapa(capa.modo, comPacote)}
          </span>
          {erroCapa && (
            <span className="campo-erro" id={`${ids}-capa-erro`}>
              {erroCapa}
            </span>
          )}
        </fieldset>
      )}
    </>
  );
}
