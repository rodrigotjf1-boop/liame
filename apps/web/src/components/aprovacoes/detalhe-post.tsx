'use client';

import type { BrandPhoto } from '@liame/contracts';
import Link from 'next/link';
import { type RefObject, useEffect, useId, useRef, useState } from 'react';
import { PreviasDoPost } from '@/components/agenda/previas-do-post';
import { SituacaoDosCanais } from '@/components/agenda/situacao-dos-canais';
import { noFuso } from '@/components/agenda/textos';
import { ConfirmaNaLinha } from '@/components/ui/confirma-na-linha';
import { Icone } from '@/components/ui/icone';
import { disparar } from '@/lib/disparar';
import { BarraDaDecisao, type Decisao } from './barra-da-decisao';
import type { Feito } from './detalhe-mensagem';
import { MudarAHora } from './mudar-a-hora';
import { type AcaoDePost, horaJaPassou, MOTIVOS_DO_POST, postApresentado, quandoDoPost, resultadoDoPost } from './post-textos';
import { aprovacaoParcial, cabecalhoDe, type Grupo, identidadeDoPlano, prazoDe } from './textos';

// O post em Aprovações (P19, aprovado pelo dono em 21/10/2026; A6, Z5c, parte 4): quem pediu, a frase do modo simples,
// a prévia de cada canal (a foto, com o recorte do Instagram, e o texto), o que foi conferido e a decisão com o código do
// app. Decidido: o resultado (agendado, publicando, publicado, em parte, não saiu, cancelado, recusado, expirado), o que
// aconteceu em cada canal, no agendado "Cancelar o post" (sem o código: tira o risco, D-A6-23) e "Mudar a hora" (com o
// código de novo, D-A6-55) e, no canal que não saiu, "Tentar de novo" (A6, Z5d; D-A6-54). Apagar das redes fica para
// quando o servidor fizer (divergência do P19, como na Agenda).

type Props = {
  acao: AcaoDePost;
  grupo: Grupo | null;
  agora: Date;
  pro: boolean;
  /** Pode aprovar e recusar (`acoes.aprovar`). */
  podeDecidir: boolean;
  /** Pode cancelar o post agendado (`campanhas.operar`, como na Agenda). */
  podeOperar: boolean;
  podeVerContas: boolean;
  temApp: boolean;
  /** A foto do post (das Fotos); nula quando ela não pôde ser lida, saiu das Fotos ou quem vê não vê as Fotos. */
  foto: BrandPhoto | null;
  titulo: RefObject<HTMLHeadingElement | null>;
  campoCodigo: RefObject<HTMLInputElement | null>;
  aoVoltar: () => void;
  aoAprovar: (acao: AcaoDePost, codigo: string) => Promise<Decisao>;
  aoRecusar: (acao: AcaoDePost, motivo: string) => Promise<Decisao>;
  aoCancelar: (acao: AcaoDePost) => Promise<Feito>;
  /** "Tentar de novo" no canal que não saiu (A6, Z5d): a tela pede, avisa e lê de novo. */
  aoTentarDeNovo: (acao: AcaoDePost, canal: string) => Promise<Feito>;
  /** "Mudar a hora" do post aprovado (A6, Z5d; D-A6-55): a tela pede com o código, avisa e abre o pedido novo. */
  aoMudarAHora: (acao: AcaoDePost, publishAt: string, codigo: string) => Promise<Feito>;
  /** A foto não carregou (o endereço de 5 minutos venceu): a tela pede endereços novos. */
  aoFalharImagem: () => void;
};

const MOTIVOS = MOTIVOS_DO_POST.map((m) => ({ valor: m, rotulo: m }));

export function DetalhePost({
  acao,
  grupo,
  agora,
  pro,
  podeDecidir,
  podeOperar,
  podeVerContas,
  temApp,
  foto,
  titulo,
  campoCodigo,
  aoVoltar,
  aoAprovar,
  aoRecusar,
  aoCancelar,
  aoTentarDeNovo,
  aoMudarAHora,
  aoFalharImagem,
}: Props) {
  const ids = useId();
  const post = acao.post;
  const p = postApresentado(acao, agora);
  const cab = cabecalhoDe(acao, agora);
  const plano = identidadeDoPlano(acao);
  const prazo = prazoDe(acao, agora);
  const hoje = noFuso(agora, post.timezone).dia;
  const cancelarBt = useRef<HTMLButtonElement>(null);
  const [cancelando, setCancelando] = useState<'nao' | 'confirmando' | 'enviando'>('nao');
  const [erroAoCancelar, setErroAoCancelar] = useState<string | null>(null);
  // "Manter": o foco volta ao botão depois que ele volta à tela (no efeito, depois do commit; V27, ERR-185).
  const [focarCancelar, setFocarCancelar] = useState(0);
  useEffect(() => {
    if (focarCancelar) cancelarBt.current?.focus();
  }, [focarCancelar]);

  // "Tentar de novo" no canal que não saiu (A6, Z5d; D-A6-54): o canal que está sendo pedido e a recusa.
  const [tentando, setTentando] = useState<string | null>(null);
  const [erroAoTentar, setErroAoTentar] = useState<string | null>(null);
  // "Mudar a hora" (A6, Z5d, parte 4): o formulário aberto.
  const [mudando, setMudando] = useState(false);

  // Outro pedido aberto: a confirmação, o formulário e o erro eram do anterior.
  useEffect(() => {
    setCancelando('nao');
    setErroAoCancelar(null);
    setErroAoTentar(null);
    setMudando(false);
  }, [acao.id]);

  async function cancelar() {
    setCancelando('enviando');
    setErroAoCancelar(null);
    const r = await aoCancelar(acao);
    setCancelando('nao');
    if (!r.ok) setErroAoCancelar(r.texto);
  }

  async function tentarDeNovo(canal: string) {
    setTentando(canal);
    setErroAoTentar(null);
    const r = await aoTentarDeNovo(acao, canal);
    setTentando(null);
    if (!r.ok) setErroAoTentar(r.texto);
  }

  const voltar = (
    <button className="btn btn--ghost btn--sm voltar" type="button" onClick={aoVoltar}>
      <Icone nome="chevron-left" />
      Voltar para a lista
    </button>
  );
  const cabecalho = (
    <>
      <div className="det-cab">
        <span>
          <b>{cab.quem}</b> {cab.verbo}
        </span>
        <span>· {cab.quando}</span>
      </div>
      <h2 className="det-titulo" id="ap-det-titulo" ref={titulo} tabIndex={-1}>
        {p.titulo}
      </h2>
    </>
  );
  const previas = (
    <div className="secao">
      <p className="rotulo-marca">Como sai</p>
      <PreviasDoPost key={acao.id} post={post} foto={foto} aoFalharImagem={aoFalharImagem} />
    </div>
  );

  if (grupo !== 'pendente') {
    const r = resultadoDoPost(acao, agora);
    const mostraCanais = ['publicado', 'em_parte', 'nao_saiu', 'publicando'].includes(post.status);
    const podeCancelar = podeOperar && post.status === 'agendado';
    // Mudar a hora (A6, Z5d; D-A6-23 e D-A6-55): quem pode aprovar, no pedido aprovado do post que espera a hora.
    const podeMudar = podeDecidir && post.status === 'agendado' && acao.status === 'aprovada' && acao.id === post.action_id;
    return (
      <>
        {voltar}
        {cabecalho}
        <p className="plano-id">Plano {plano.plano}</p>
        <div className="secao">
          <div className={`resultado${r.tom ? ` resultado--${r.tom}` : ''}`} role={r.tom === 'falha' ? 'alert' : 'status'} id={`${ids}-resultado`}>
            <Icone nome={r.icone} />
            <span>
              <b>{r.titulo}</b> {r.texto}
            </span>
          </div>
          {mostraCanais && (
            <SituacaoDosCanais
              post={post}
              fuso={post.timezone}
              hoje={hoje}
              agora={agora}
              rotulo="Em cada canal"
              tentar={podeOperar ? { aoTentar: (canal) => disparar(tentarDeNovo(canal)), ocupado: tentando } : null}
            />
          )}
          {erroAoTentar && (
            <p className="campo-erro" role="alert">
              {erroAoTentar}
            </p>
          )}
          {(podeCancelar || podeMudar) && (
            <div className="desfazer">
              {podeCancelar &&
                (cancelando === 'nao' ? (
                  <button ref={cancelarBt} className="btn" type="button" data-po-cancelar onClick={() => setCancelando('confirmando')}>
                    <Icone nome="x" pequeno />
                    Cancelar o post
                  </button>
                ) : (
                  <ConfirmaNaLinha
                    texto="O post não sai em nenhum canal."
                    rotulo="Cancelar o post"
                    rotuloOcupado="Cancelando…"
                    voltar="Manter"
                    ocupado={cancelando === 'enviando'}
                    aoConfirmar={() => disparar(cancelar())}
                    aoCancelar={() => {
                      setCancelando('nao');
                      setFocarCancelar((n) => n + 1);
                    }}
                  />
                ))}
              {podeMudar && cancelando === 'nao' && (
                <button className="btn" type="button" data-po-mudar-hora aria-expanded={mudando} aria-controls={`${ids}-mudar`} onClick={() => setMudando((m) => !m)}>
                  <Icone nome="clock" pequeno />
                  Mudar a hora
                </button>
              )}
              {erroAoCancelar && (
                <p className="campo-erro" role="alert">
                  {erroAoCancelar}
                </p>
              )}
              <p className="nota">
                <Icone nome="info" />
                <span>
                  {podeCancelar ? 'Cancelar não pede o código do app: o post não sai.' : ''}
                  {podeCancelar && podeMudar ? ' ' : ''}
                  {podeMudar ? 'Mudar a hora pede o código do app de novo: a hora muda quem vê o post.' : ''}
                </span>
              </p>
            </div>
          )}
          {podeMudar && (
            <div id={`${ids}-mudar`} hidden={!mudando}>
              {mudando && <MudarAHora id={`${ids}-mudar-form`} post={post} agora={agora} aoMudar={(publishAt, codigo) => aoMudarAHora(acao, publishAt, codigo)} />}
            </div>
          )}
          {(post.status === 'nao_saiu' || post.status === 'em_parte') && podeVerContas && (
            <div className="desfazer">
              <Link className="btn" href="/contas">
                <Icone nome="plug" pequeno />
                Abrir Contas conectadas
              </Link>
            </div>
          )}
        </div>
        {previas}
      </>
    );
  }

  const parcial = aprovacaoParcial(acao);
  const tarde = horaJaPassou(post, agora);
  return (
    <>
      {voltar}
      {cabecalho}
      {!pro && (
        <div className="secao secao--lite">
          <p className="lite-frase lite-frase--grande">{p.resumo}</p>
          <div className="lite-chips">
            <span className="risco risco--medio">Post público</span>
            <span className="lite-chip">{prazo}</span>
          </div>
        </div>
      )}
      {tarde && (
        <p className="alerta-versao" role="status">
          <Icone nome="clock" pequeno />
          <span>A hora marcada ({quandoDoPost(post, agora)}) já passou. Aprovado agora, o post sai em seguida, entre 8h e 22h no fuso da empresa.</span>
        </p>
      )}
      <p className="plano-id">
        Plano {plano.plano} · hash <b>{plano.hash}</b> · a aprovação vale para este post nos canais escolhidos: mudar o texto, a foto ou os canais é outro pedido
      </p>
      {previas}
      <div className="secao">
        <p className="rotulo-marca">O que foi conferido</p>
        <p className="nota">
          <Icone nome="check-circle" />
          <span>A política conferiu os textos: nenhuma palavra que a empresa ou a marca não usam.</span>
        </p>
        <p className="nota">
          <Icone nome="image" />
          <span>A foto é uma das Fotos da marca, como ela é: sem edição e sem imagem feita por IA.</span>
        </p>
        <p className="nota">
          <Icone nome="clock" />
          <span>Na hora marcada, o Liame consulta o limite de posts do dia do Instagram e publica uma vez só em cada canal.</span>
        </p>
        <p className="nota">
          <Icone nome="undo" />
          <span>{p.desfazer}</span>
        </p>
        <p className="nota">
          <Icone nome="clock" />
          <span>Prazo: {prazo}. Se ninguém decidir, o pedido expira e nada é publicado.</span>
        </p>
      </div>
      {parcial && (
        <p className="alerta-versao" role="status">
          <Icone nome="info" pequeno />
          <span>{parcial}</span>
        </p>
      )}
      {podeDecidir ? (
        <BarraDaDecisao
          key={`${acao.id}:${acao.plan_hash}`}
          ids={ids}
          temApp={temApp}
          campoCodigo={campoCodigo}
          motivos={MOTIVOS}
          dica="O código de 6 números que o app autenticador mostra agora. A aprovação vale para este post: mudar o texto, a foto ou os canais é outro pedido."
          aoAprovar={(codigo) => aoAprovar(acao, codigo)}
          aoRecusar={(motivo) => aoRecusar(acao, motivo)}
        />
      ) : (
        <p className="nota ap-so-leitura">
          <Icone nome="lock" />
          <span>Só quem pode aprovar decide este pedido. Você acompanha por aqui.</span>
        </p>
      )}
    </>
  );
}
