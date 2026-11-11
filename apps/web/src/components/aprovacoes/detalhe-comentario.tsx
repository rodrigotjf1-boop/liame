'use client';

import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from 'react';
import type { Prova } from '@/lib/chave-de-acesso';
import { haQuanto } from '@/components/avaliacoes/textos';
import { Icone } from '@/components/ui/icone';
import { disparar } from '@/lib/disparar';
import { quandoComHora } from '@/lib/formato';
import { quemPediu } from './anuncio-textos';
import { BarraDaDecisao, type Decisao } from './barra-da-decisao';
import {
  type AcaoDeComentario,
  autorDo,
  fraseDoComentario,
  MOTIVOS_DE_OCULTAR,
  MOTIVOS_DO_COMENTARIO,
  ondeDo,
  operacaoDo,
  porQueOcultar,
  ROTULO_DO_CANAL,
  ROTULO_DO_TIPO,
  resultadoDoComentario,
  TAMANHO_DA_RESPOSTA_AO_COMENTARIO,
  textoDoComentarioValido,
  tituloDoComentario,
} from './comentario-textos';
import type { Feito } from './detalhe-mensagem';
import { Frase, FormularioDoTexto, Resultado, Voltar } from './detalhe-resposta';
import { ListaDasOpcoes } from './detalhe-sugestoes';
import { escolhaDe, type Opcao, outrasDe } from './sugestoes-textos';
import { type Grupo, identidadeDoPlano, prazoDe, riscoDe } from './textos';

// O pedido sobre um comentário do Instagram ou da Página aberto em Aprovações (mockups/prototipo-comentarios.html, P38
// aprovado em 07/11/2026; A6, Z11, parte 3a): "Responder ao comentário" e "Ocultar o comentário", como a resposta à
// avaliação (P17). Esperando a decisão: o comentário como o Liame o guarda e, ao lado, a resposta proposta (editável
// por quem pode pedir: a aprovação vale só para o texto salvo) ou o porquê de ocultar; o que foi conferido; e a
// aprovação com o código do app. Decidido: o resultado (saindo, respondido, oculto, retirado pelo Social media com o
// porquê, recusado) e o que foi pedido. A resposta é pública e sai em nome da marca.

export const DICA_DO_COMENTARIO = 'A resposta é pública. Sem desconto, brinde ou reembolso prometido, e sem o nome de quem comentou: o Compliance confere de novo quando você salvar.';
const motivosDe = (lista: string[]) => lista.map((m) => ({ valor: m, rotulo: m }));

/** O canal do comentário, com o ícone da rede (P38). Também na tela Comentários. */
export function Canal({ canal }: { canal: string }) {
  return (
    <span className={`co-canal co-canal--${canal === 'facebook' ? 'fb' : 'ig'}`}>
      <Icone nome={canal === 'facebook' ? 'facebook' : 'instagram'} pequeno />
      {ROTULO_DO_CANAL[canal] ?? canal}
    </span>
  );
}

/** "O comentário, como está no Instagram": o canal, quem comentou e há quanto tempo, o tipo, o texto e o post. */
export function BlocoDoComentario({ ids, acao, agora }: { ids: string; acao: AcaoDeComentario; agora: Date }) {
  const c = acao.comment;
  const atual = c.current;
  const autor = autorDo(acao);
  const tipo = atual?.kind ?? null;
  return (
    <section className="av-bloco" aria-labelledby={`${ids}-com`}>
      <h3 id={`${ids}-com`}>O comentário, como está {ondeDo(c.channel)}</h3>
      {atual ? (
        <>
          <div className="av-item-cab">
            <Canal canal={c.channel} />
            <span>{[autor, haQuanto(atual.published_at, agora)].filter(Boolean).join(' · ')}</span>
            {tipo && ROTULO_DO_TIPO[tipo] && <span className={`co-tipo co-tipo--${tipo === 'ofensivo' ? 'golpe' : tipo}`}>{ROTULO_DO_TIPO[tipo]}</span>}
            {atual.hidden && <span className="co-tipo">Oculto</span>}
          </div>
          <p className="av-fala">{atual.message}</p>
        </>
      ) : (
        <>
          <div className="av-item-cab">
            <Canal canal={c.channel} />
          </div>
          <p className="av-fala av-item-txt--vazio">O Liame não guarda mais este comentário: ele foi apagado na rede, a conta foi desligada ou passou o prazo de 90 dias.</p>
        </>
      )}
      {c.post && <p>No post: “{c.post.caption || 'sem legenda'}”.</p>}
    </section>
  );
}

type Props = {
  acao: AcaoDeComentario;
  grupo: Grupo | null;
  agora: Date;
  pro: boolean;
  /** Quem vê é quem pediu. */
  euPedi: boolean;
  /** Pode aprovar e recusar (`acoes.aprovar`). */
  podeDecidir: boolean;
  /** Pode pedir (`campanhas.operar`): editar o texto. */
  podeOperar: boolean;
  temApp: boolean;
  /** A pessoa tem chave de acesso: ela vem primeiro ao aprovar (D-A7-56). */
  temChave?: boolean;
  titulo: RefObject<HTMLHeadingElement | null>;
  campoCodigo: RefObject<HTMLInputElement | null>;
  aoVoltar: () => void;
  aoAprovar: (acao: AcaoDeComentario, prova: Prova) => Promise<Decisao>;
  aoRecusar: (acao: AcaoDeComentario, motivo: string) => Promise<Decisao>;
  /** Grava o texto do pedido (o editado, ou a sugestão escolhida, com o aviso que a tela mostra). */
  aoSalvarTexto: (acao: AcaoDeComentario, texto: string, aviso?: string) => Promise<Feito>;
  /** O "Pedir outra" (A6 · Z11, parte 3c), no pedido do Social media que tem sugestões. */
  aoPedirOutra: (acao: AcaoDeComentario) => Promise<Feito>;
  aoAvisar: (texto: string) => void;
};

export function DetalheComentario({
  acao,
  grupo,
  agora,
  pro,
  euPedi,
  podeDecidir,
  podeOperar,
  temApp,
  temChave = false,
  titulo,
  campoCodigo,
  aoVoltar,
  aoAprovar,
  aoRecusar,
  aoSalvarTexto,
  aoPedirOutra,
  aoAvisar,
}: Props) {
  const ids = useId();
  const quem = quemPediu(acao);
  const plano = identidadeDoPlano(acao);
  const prazo = prazoDe(acao, agora);
  const op = operacaoDo(acao);
  const ocultar = op === 'ocultar';
  const responder = op === 'responder';
  const onde = ondeDo(acao.comment.channel);
  const [editando, setEditando] = useState(false);
  const botaoEditar = useRef<HTMLButtonElement>(null);
  const voltarAoEditar = useRef(false);
  // As sugestões do Social media (a pergunta e a reclamação; A6 · Z11, parte 3c): escolher uma é alterar o texto do
  // pedido, como nas avaliações (P31); "Pedir outra" uma vez por comentário.
  const comSugestoes = responder && quem.funcionario && Boolean(acao.comment.suggestions?.length);
  const escolha = escolhaDe(acao.comment);
  const opcoes = [...(escolha.ajustada ? [escolha.ajustada] : []), ...escolha.novas];
  const outras = comSugestoes ? outrasDe(acao.comment, agora) : null;
  const umaNova = escolha.novas.length === 1;
  const [escolhendo, setEscolhendo] = useState<string | null>(null);
  const [pedindo, setPedindo] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const legenda = useRef<HTMLLegendElement | null>(null);
  const antes = useRef({ id: acao.id, outras });

  // Outro pedido aberto (ou o mesmo com outro texto): o que estava aberto era do anterior.
  useEffect(() => {
    setEditando(false);
  }, [acao.id, acao.plan_hash]);
  useEffect(() => {
    setEscolhendo(null);
    setPedindo(false);
    setErro(null);
  }, [acao.id]);
  // As novas chegaram (ou não deu) NESTE pedido: o aviso, e o foco vai para a lista, se ele não estiver num campo.
  useEffect(() => {
    const anterior = antes.current;
    antes.current = { id: acao.id, outras };
    if (anterior.id !== acao.id) return;
    const eraEscrevendo = anterior.outras === 'escrevendo' || anterior.outras === 'demorando';
    if (!eraEscrevendo || (outras !== 'feitas' && outras !== 'nao_deu')) return;
    if (outras === 'feitas') aoAvisar(umaNova ? 'Uma sugestão nova. A primeira continua abaixo.' : 'Sugestões novas, uma para cada caminho. As primeiras continuam abaixo.');
    else aoAvisar('Não deu para escrever outra sugestão. As primeiras continuam abaixo.');
    const ativo = document.activeElement;
    if (!ativo || ativo === document.body || !ativo.closest('input, textarea, select')) legenda.current?.focus();
  }, [acao.id, outras, umaNova, aoAvisar]);

  async function escolher(o: Opcao) {
    if (escolhendo || o.chave === escolha.escolhida) return;
    setEscolhendo(o.chave);
    setErro(null);
    const nomeDela = o.chave === escolha.ajustada?.chave ? 'A versão ajustada' : o.rotulo.split(' · ')[0];
    const r = await aoSalvarTexto(acao, o.texto, `${nomeDela} escolhida. A aprovação vale para ela.`);
    setEscolhendo(null);
    if (!r.ok) setErro(r.texto);
  }

  async function pedirOutra() {
    setPedindo(true);
    setErro(null);
    const r = await aoPedirOutra(acao);
    setPedindo(false);
    if (!r.ok) setErro(r.texto);
  }
  // Quem cancela a edição volta ao botão que a abriu (depois de ele voltar à tela).
  useEffect(() => {
    if (!editando && voltarAoEditar.current) {
      voltarAoEditar.current = false;
      botaoEditar.current?.focus();
    }
  }, [editando]);

  const cabecalho = (
    <>
      <div className="det-cab">
        <span>
          <b>{quem.nome}</b> {quem.funcionario ? 'sugeriu' : 'pediu'}
        </span>
        <span>
          · {quandoComHora(acao.created_at, agora)}
          {quem.funcionario ? ' · funcionário de IA' : euPedi ? ' · escrita por você' : ''}
        </span>
      </div>
      <h2 className="det-titulo" id="ap-det-titulo" ref={titulo} tabIndex={-1}>
        {tituloDoComentario(acao)}
      </h2>
    </>
  );

  const lado: ReactNode = ocultar ? (
    <section className="av-bloco" aria-labelledby={`${ids}-por`}>
      <h3 id={`${ids}-por`}>Por que ocultar</h3>
      <p className="av-fala">{porQueOcultar(acao)}</p>
      <p>Os outros deixam de ver o comentário no post; dá para mostrar de novo, também com o código do app. O Liame não apaga comentário.</p>
    </section>
  ) : (
    <section className="av-bloco" aria-labelledby={`${ids}-resp`}>
      <h3 id={`${ids}-resp`}>
        {op === 'apagar_resposta'
          ? 'A resposta que sai do comentário'
          : grupo !== 'pendente'
            ? 'A resposta'
            : comSugestoes && !editando
              ? escolha.total === 1
                ? 'A sugestão do Social media'
                : 'As sugestões do Social media'
              : quem.funcionario
                ? 'A resposta proposta'
                : 'A sua resposta'}
      </h3>
      {grupo === 'pendente' && outras === 'escrevendo' ? (
        <div className="av-sug-escrevendo" role="status" id="co-sug-escrevendo">
          <span className="av-sug-giro" aria-hidden="true" />
          <span>O Social media está escrevendo {umaNova ? 'outra sugestão' : 'outras sugestões, uma para cada caminho'}. Costuma levar menos de um minuto; as primeiras continuam guardadas.</span>
        </div>
      ) : grupo === 'pendente' && comSugestoes && !editando ? (
        <>
          <ListaDasOpcoes
            ids={ids}
            opcoes={opcoes}
            daPrimeira={escolha.daPrimeira}
            escolhida={escolhendo ?? escolha.escolhida}
            soLeitura={!podeOperar}
            ocupado={escolhendo !== null}
            legenda={legenda}
            maximo={TAMANHO_DA_RESPOSTA_AO_COMENTARIO}
            aoEscolher={(o) => disparar(escolher(o))}
          />
          {(outras === 'demorando' || outras === 'nao_deu') && (
            <p className="nota" id="co-sug-outras">
              <Icone nome={outras === 'demorando' ? 'clock' : 'info'} />
              <span>
                {outras === 'demorando'
                  ? 'A sugestão nova está demorando mais que o normal. O Social media continua tentando, e ela aparece aqui quando ficar pronta; enquanto isso, dá para decidir com estas.'
                  : 'Não deu para escrever outra sugestão. Para outro texto, edite o texto escolhido.'}
              </span>
            </p>
          )}
          {podeOperar && (
            <div className="av-sug-acoes">
              <button ref={botaoEditar} className="btn btn--sm" type="button" data-co-editar onClick={() => setEditando(true)}>
                <Icone nome="pencil" pequeno />
                Editar o texto escolhido
              </button>
              {outras === 'pode_pedir' && (
                <button className="btn btn--sm" type="button" data-co-outra disabled={pedindo} aria-busy={pedindo || undefined} onClick={() => disparar(pedirOutra())}>
                  <Icone nome="refresh" pequeno />
                  {pedindo ? 'Pedindo…' : umaNova ? 'Pedir outra sugestão' : 'Pedir outras sugestões'}
                </button>
              )}
            </div>
          )}
          {erro && (
            <p className="campo-erro" role="alert" id="co-sug-erro">
              {erro}
            </p>
          )}
          {podeOperar && outras === 'feitas' && <p className="av-sug-conta">Esta é a segunda rodada: para outro texto, edite o texto escolhido.</p>}
          <p>{acao.comment.channel === 'facebook' ? 'A escolhida sai como resposta da Página ao comentário.' : 'A escolhida sai como resposta ao comentário, em nome da marca. O Instagram avisa quem comentou.'}</p>
        </>
      ) : editando ? (
        <FormularioDoTexto
          ids={ids}
          inicial={acao.comment.reply_text ?? ''}
          podeCancelar
          dica={DICA_DO_COMENTARIO}
          maximo={TAMANHO_DA_RESPOSTA_AO_COMENTARIO}
          validar={textoDoComentarioValido}
          aoSalvar={async (texto) => {
            const r = await aoSalvarTexto(acao, texto);
            if (r.ok) setEditando(false);
            return r;
          }}
          aoCancelar={() => {
            voltarAoEditar.current = true;
            setEditando(false);
          }}
        />
      ) : (
        <>
          <p className="av-fala av-fala--resposta" id="co-resposta">
            {acao.comment.reply_text ?? 'Sem o texto da resposta.'}
          </p>
          {responder && <p>{acao.comment.channel === 'facebook' ? 'Sai como resposta da Página ao comentário.' : 'Sai como resposta ao comentário, em nome da marca. O Instagram avisa quem comentou.'}</p>}
          {grupo === 'pendente' && podeOperar && responder && (
            <div>
              <button ref={botaoEditar} className="btn btn--sm" type="button" data-co-editar onClick={() => setEditando(true)}>
                <Icone nome="pencil" pequeno />
                Editar o texto
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
  const dois = (
    <div className="av-dois">
      <BlocoDoComentario ids={ids} acao={acao} agora={agora} />
      {lado}
    </div>
  );

  if (grupo !== 'pendente') {
    return (
      <>
        <Voltar aoVoltar={aoVoltar} />
        {cabecalho}
        <p className="plano-id">Plano {plano.plano}</p>
        <div className="secao">
          <Resultado id="co-resultado" {...resultadoDoComentario(acao)} />
        </div>
        <div className="secao">
          <p className="rotulo-marca">O que foi pedido</p>
          {dois}
        </div>
      </>
    );
  }

  const risco = riscoDe(acao);
  const rotuloDoRisco = risco === 'alto' ? 'Risco alto' : risco === 'medio' ? 'Risco médio' : 'Risco baixo';
  return (
    <>
      <Voltar aoVoltar={aoVoltar} />
      {cabecalho}
      {acao.comment.changed && (
        <div className="secao secao--lite">
          <div className="resultado resultado--falha" role="alert" id="co-mudou">
            <Icone nome="alert" />
            <span>
              <b>O comentário mudou depois deste pedido.</b> {ocultar ? 'O pedido era para o comentário de antes' : 'A resposta foi escrita para o comentário de antes'}: aprovado assim, nada é feito. Recuse e, se for o caso, peça de novo.
            </span>
          </div>
        </div>
      )}
      {!pro && (
        <div className="secao secao--lite">
          <p className="lite-frase lite-frase--grande">
            <Frase pedacos={fraseDoComentario(acao, { euPedi, possoAprovar: podeDecidir, possoMexer: podeOperar })} />
          </p>
          <div className="lite-chips">
            <span className={`risco risco--${risco}`}>{rotuloDoRisco}</span>
            <span className="lite-chip">{ocultar ? 'Reversível' : 'Resposta pública'}</span>
            <span className="lite-chip">{prazo}</span>
          </div>
        </div>
      )}
      <p className="plano-id">
        Plano {plano.plano} · {ocultar ? 'a aprovação vale só para ocultar este comentário' : 'a aprovação vale só para este texto: mudou o texto, é outro pedido'}
      </p>
      <div className="secao">{dois}</div>
      <div className="secao">
        <p className="rotulo-marca">O que foi conferido</p>
        {ocultar ? (
          <>
            <p className="nota">
              <Icone nome="check-circle" />
              <span>A regra do Liame marcou o comentário; o porquê está ao lado.</span>
            </p>
            <p className="nota">
              <Icone nome="undo" />
              <span>Dá para mostrar de novo depois, também com o código do app.</span>
            </p>
            <p className="nota">
              <Icone nome="info" />
              <span>Comentário oculto não pode ser respondido (regra da Meta).</span>
            </p>
          </>
        ) : (
          <>
            <p className="nota">
              <Icone nome="check-circle" />
              <span>O Compliance conferiu o texto: não promete desconto, brinde nem reembolso, não cita quem comentou e não traz dado pessoal.</span>
            </p>
            <p className="nota">
              <Icone nome="reply" />
              <span>{acao.comment.channel === 'facebook' ? 'Na Página, a resposta sai como a Página.' : 'No Instagram, a resposta vai sempre no comentário principal (regra da Meta).'}</span>
            </p>
            <p className="nota">
              <Icone nome="info" />
              <span>Sai uma vez. Se o comentário for apagado ou ocultado {onde} antes, nada é publicado.</span>
            </p>
          </>
        )}
        <p className="nota">
          <Icone nome="clock" />
          <span>Prazo: {prazo}. Se ninguém decidir, o pedido expira e nada é feito.</span>
        </p>
      </div>
      {!podeDecidir ? (
        <p className="nota ap-so-leitura">
          <Icone nome="lock" />
          <span>Só quem pode aprovar decide este pedido. Você acompanha por aqui.</span>
        </p>
      ) : outras === 'escrevendo' ? (
        <div className="secao">
          <p className="nota">
            <Icone nome="info" />
            <span>{umaNova ? 'Espere a sugestão nova para aprovar.' : 'Espere as sugestões novas para aprovar.'}</span>
          </p>
        </div>
      ) : editando ? (
        <div className="secao">
          <p className="nota">
            <Icone nome="info" />
            <span>Salve o texto para poder aprovar.</span>
          </p>
        </div>
      ) : (
        <BarraDaDecisao
          key={`${acao.id}:${acao.plan_hash}`}
          ids={ids}
          temApp={temApp}
          temChave={temChave}
          campoCodigo={campoCodigo}
          motivos={motivosDe(ocultar ? MOTIVOS_DE_OCULTAR : MOTIVOS_DO_COMENTARIO)}
          dica={ocultar ? 'O código de 6 números que o app autenticador mostra agora. A aprovação vale só para ocultar este comentário.' : 'O código de 6 números que o app autenticador mostra agora. A aprovação vale só para este texto.'}
          aoAprovar={(prova) => aoAprovar(acao, prova)}
          aoRecusar={(motivo) => aoRecusar(acao, motivo)}
        />
      )}
    </>
  );
}
