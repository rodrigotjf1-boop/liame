'use client';

import type { InstagramMedia, InstagramMediaResponse } from '@liame/contracts';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Estado } from '@/components/ui/estado';
import { Faixa } from '@/components/ui/faixa';
import { Icone } from '@/components/ui/icone';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { useSessao } from '@/lib/sessao';
import {
  comMusicaDoInstagram,
  doTipoNoInstagram,
  ehReels,
  estadoDaAba,
  nomeDaPublicacao,
  notaDaLeitura,
  numeroCurto,
  quantasNoInstagram,
  ROTULOS_DO_TIPO_NO_INSTAGRAM,
  rotuloDoCartaoDoInstagram,
  type TipoNoInstagram,
} from './do-seu-instagram';

// "Do seu Instagram" (A6 · Z10, parte 5b; mockups/prototipo-video-fotos.html, P37 parte A, aprovado em 04/11/2026;
// D-A6-71 e D-A6-83): a aba da tela Fotos com o que a loja já publicou no Instagram, a que mais rendeu primeiro, com
// os números, e a gaveta de cada publicação. Lê `GET /v1/brand-photos/instagram`, que só devolve o que a rotina do
// worker leu (uma vez por dia). Só a resposta da leitura mais nova vale (a marca trocada no meio, V64).

type Carga = { tipo: 'carregando' } | { tipo: 'ok'; dados: InstagramMediaResponse } | { tipo: 'erro'; problema: Problema };

type Props = {
  marca: string;
  agora: Date;
  /** A publicação com a gaveta aberta. A gaveta fica com a tela, fora da seção, como as outras (`fotos-tela.tsx`). */
  aberta: string | null;
  aoAbrir: (p: InstagramMedia) => void;
  aoAnunciar: (texto: string) => void;
};

export function CartaoDoInstagram({ p, posicao, agora, aberta, aoAbrir }: { p: InstagramMedia; posicao: number; agora: Date; aberta: boolean; aoAbrir: () => void }) {
  const [semImagem, setSemImagem] = useState(!p.thumbnail_url);
  const reels = ehReels(p);
  return (
    <li>
      <button className="ft-card" type="button" data-ig-publicacao={p.id} aria-haspopup="dialog" aria-expanded={aberta} aria-label={rotuloDoCartaoDoInstagram(p, posicao, agora)} onClick={aoAbrir}>
        <span className="ft-img ft-midia">
          {semImagem ? (
            <span className="ig-sem-imagem" aria-hidden="true">
              <Icone nome="image" />
            </span>
          ) : (
            // A miniatura no endereço da Meta (vale alguns dias): sem ela, o lugar vazio; a leitura de amanhã traz outra.
            <img src={p.thumbnail_url!} alt="" decoding="async" loading="lazy" referrerPolicy="no-referrer" onError={() => setSemImagem(true)} />
          )}
          <span className="ig-posicao" aria-hidden="true">
            {posicao}º
          </span>
          {reels && !semImagem && (
            <span className="ft-play" aria-hidden="true">
              <Icone nome="play" />
            </span>
          )}
        </span>
        <span className="ft-leg">
          <b>{nomeDaPublicacao(p, agora)}</b>
          {p.caption && <span className="ig-legenda-curta">{p.caption}</span>}
          {comMusicaDoInstagram(p) && (
            <span className="ft-av">
              <Icone nome="alert" pequeno />
              com música do Instagram
            </span>
          )}
          <span className="ig-numeros" aria-hidden="true">
            <span>
              <Icone nome="eye" pequeno />
              {numeroCurto(p.metrics.views)}
            </span>
            <span>
              <Icone nome="heart" pequeno />
              {numeroCurto(p.metrics.likes)}
            </span>
            <span>
              <Icone nome="message" pequeno />
              {numeroCurto(p.metrics.comments)}
            </span>
            <span>
              <Icone nome="bookmark" pequeno />
              {numeroCurto(p.metrics.saved)}
            </span>
          </span>
        </span>
      </button>
    </li>
  );
}

export function AbaDoInstagram({ marca, agora, aberta, aoAbrir, aoAnunciar }: Props) {
  const { pode } = useSessao();
  const podeVerContas = pode('contas.ver');
  const [carga, setCarga] = useState<Carga>({ tipo: 'carregando' });
  const [tentativa, setTentativa] = useState(0);
  const [tipo, setTipo] = useState<TipoNoInstagram>('tudo');
  const seq = useRef(0);

  useEffect(() => {
    const minha = ++seq.current;
    setCarga({ tipo: 'carregando' });
    disparar(
      chamar(() => api.GET('/v1/brand-photos/instagram', { params: { query: { brand_id: marca } } })).then((r) => {
        if (minha !== seq.current) return;
        setCarga(r.ok ? { tipo: 'ok', dados: r.data } : { tipo: 'erro', problema: r.problema });
      }),
    );
  }, [marca, tentativa]);

  if (carga.tipo === 'carregando') {
    return (
      <div aria-busy="true">
        <p className="sr-only">Carregando o que a loja publicou no Instagram</p>
        <div className="ft-esq" aria-hidden="true">
          {Array.from({ length: 8 }, (_, i) => (
            <span className="esqueleto" key={i} />
          ))}
        </div>
      </div>
    );
  }

  const deNovo = (
    <button className="btn btn--sm" type="button" onClick={() => setTentativa((t) => t + 1)}>
      <Icone nome="refresh" pequeno />
      Ver de novo
    </button>
  );
  const contas = podeVerContas ? (
    <Link className="btn btn--sm" href="/contas">
      <Icone nome="plug" pequeno />
      Abrir Contas conectadas
    </Link>
  ) : null;

  if (carga.tipo === 'erro') {
    return (
      <Faixa
        tipo="perigo"
        icone={<Icone nome="alert-circle" />}
        titulo="Não deu para carregar o que a loja publicou no Instagram"
        texto={`${mensagemDe(carga.problema)} Tente de novo em instantes.`}
        acao={
          <button className="btn btn--sm" type="button" onClick={() => setTentativa((t) => t + 1)}>
            <Icone nome="refresh" pequeno />
            Tentar de novo
          </button>
        }
      />
    );
  }

  const dados = carga.dados;
  const estado = estadoDaAba(dados);
  const itens = dados.items;
  const vistas = doTipoNoInstagram(itens, tipo);

  // Sem lista: o estado da situação ocupa a aba (a faixa, quando a situação é um aviso sobre o que já foi lido).
  if (estado && (!estado.faixa || itens.length === 0)) {
    const acao = estado.contas ? contas : estado.deNovo ? deNovo : null;
    return (
      <div className="card" data-ig-situacao={dados.situation}>
        <Estado icone={estado.contas ? 'plug' : estado.faixa === 'perigo' ? 'alert-circle' : 'camera'} titulo={estado.titulo} perigo={estado.faixa === 'perigo'} acao={acao ?? undefined}>
          {estado.texto}
        </Estado>
      </div>
    );
  }

  return (
    <div data-ig-situacao={dados.situation}>
      {estado?.faixa && <Faixa tipo={estado.faixa} icone={<Icone nome="alert" />} titulo={estado.titulo} texto={estado.texto} acao={estado.contas ? (contas ?? undefined) : undefined} />}
      <p className="ig-nota">
        <Icone nome="info" pequeno />
        <span>{notaDaLeitura(dados, agora)}</span>
      </p>
      {itens.length === 0 ? (
        <div className="ft-vazio">
          <span className="ft-vazio-ic" aria-hidden="true">
            <Icone nome="camera" />
          </span>
          <h2>Nada publicado ainda</h2>
          <p>Quando a loja publicar no Instagram, as publicações aparecem aqui no dia seguinte.</p>
        </div>
      ) : (
        <>
          <div className="seg ig-tipo" role="group" aria-label="Mostrar">
            {ROTULOS_DO_TIPO_NO_INSTAGRAM.map(([t, rotulo]) => (
              <button
                key={t}
                type="button"
                data-ig-tipo={t}
                aria-pressed={tipo === t}
                // Sem nenhum do tipo, o botão não tem o que mostrar.
                disabled={t !== 'tudo' && doTipoNoInstagram(itens, t).length === 0}
                onClick={() => {
                  setTipo(t);
                  aoAnunciar(quantasNoInstagram(doTipoNoInstagram(itens, t)));
                }}
              >
                {rotulo}
              </button>
            ))}
          </div>
          <h2 className="sr-only" id="ig-grade-t">
            {quantasNoInstagram(vistas)}
          </h2>
          <ul className="ft-grade" aria-labelledby="ig-grade-t">
            {vistas.map((p) => (
              <CartaoDoInstagram key={p.id} p={p} posicao={itens.indexOf(p) + 1} agora={agora} aberta={aberta === p.id} aoAbrir={() => aoAbrir(p)} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
