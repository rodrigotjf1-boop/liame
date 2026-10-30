'use client';

import type { BrandPhoto, PostResponse } from '@liame/contracts';
import Link from 'next/link';
import { type RefObject, useEffect, useId, useRef, useState } from 'react';
import { erroDaDecisao } from '@/components/aprovacoes/textos';
import { copiar } from '@/components/links/copiar';
import { ConfirmaNaLinha } from '@/components/ui/confirma-na-linha';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { ApagarDasRedes, type FeitoDoApagar } from './apagar-das-redes';
import { PreviasDoPost } from './previas-do-post';
import { SituacaoDosCanais } from './situacao-dos-canais';
import { avisoDoApagar, deOndeSai, fraseDaSituacao, linkCurto, NO_CANAL, noFuso, podeApagar, quando, situacaoDoCartao } from './textos';

// Um post da Agenda (P19, gaveta à direita): a situação, a prévia de cada canal (a foto, com o recorte do Instagram, e
// o texto), o que aconteceu em cada canal e o que dá para fazer: abrir o pedido em Aprovações (o post que espera),
// cancelar antes de sair (sem o código do app: tira o risco, D-A6-23), mudar a hora (em Aprovações, com o código de novo,
// D-A6-55), abrir Contas conectadas (o que não saiu), no canal que não saiu, "Tentar de novo" (A6, Z5d; D-A6-54), e, no
// post no ar, "Apagar das redes", com o código do app (A6, Z5d, parte 7; D-A6-57).

type Props = {
  post: PostResponse;
  fuso: string;
  hoje: string;
  /** A foto do post (das Fotos); nula quando ela saiu das Fotos ou a lista não pôde ser lida. */
  foto: BrandPhoto | null;
  podeOperar: boolean;
  /** Pode aprovar (`acoes.aprovar`): mudar a hora do post aprovado e apagar das redes pedem o código do app. */
  podeAprovar: boolean;
  podeVerContas: boolean;
  reserva: RefObject<HTMLElement | null>;
  /** O post mudou (cancelado): a tela troca o cartão. */
  aoMudar: (post: PostResponse) => void;
  /** A foto não carregou (o endereço de 5 minutos venceu): a tela pede endereços novos. */
  aoFalharImagem: () => void;
  aoFechar: () => void;
};

export function GavetaPost({ post, fuso, hoje, foto, podeOperar, podeAprovar, podeVerContas, reserva, aoMudar, aoFalharImagem, aoFechar }: Props) {
  const ids = useId();
  const fecharBt = useRef<HTMLButtonElement>(null);
  const cancelarBt = useRef<HTMLButtonElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: fecharBt, reserva });
  const [cancelando, setCancelando] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  // "Manter": o foco volta ao "Cancelar o post" depois que ele volta à tela (no efeito, depois do commit; V27, ERR-185).
  const [focarCancelar, setFocarCancelar] = useState(0);
  useEffect(() => {
    if (focarCancelar) cancelarBt.current?.focus();
  }, [focarCancelar]);
  // "Tentar de novo" (A6, Z5d; P19): o canal que está sendo pedido e o aviso do que aconteceu. O foco vai para o aviso,
  // porque o botão some quando o canal volta para a espera (no efeito, depois do commit; V27, ERR-185).
  const [tentando, setTentando] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const avisoRef = useRef<HTMLParagraphElement>(null);
  const [focarAviso, setFocarAviso] = useState(0);
  useEffect(() => {
    if (focarAviso) avisoRef.current?.focus();
  }, [focarAviso]);
  // "Apagar das redes" (A6, Z5d, parte 7; D-A6-57): o formulário com o código no lugar do botão; "Manter" devolve o foco
  // ao botão depois que ele volta à tela (V27, ERR-185).
  const [apagando, setApagando] = useState(false);
  const apagarBt = useRef<HTMLButtonElement>(null);
  const [focarApagar, setFocarApagar] = useState(0);
  useEffect(() => {
    // O botão some quando o post não dá mais para apagar (a recusa que mostrou o post como está agora): o foco vai ao "Fechar".
    if (focarApagar) (apagarBt.current ?? fecharBt.current)?.focus();
  }, [focarApagar]);
  const ocupado = enviando || tentando !== null;
  const agora = new Date();
  const { dia, hora } = noFuso(new Date(post.publish_at), fuso);
  const situacao = situacaoDoCartao(post);
  const naoApagou = avisoDoApagar(post);
  const pedidoEm = noFuso(new Date(post.created_at), fuso);

  async function cancelar() {
    if (!post.action_id) return;
    setEnviando(true);
    setErro(null);
    const r = await chamar(() => api.POST('/v1/actions/{id}/cancel', { params: { path: { id: post.action_id! } } }));
    if (!r.ok) {
      setEnviando(false);
      // O post pode ter saído (ou começado a sair) no meio: a gaveta mostra o que está valendo agora.
      setErro(r.problema.status === 409 ? 'Não deu para cancelar: o post já começou a sair, ou já não espera mais. Veja abaixo como ele está agora.' : mensagemDe(r.problema));
      const atual = await chamar(() => api.GET('/v1/posts/{id}', { params: { path: { id: post.id } } }));
      if (atual.ok) aoMudar(atual.data);
      setCancelando(false);
      return;
    }
    const atual = await chamar(() => api.GET('/v1/posts/{id}', { params: { path: { id: post.id } } }));
    setEnviando(false);
    setCancelando(false);
    if (atual.ok) aoMudar(atual.data);
    fechar();
  }

  // O mesmo post aprovado, só no canal que não saiu, sem o código do app (D-A6-54). A recusa (o prazo que passou, outra
  // tentativa no meio) diz o porquê, e a gaveta mostra o post como está agora.
  async function tentarDeNovo(canal: string) {
    setTentando(canal);
    setErro(null);
    setAviso(null);
    const r = await chamar(() => api.POST('/v1/posts/{id}/retry', { params: { path: { id: post.id } } }));
    setTentando(null);
    if (!r.ok) {
      setErro(mensagemDe(r.problema));
      const atual = await chamar(() => api.GET('/v1/posts/{id}', { params: { path: { id: post.id } } }));
      if (atual.ok) aoMudar(atual.data);
      return;
    }
    aoMudar(r.data);
    setAviso(`Tentando de novo ${NO_CANAL[canal] ?? canal}: o mesmo post aprovado, só no canal que faltou. A Agenda mostra quando ele sair.`);
    setFocarAviso((n) => n + 1);
  }

  // Com o código do app de quem apaga (D-A6-57). A recusa fica no formulário; a que diz que o post mudou (já está saindo,
  // não está mais no ar) também mostra o post como está agora.
  async function apagarDasRedes(codigo: string): Promise<FeitoDoApagar> {
    const deOnde = deOndeSai(post);
    setErro(null);
    setAviso(null);
    const r = await chamar(() => api.POST('/v1/posts/{id}/unpublish', { params: { path: { id: post.id } }, body: { code: codigo } }));
    if (!r.ok) {
      // O código que não confere com a mesma frase de Aprovações; o resto, como o servidor escreveu (com o código de rastreio no 5xx).
      const texto = r.problema.code === 'codigo-invalido' ? erroDaDecisao(r.problema).texto : mensagemDe(r.problema);
      // O post mudou (já está saindo das redes, não está mais no ar): a recusa vai para o topo, e a gaveta mostra o post
      // como está agora. A do código fica no formulário, para digitar de novo.
      if (r.problema.status === 409) {
        setErro(texto);
        setApagando(false);
        setFocarApagar((n) => n + 1);
        const atual = await chamar(() => api.GET('/v1/posts/{id}', { params: { path: { id: post.id } } }));
        if (atual.ok) aoMudar(atual.data);
      }
      return { ok: false, texto };
    }
    aoMudar(r.data);
    setApagando(false);
    setAviso(`Apagando ${deOnde}: o Liame tira o post agora. A Agenda mostra quando ele sair.`);
    setFocarAviso((n) => n + 1);
    return { ok: true };
  }

  const [copiado, setCopiado] = useState<'sim' | 'nao' | null>(null);
  async function copiarLink() {
    if (post.link) setCopiado((await copiar(post.link)) ? 'sim' : 'nao');
  }

  const podeCancelar = podeOperar && post.status === 'agendado' && post.action_id;

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
            <p className="rotulo-marca">Post</p>
            <h2 id={`${ids}-t`}>Post de {quando(dia, hora, hoje)}</h2>
          </div>
          <button className="btn btn--icon btn--ghost" type="button" ref={fecharBt} onClick={fechar} aria-label="Fechar" disabled={ocupado}>
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
          <p className={`ag-st${situacao.tom ? ` ag-st--${situacao.tom}` : ''}`}>
            <Icone nome={situacao.icone} pequeno />
            {fraseDaSituacao(post, fuso, hoje)}
          </p>
          {naoApagou && (
            <p className="dialogo-erro" role="status" data-po-nao-apagou>
              <Icone nome="alert" pequeno />
              <span>{naoApagou}</span>
            </p>
          )}
          <PreviasDoPost key={post.id} post={post} foto={foto} aoFalharImagem={aoFalharImagem} />
          <section aria-labelledby={`${ids}-sit`}>
            <h3 className="rotulo-marca" id={`${ids}-sit`}>
              Em cada canal
            </h3>
            <SituacaoDosCanais
              post={post}
              fuso={fuso}
              hoje={hoje}
              agora={agora}
              tentar={podeOperar ? { aoTentar: (canal) => disparar(tentarDeNovo(canal)), ocupado: tentando } : null}
            />
            {aviso && (
              <p className="po-nota" role="status" tabIndex={-1} ref={avisoRef}>
                <Icone nome="refresh" pequeno />
                <span>{aviso}</span>
              </p>
            )}
          </section>
          <dl className="po-fatos">
            <div>
              <dt>Marcado para</dt>
              <dd>{quando(dia, hora, hoje)}</dd>
            </div>
            <div>
              <dt>Pedido</dt>
              <dd>{quando(pedidoEm.dia, pedidoEm.hora, hoje)}</dd>
            </div>
            {post.link && (
              <div>
                <dt>Link</dt>
                <dd>
                  {linkCurto(post.link)}, com o código só deste post{' '}
                  <button className="btn btn--sm btn--ghost" type="button" onClick={() => disparar(copiarLink())}>
                    <Icone nome="copy" pequeno />
                    Copiar o link
                  </button>
                  <span className="sr-only" aria-live="polite">
                    {copiado === 'sim' ? 'Link copiado.' : copiado === 'nao' ? 'Não deu para copiar aqui.' : ''}
                  </span>
                </dd>
              </div>
            )}
          </dl>
        </div>
        <div className="dialogo-acoes">
          {post.status === 'esperando_aprovacao' && post.action_id && (
            <Link className="btn btn--primary" href={`/aprovacoes?pedido=${post.action_id}`}>
              <Icone nome="check-circle" />
              Abrir em Aprovações
            </Link>
          )}
          {podeCancelar &&
            (cancelando ? (
              <ConfirmaNaLinha
                texto="O post não sai em nenhum canal."
                rotulo="Cancelar o post"
                rotuloOcupado="Cancelando…"
                voltar="Manter"
                ocupado={enviando}
                aoConfirmar={() => disparar(cancelar())}
                aoCancelar={() => {
                  setCancelando(false);
                  setFocarCancelar((n) => n + 1);
                }}
              />
            ) : (
              <button className="btn" type="button" ref={cancelarBt} onClick={() => setCancelando(true)}>
                <Icone nome="x" />
                Cancelar o post
              </button>
            ))}
          {/* Mudar a hora pede o código do app de novo (D-A6-23 e D-A6-55): é em Aprovações, no pedido do post (P19). */}
          {post.status === 'agendado' && post.action_id && podeAprovar && !cancelando && (
            <Link className="btn" href={`/aprovacoes?pedido=${post.action_id}`}>
              <Icone nome="clock" />
              Mudar a hora
            </Link>
          )}
          {(post.status === 'nao_saiu' || post.status === 'em_parte') && podeVerContas && !apagando && (
            <Link className="btn" href="/contas">
              <Icone nome="plug" />
              Abrir Contas conectadas
            </Link>
          )}
          {/* Apagar das redes pede o código do app (P19; D-A6-57): o formulário fica no lugar do botão, como a confirmação. */}
          {podeAprovar &&
            podeApagar(post) &&
            (apagando ? (
              <ApagarDasRedes
                id={`${ids}-apagar`}
                deOnde={deOndeSai(post)}
                aoApagar={apagarDasRedes}
                aoManter={() => {
                  setApagando(false);
                  setFocarApagar((n) => n + 1);
                }}
              />
            ) : (
              <button className="btn btn--perigo" type="button" ref={apagarBt} data-po-apagar onClick={() => setApagando(true)} disabled={ocupado}>
                <Icone nome="undo" />
                Apagar das redes
              </button>
            ))}
          {!apagando && <span className="spacer" />}
          {!apagando && (
            <button className="btn" type="button" onClick={fechar} disabled={ocupado}>
              Fechar
            </button>
          )}
        </div>
      </div>
    </dialog>
  );
}
