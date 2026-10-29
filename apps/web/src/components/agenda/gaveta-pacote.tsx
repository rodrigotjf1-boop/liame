'use client';

import type { BrandPhoto, PostResponse } from '@liame/contracts';
import { type RefObject, useEffect, useId, useRef, useState } from 'react';
import { copiar } from '@/components/links/copiar';
import { ConfirmaNaLinha } from '@/components/ui/confirma-na-linha';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { PreviaDoPacote } from './previa-do-pacote';
import { fraseDoPacote, NOME_DO_CANAL, NO_CANAL, noFuso, quando } from './textos';

// O pacote pronto na Agenda (mockups/prototipo-pacote.html, P22 aprovado em 21/10/2026; Z8 da A6): no TikTok e no
// YouTube o Liame não publica. A gaveta mostra o pacote (a foto inteira e o texto) e os quatro passos: baixar a foto (a
// cópia que o Liame guarda, por um endereço de 5 minutos que baixa como arquivo; D-A6-43), copiar o texto, publicar na
// rede e marcar "Publiquei"; e "Tirar da Agenda". O link do cardápio só deste pacote, para a bio, fica para quando o
// servidor fizer o link do post (divergência do P22, como a do P19).

type Props = {
  post: PostResponse;
  fuso: string;
  hoje: string;
  /** A foto do pacote (das Fotos); nula quando ela saiu das Fotos, ou a lista não pôde ser lida. */
  foto: BrandPhoto | null;
  podeOperar: boolean;
  reserva: RefObject<HTMLElement | null>;
  /** O pacote mudou (marcado como publicado, ou relido depois de uma recusa): a tela troca o cartão. */
  aoMudar: (post: PostResponse) => void;
  /** O pacote saiu da Agenda: a tela tira o cartão e avisa. */
  aoTirar: (post: PostResponse) => void;
  /** A foto não carregou (o endereço de 5 minutos venceu): a tela pede endereços novos. */
  aoFalharImagem: () => void;
  aoFechar: () => void;
};

type Ocupado = 'publiquei' | 'tirar' | 'baixar' | null;

/** "Amanhã, às 19:00" (a primeira letra maiúscula, no começo da frase). */
const maiuscula = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function GavetaPacote({ post, fuso, hoje, foto, podeOperar, reserva, aoMudar, aoTirar, aoFalharImagem, aoFechar }: Props) {
  const ids = useId();
  const fecharBt = useRef<HTMLButtonElement>(null);
  const tirarBt = useRef<HTMLButtonElement>(null);
  const situacaoRef = useRef<HTMLParagraphElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: fecharBt, reserva });
  const [ocupado, setOcupado] = useState<Ocupado>(null);
  const [tirando, setTirando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [copiado, setCopiado] = useState<'sim' | 'nao' | null>(null);
  // O foco depois do "Publiquei" (na frase da situação) e do "Manter" (no "Tirar da Agenda"): no efeito, depois que a
  // tela redesenha (V27, ERR-185).
  const [focarSituacao, setFocarSituacao] = useState(0);
  const [focarTirar, setFocarTirar] = useState(0);
  useEffect(() => {
    if (focarSituacao) situacaoRef.current?.focus();
  }, [focarSituacao]);
  useEffect(() => {
    if (focarTirar) tirarBt.current?.focus();
  }, [focarTirar]);

  const canal = post.channels[0];
  const nome = NOME_DO_CANAL[canal?.channel ?? ''] ?? canal?.channel ?? '';
  const no = NO_CANAL[canal?.channel ?? ''] ?? `em ${nome}`;
  const { dia, hora } = noFuso(new Date(post.publish_at), fuso);
  const pronto = post.status === 'pacote_pronto';
  const publicado = post.status === 'pacote_publicado';

  /** Depois de uma recusa (o pacote mudou noutro lugar), a gaveta mostra o que está valendo agora. */
  async function reler() {
    const atual = await chamar(() => api.GET('/v1/posts/{id}', { params: { path: { id: post.id } } }));
    if (atual.ok) aoMudar(atual.data);
  }

  async function publiquei() {
    setOcupado('publiquei');
    setErro(null);
    const r = await chamar(() => api.POST('/v1/posts/{id}/published', { params: { path: { id: post.id } } }));
    setOcupado(null);
    if (!r.ok) {
      setErro(mensagemDe(r.problema));
      return reler();
    }
    aoMudar(r.data);
    setFocarSituacao((n) => n + 1);
  }

  async function tirar() {
    setOcupado('tirar');
    setErro(null);
    const r = await chamar(() => api.POST('/v1/posts/{id}/remove', { params: { path: { id: post.id } } }));
    setOcupado(null);
    setTirando(false);
    if (!r.ok) {
      setErro(mensagemDe(r.problema));
      return reler();
    }
    fechar();
    aoTirar(r.data);
  }

  async function baixar() {
    setOcupado('baixar');
    setErro(null);
    const r = await chamar(() => api.GET('/v1/posts/{id}/photo', { params: { path: { id: post.id } } }));
    setOcupado(null);
    if (!r.ok) return setErro(mensagemDe(r.problema));
    // O endereço baixa como arquivo (o S3 manda o nome); o `download` dá o nome quando o endereço é da própria página.
    const a = document.createElement('a');
    a.href = r.data.url;
    a.download = r.data.filename;
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
  }

  async function copiarTexto() {
    setCopiado((await copiar(canal?.text ?? '')) ? 'sim' : 'nao');
  }

  return (
    <dialog
      ref={ref}
      className="dialogo dialogo--lado po-gaveta"
      aria-labelledby={`${ids}-t`}
      onClose={() => {
        aoFechar();
        devolverFoco();
      }}
      onClick={(e) => {
        if (e.target === ref.current && !ocupado) fechar();
      }}
    >
      <div className="dialogo-form">
        <div className="dialogo-cab">
          <div className="dlg-titulo">
            <p className="rotulo-marca">Pacote pronto</p>
            <h2 id={`${ids}-t`}>Pacote de {quando(dia, hora, hoje)}</h2>
          </div>
          <button className="btn btn--icon btn--ghost" type="button" ref={fecharBt} onClick={fechar} aria-label="Fechar" disabled={Boolean(ocupado)}>
            <Icone nome="x" />
          </button>
        </div>
        <div className="dialogo-corpo">
          {erro && (
            <p className="dialogo-erro" role="alert">
              <Icone nome="alert" pequeno />
              <span>{erro}</span>
            </p>
          )}
          <p className={`ag-st${publicado ? ' ag-st--ok' : ''}`} ref={situacaoRef} tabIndex={-1}>
            <Icone nome={publicado ? 'check-circle' : 'send'} pequeno />
            {fraseDoPacote(post, fuso, hoje)}
          </p>
          <PreviaDoPacote
            canal={canal?.channel ?? ''}
            texto={canal?.text ?? ''}
            foto={foto}
            semFoto={post.photo_id ? 'A foto deste pacote não pôde ser mostrada aqui.' : 'A foto deste pacote foi apagada nas Fotos.'}
            aoFalharImagem={aoFalharImagem}
          />
          <section aria-labelledby={`${ids}-passos`}>
            <h3 className="rotulo-marca" id={`${ids}-passos`}>
              Como publicar
            </h3>
            <ol className="pk-passos">
              <li>
                <span className="pk-n" aria-hidden="true">
                  1
                </span>
                <span>
                  <b>Baixe a foto</b>
                  <span>{post.photo_id ? 'A cópia que o Liame guarda, em JPEG, sem os dados do celular.' : 'A foto foi apagada nas Fotos: monte outro pacote com outra foto.'}</span>
                </span>
                {podeOperar && post.photo_id && (
                  <button className="btn btn--sm" type="button" onClick={() => disparar(baixar())} disabled={Boolean(ocupado)}>
                    <Icone nome="download" pequeno />
                    {ocupado === 'baixar' ? 'Preparando…' : 'Baixar a foto'}
                  </button>
                )}
              </li>
              <li>
                <span className="pk-n" aria-hidden="true">
                  2
                </span>
                <span>
                  <b>Copie o texto</b>
                  <span aria-live="polite">
                    {copiado === 'sim' ? 'Texto copiado.' : copiado === 'nao' ? 'Não deu para copiar aqui: selecione o texto na prévia e copie.' : 'As palavras que a política da marca proíbe já foram conferidas.'}
                  </span>
                </span>
                <button className="btn btn--sm" type="button" onClick={() => disparar(copiarTexto())}>
                  <Icone nome="copy" pequeno />
                  Copiar o texto
                </button>
              </li>
              <li>
                <span className="pk-n" aria-hidden="true">
                  3
                </span>
                <span>
                  <b>Publique {no}</b>
                  <span>{maiuscula(quando(dia, hora, hoje))}. O Liame não publica nessa rede: quem publica é você.</span>
                </span>
              </li>
              <li>
                <span className="pk-n" aria-hidden="true">
                  4
                </span>
                <span>
                  <b>Marque como publicado</b>
                  <span>{publicado ? 'Feito: a Agenda mostra que saiu.' : 'Assim a Agenda mostra que saiu.'}</span>
                </span>
                {podeOperar && pronto && (
                  <button className="btn btn--sm btn--primary" type="button" onClick={() => disparar(publiquei())} disabled={Boolean(ocupado)}>
                    <Icone nome="check" pequeno />
                    {ocupado === 'publiquei' ? 'Marcando…' : 'Publiquei'}
                  </button>
                )}
              </li>
            </ol>
          </section>
        </div>
        <div className="dialogo-acoes">
          {podeOperar &&
            pronto &&
            (tirando ? (
              <ConfirmaNaLinha
                texto="O pacote sai da Agenda. Nada foi publicado pelo Liame."
                rotulo="Tirar da Agenda"
                rotuloOcupado="Tirando…"
                voltar="Manter"
                ocupado={ocupado === 'tirar'}
                aoConfirmar={() => disparar(tirar())}
                aoCancelar={() => {
                  setTirando(false);
                  setFocarTirar((n) => n + 1);
                }}
              />
            ) : (
              <button className="btn" type="button" ref={tirarBt} onClick={() => setTirando(true)} disabled={Boolean(ocupado)}>
                <Icone nome="x" />
                Tirar da Agenda
              </button>
            ))}
          <span className="spacer" />
          <button className="btn" type="button" onClick={fechar} disabled={Boolean(ocupado)}>
            Fechar
          </button>
        </div>
      </div>
    </dialog>
  );
}
