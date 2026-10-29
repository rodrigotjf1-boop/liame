'use client';

import type { BrandPhoto, PostResponse } from '@liame/contracts';
import Link from 'next/link';
import { type RefObject, useId, useRef, useState } from 'react';
import { ConfirmaNaLinha } from '@/components/ui/confirma-na-linha';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { PreviaDoCanal } from './previa-do-canal';
import { formatoDaPrevia, fraseDaSituacao, linhaDoCanal, NOME_DO_CANAL, noFuso, quando, situacaoDoPost } from './textos';

// Um post da Agenda (P19, gaveta à direita): a situação, a prévia de cada canal (a foto, com o recorte do Instagram, e
// o texto), o que aconteceu em cada canal e o que dá para fazer: abrir o pedido em Aprovações (o post que espera),
// cancelar antes de sair (sem o código do app: tira o risco, D-A6-23) e abrir Contas conectadas (o que não saiu). Mudar
// a hora, apagar das redes e tentar de novo num canal ficam para quando o servidor fizer (divergência do P19).

type Props = {
  post: PostResponse;
  fuso: string;
  hoje: string;
  /** A foto do post (das Fotos); nula quando ela saiu das Fotos ou a lista não pôde ser lida. */
  foto: BrandPhoto | null;
  podeOperar: boolean;
  podeVerContas: boolean;
  reserva: RefObject<HTMLElement | null>;
  /** O post mudou (cancelado): a tela troca o cartão. */
  aoMudar: (post: PostResponse) => void;
  /** A foto não carregou (o endereço de 5 minutos venceu): a tela pede endereços novos. */
  aoFalharImagem: () => void;
  aoFechar: () => void;
};

export function GavetaPost({ post, fuso, hoje, foto, podeOperar, podeVerContas, reserva, aoMudar, aoFalharImagem, aoFechar }: Props) {
  const ids = useId();
  const fecharBt = useRef<HTMLButtonElement>(null);
  const cancelarBt = useRef<HTMLButtonElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: fecharBt, reserva });
  const [aba, setAba] = useState(post.channels[0]?.channel ?? 'instagram');
  const [cancelando, setCancelando] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const { dia, hora } = noFuso(new Date(post.publish_at), fuso);
  const situacao = situacaoDoPost(post.status);
  const canal = post.channels.find((c) => c.channel === aba) ?? post.channels[0];
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

  const formato = foto ? formatoDaPrevia(canal?.channel ?? 'facebook', foto.width, foto.height) : 'inteira';
  const linhas = post.channels.map((c) => linhaDoCanal(c, post, fuso, hoje));
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
        if (e.target === ref.current && !enviando) fechar();
      }}
    >
      <div className="dialogo-form">
        <div className="dialogo-cab">
          <div className="dlg-titulo">
            <p className="rotulo-marca">Post</p>
            <h2 id={`${ids}-t`}>Post de {quando(dia, hora, hoje)}</h2>
          </div>
          <button className="btn btn--icon btn--ghost" type="button" ref={fecharBt} onClick={fechar} aria-label="Fechar" disabled={enviando}>
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
          {post.channels.length > 1 && (
            <div className="seg po-canais-seg" role="group" aria-label="Ver como sai em">
              {post.channels.map((c) => (
                <button key={c.channel} type="button" aria-pressed={c.channel === aba} onClick={() => setAba(c.channel)}>
                  {NOME_DO_CANAL[c.channel] ?? c.channel}
                </button>
              ))}
            </div>
          )}
          {canal && (
            <PreviaDoCanal
              canal={canal.channel}
              conta={canal.account_name}
              texto={canal.text}
              foto={foto}
              recorte={post.crop_pos}
              semFoto={post.photo_id ? 'A foto deste post não pôde ser mostrada aqui.' : 'A foto deste post foi apagada nas Fotos: ele não sai.'}
              aoFalharImagem={aoFalharImagem}
            />
          )}
          {canal?.channel === 'instagram' && formato !== 'inteira' && (
            <p className="po-nota">
              <Icone nome="info" pequeno />
              <span>
                No Instagram, a foto sai recortada em {formato === 'alta' ? '4:5, em pé' : '1,91:1, deitada'}: a foto inteira é {formato === 'alta' ? 'mais alta' : 'mais larga'} do que o Instagram aceita.
                {post.channels.length > 1 ? ' Na Página, ela vai inteira.' : ''}
              </span>
            </p>
          )}
          {canal?.channel === 'instagram' && (
            <p className="po-nota">
              <Icone nome="link" pequeno />
              <span>No Instagram, a legenda não tem link que abre: o texto diz onde pedir (&ldquo;Peça pelo link da bio&rdquo;).</span>
            </p>
          )}
          <section aria-labelledby={`${ids}-sit`}>
            <h3 className="rotulo-marca" id={`${ids}-sit`}>
              Em cada canal
            </h3>
            <ul className="po-situacao">
              {linhas.map((l) => (
                <li key={l.canal}>
                  <span className={l.tom}>
                    <Icone nome={l.icone} />
                  </span>
                  <span>
                    <b>{l.nome}:</b> {l.frase}
                  </span>
                  {l.endereco && (
                    <a className="btn btn--sm btn--ghost" href={l.endereco} target="_blank" rel="noopener noreferrer">
                      <Icone nome="external" pequeno />
                      {l.rotuloDoEndereco}
                    </a>
                  )}
                </li>
              ))}
            </ul>
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
                  requestAnimationFrame(() => cancelarBt.current?.focus());
                }}
              />
            ) : (
              <button className="btn" type="button" ref={cancelarBt} onClick={() => setCancelando(true)}>
                <Icone nome="x" />
                Cancelar o post
              </button>
            ))}
          {(post.status === 'nao_saiu' || post.status === 'em_parte') && podeVerContas && (
            <Link className="btn" href="/contas">
              <Icone nome="plug" />
              Abrir Contas conectadas
            </Link>
          )}
          <span className="spacer" />
          <button className="btn" type="button" onClick={fechar} disabled={enviando}>
            Fechar
          </button>
        </div>
      </div>
    </dialog>
  );
}
