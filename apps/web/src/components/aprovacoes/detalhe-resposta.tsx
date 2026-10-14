'use client';

import type { ReviewItem } from '@liame/contracts';
import { type FormEvent, type ReactNode, type RefObject, useEffect, useId, useRef, useState } from 'react';
import { Estrelas } from '@/components/avaliacoes/avaliacoes-conteudo';
import { haQuanto } from '@/components/avaliacoes/textos';
import { ConfirmaNaLinha } from '@/components/ui/confirma-na-linha';
import { Icone } from '@/components/ui/icone';
import { disparar } from '@/lib/disparar';
import { quandoComHora } from '@/lib/formato';
import { quemPediu } from './anuncio-textos';
import { BarraDaDecisao, type Decisao } from './barra-da-decisao';
import type { Feito } from './detalhe-mensagem';
import {
  type AcaoDeResposta,
  type Apagada,
  ehApagar,
  emNomeDa,
  estrelasDoPedido,
  estrelasEscritas,
  fraseDaResposta,
  MOTIVOS_DA_RESPOSTA,
  type Pedaco,
  podeEscreverOutra,
  resultadoDaResposta,
  riscoDaResposta,
  situacaoDaResposta,
  TAMANHO_DA_RESPOSTA,
  textoDaRespostaValido,
  tituloDaResposta,
} from './resposta-textos';
import { type Grupo, identidadeDoPlano, prazoDe } from './textos';

// A resposta a uma avaliação do Google aberta em Aprovações (mockups/prototipo-avaliacoes.html, P17 aprovado em
// 09/10/2026). Esperando a decisão: a avaliação como o Liame a guarda e a resposta, lado a lado; o texto editável por
// quem pode pedir (a aprovação vale só para o texto salvo); "só o dono aprova" na de 1 ou 2 estrelas; o que foi
// conferido; e a aprovação com o código do app. Decidido: o resultado, com a conferência do Google, e "Apagar a
// resposta", que é direto (confirmação na linha, sem código). O rascunho é a resposta que a pessoa escreve antes de o
// pedido existir: ele nasce quando ela salva o texto.

const MOTIVOS = MOTIVOS_DA_RESPOSTA.map((m) => ({ valor: m, rotulo: m }));
const DICA_DO_TEXTO = 'A resposta é pública. Sem desconto, brinde ou reembolso prometido aqui, e sem o nome de quem avaliou: o Compliance confere de novo quando você salvar.';

function Frase({ pedacos }: { pedacos: Pedaco[] }) {
  return <>{pedacos.map((p, i) => (p.b ? <b key={i}>{p.t}</b> : <span key={i}>{p.t}</span>))}</>;
}

/** "A avaliação, como está no Google": as estrelas, quem avaliou (quando o Google informou agora), há quanto tempo e o texto. */
function BlocoDaAvaliacao({ ids, avaliacao, estrelas, nome, agora }: { ids: string; avaliacao: ReviewItem | null; estrelas: number | null; nome: string | null; agora: Date }) {
  return (
    <section className="av-bloco" aria-labelledby={`${ids}-av`}>
      <h3 id={`${ids}-av`}>A avaliação, como está no Google</h3>
      {avaliacao ? (
        <>
          <div className="av-item-cab">
            <Estrelas n={avaliacao.stars} />
            <span>{[nome, haQuanto(avaliacao.reviewed_at, agora)].filter(Boolean).join(' · ')}</span>
          </div>
          <p className={avaliacao.text ? 'av-fala' : 'av-fala av-item-txt--vazio'}>{avaliacao.text ?? 'Só a nota, sem texto.'}</p>
        </>
      ) : (
        <>
          {estrelas && (
            <div className="av-item-cab">
              <Estrelas n={estrelas} />
              {nome && <span>{nome}</span>}
            </div>
          )}
          <p className="av-fala av-item-txt--vazio">O Liame não guarda mais esta avaliação: ela tem mais de 12 meses, ou saiu do Google.</p>
        </>
      )}
    </section>
  );
}

/** O texto da resposta sendo escrito ou editado. Abre com o foco no campo; salvar manda para o servidor conferir. */
function FormularioDoTexto({
  ids,
  inicial,
  podeCancelar,
  aoSalvar,
  aoCancelar,
}: {
  ids: string;
  inicial: string;
  podeCancelar: boolean;
  aoSalvar: (texto: string) => Promise<Feito>;
  aoCancelar: () => void;
}) {
  const campo = useRef<HTMLTextAreaElement>(null);
  const [texto, setTexto] = useState(inicial);
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  useEffect(() => {
    campo.current?.focus();
  }, []);
  // O erro do servidor chega depois de o campo ser liberado: o foco volta para ele (V82).
  useEffect(() => {
    if (erro && !ocupado) campo.current?.focus();
  }, [erro, ocupado]);

  async function salvar(e: FormEvent) {
    e.preventDefault();
    const invalido = textoDaRespostaValido(texto);
    if (invalido) return setErro(invalido);
    setErro(null);
    setOcupado(true);
    const r = await aoSalvar(texto.trim());
    setOcupado(false);
    if (!r.ok) setErro(r.texto);
  }

  return (
    <form className="av-editar" onSubmit={(e) => disparar(salvar(e))} noValidate>
      <label className="sr-only" htmlFor={`${ids}-texto`}>
        Texto da resposta
      </label>
      <textarea
        ref={campo}
        id={`${ids}-texto`}
        maxLength={TAMANHO_DA_RESPOSTA}
        value={texto}
        disabled={ocupado}
        aria-invalid={erro ? true : undefined}
        aria-describedby={erro ? `${ids}-texto-erro` : `${ids}-texto-dica`}
        onChange={(e) => {
          setTexto(e.target.value);
          setErro(null);
        }}
      />
      {erro ? (
        <p className="campo-erro" id={`${ids}-texto-erro`} role="alert">
          {erro}
        </p>
      ) : (
        <p className="eixo-nota" id={`${ids}-texto-dica`}>
          {DICA_DO_TEXTO}
        </p>
      )}
      <div className="av-editar-acoes">
        <button className="btn btn--primary btn--sm" type="submit" disabled={ocupado} aria-busy={ocupado}>
          {ocupado ? 'Salvando…' : 'Salvar o texto'}
        </button>
        {podeCancelar && (
          <button className="btn btn--sm" type="button" onClick={aoCancelar} disabled={ocupado}>
            Cancelar
          </button>
        )}
      </div>
    </form>
  );
}

function Voltar({ aoVoltar }: { aoVoltar: () => void }) {
  return (
    <button className="btn btn--ghost btn--sm voltar" type="button" onClick={aoVoltar}>
      <Icone nome="chevron-left" />
      Voltar para a lista
    </button>
  );
}

function Resultado({ id, tom, icone, forte, texto }: ReturnType<typeof resultadoDaResposta> & { id: string }) {
  return (
    <div className={tom === 'neutro' ? 'resultado' : `resultado resultado--${tom}`} role={tom === 'falha' ? 'alert' : tom === 'espera' ? 'status' : undefined} id={id}>
      <Icone nome={icone} />
      <span>
        {forte && <b>{forte}</b>}
        {texto}
      </span>
    </div>
  );
}

type Props = {
  acao: AcaoDeResposta;
  grupo: Grupo | null;
  agora: Date;
  pro: boolean;
  /** O nome de quem avaliou, lido do Google na hora; nulo quando ele não informou (ou a leitura não voltou). */
  nome: string | null;
  /** Quem vê é quem pediu. */
  euPedi: boolean;
  /** Quem vê é o dono da empresa: é ele que decide a resposta a 1 ou 2 estrelas. */
  souDono: boolean;
  /** Pode aprovar e recusar (`acoes.aprovar`). */
  podeDecidir: boolean;
  /** Pode pedir (`campanhas.operar`): editar o texto, apagar a resposta, escrever outra. */
  podeOperar: boolean;
  temApp: boolean;
  /** Quem apagou a resposta e quando (o pedido de volta que a lista traz). */
  apagada: Apagada;
  titulo: RefObject<HTMLHeadingElement | null>;
  campoCodigo: RefObject<HTMLInputElement | null>;
  aoVoltar: () => void;
  aoAprovar: (acao: AcaoDeResposta, codigo: string) => Promise<Decisao>;
  aoRecusar: (acao: AcaoDeResposta, motivo: string) => Promise<Decisao>;
  aoSalvarTexto: (acao: AcaoDeResposta, texto: string) => Promise<Feito>;
  aoApagar: (acao: AcaoDeResposta) => Promise<Feito>;
  aoEscreverOutra: (acao: AcaoDeResposta) => void;
};

export function DetalheResposta({
  acao,
  grupo,
  agora,
  pro,
  nome,
  euPedi,
  souDono,
  podeDecidir,
  podeOperar,
  temApp,
  apagada,
  titulo,
  campoCodigo,
  aoVoltar,
  aoAprovar,
  aoRecusar,
  aoSalvarTexto,
  aoApagar,
  aoEscreverOutra,
}: Props) {
  const ids = useId();
  const quem = quemPediu(acao);
  const plano = identidadeDoPlano(acao);
  const prazo = prazoDe(acao, agora);
  const estrelas = estrelasDoPedido(acao);
  const soDoDono = acao.review.owner_only;
  const esperaODono = soDoDono && !souDono;
  const podeMexer = podeOperar && !esperaODono;
  const [editando, setEditando] = useState(false);
  const [apagando, setApagando] = useState<'nao' | 'confirmando' | 'enviando'>('nao');
  const [erroAoApagar, setErroAoApagar] = useState<string | null>(null);
  const botaoEditar = useRef<HTMLButtonElement>(null);
  const botaoApagar = useRef<HTMLButtonElement>(null);
  const voltarAoEditar = useRef(false);

  // Outro pedido aberto (ou o mesmo com outro texto): o que estava aberto era do anterior.
  useEffect(() => {
    setEditando(false);
    setApagando('nao');
    setErroAoApagar(null);
  }, [acao.id, acao.plan_hash]);
  // Quem cancela a edição volta ao botão que a abriu (depois de ele voltar à tela).
  useEffect(() => {
    if (!editando && voltarAoEditar.current) {
      voltarAoEditar.current = false;
      botaoEditar.current?.focus();
    }
  }, [editando]);

  async function apagar() {
    setApagando('enviando');
    setErroAoApagar(null);
    const r = await aoApagar(acao);
    setApagando('nao');
    if (!r.ok) setErroAoApagar(r.texto);
  }

  const cabecalho = (
    <>
      <div className="det-cab">
        <span>
          <b>{quem.nome}</b> pediu
        </span>
        <span>
          · {quandoComHora(acao.created_at, agora)}
          {quem.funcionario ? ' · funcionário de IA' : euPedi ? ' · escrita por você' : ''}
        </span>
      </div>
      <h2 className="det-titulo" id="ap-det-titulo" ref={titulo} tabIndex={-1}>
        {tituloDaResposta(acao, nome)}
      </h2>
    </>
  );

  const resposta: ReactNode = (
    <section className="av-bloco" aria-labelledby={`${ids}-resp`}>
      <h3 id={`${ids}-resp`}>{ehApagar(acao) ? 'A resposta que sai do perfil' : grupo === 'pendente' ? 'A resposta proposta' : 'A resposta'}</h3>
      {editando ? (
        <FormularioDoTexto
          ids={ids}
          inicial={acao.review.reply_text ?? ''}
          podeCancelar
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
          <p className="av-fala av-fala--resposta" id="av-resposta">
            {acao.review.reply_text ?? 'Sem o texto da resposta.'}
          </p>
          {!ehApagar(acao) && <p>Aparece embaixo da avaliação, {emNomeDa(acao)}. Quem avaliou é avisado pelo Google quando a resposta sai.</p>}
          {grupo === 'pendente' && podeMexer && !ehApagar(acao) && (
            <div>
              <button ref={botaoEditar} className="btn btn--sm" type="button" data-av-editar onClick={() => setEditando(true)}>
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
      <BlocoDaAvaliacao ids={ids} avaliacao={acao.review.current} estrelas={estrelas} nome={nome} agora={agora} />
      {resposta}
    </div>
  );

  if (grupo !== 'pendente') {
    const s = situacaoDaResposta(acao);
    const r = resultadoDaResposta(acao, apagada, pro);
    const mostraApagar = s === 'publicada' && podeMexer;
    const outra = podeMexer && podeEscreverOutra(acao);
    return (
      <>
        <Voltar aoVoltar={aoVoltar} />
        {cabecalho}
        <p className="plano-id">Plano {plano.plano}</p>
        <div className="secao">
          <Resultado id="av-resultado" {...r} />
          {mostraApagar && (
            <div className="desfazer">
              {apagando === 'nao' ? (
                <button ref={botaoApagar} className="btn" type="button" data-av-apagar onClick={() => setApagando('confirmando')}>
                  <Icone nome="undo" pequeno />
                  Apagar a resposta
                </button>
              ) : (
                <ConfirmaNaLinha
                  texto="A resposta sai do perfil no Google. Quem avaliou já foi avisado dela."
                  rotulo="Apagar a resposta"
                  rotuloOcupado="Apagando…"
                  voltar="Manter"
                  ocupado={apagando === 'enviando'}
                  aoConfirmar={() => disparar(apagar())}
                  aoCancelar={() => {
                    setApagando('nao');
                    requestAnimationFrame(() => botaoApagar.current?.focus());
                  }}
                />
              )}
              {erroAoApagar && (
                <p className="campo-erro" role="alert">
                  {erroAoApagar}
                </p>
              )}
              <p className="nota">
                <Icone nome="info" />
                <span>Apagar tira a resposta do perfil. Não desfaz o aviso que quem avaliou já recebeu.</span>
              </p>
            </div>
          )}
          {outra && (
            <div className="desfazer">
              <button className="btn" type="button" data-av-outra onClick={() => aoEscreverOutra(acao)}>
                <Icone nome="pencil" pequeno />
                {s === 'recusada-google' ? 'Editar e pedir de novo' : 'Escrever outra resposta'}
              </button>
            </div>
          )}
        </div>
        <div className="secao">
          <p className="rotulo-marca">O que foi pedido</p>
          {dois}
        </div>
      </>
    );
  }

  const risco = riscoDaResposta(acao);
  return (
    <>
      <Voltar aoVoltar={aoVoltar} />
      {cabecalho}
      {esperaODono && (
        <div className="secao secao--lite">
          <div className="resultado resultado--espera" role="status">
            <Icone nome="lock" />
            <span>
              <b id="av-dono-t">Esta resposta espera o dono.</b> Resposta a avaliação de 1 ou 2 estrelas só sai com a aprovação do dono da empresa. Você pode ler; não pode aprovar, recusar nem editar.
            </span>
          </div>
        </div>
      )}
      {acao.review.changed && (
        <div className="secao secao--lite">
          <div className="resultado resultado--falha" role="alert" id="av-mudou">
            <Icone nome="alert" />
            <span>
              <b>A avaliação mudou depois deste pedido.</b> A resposta foi escrita para a avaliação de antes: aprovada assim, ela não é publicada. Recuse e escreva outra.
            </span>
          </div>
        </div>
      )}
      {!pro && (
        <div className="secao secao--lite">
          <p className="lite-frase lite-frase--grande">
            <Frase pedacos={fraseDaResposta(acao, nome, { euPedi, possoAprovar: podeDecidir && !esperaODono })} />
          </p>
          <div className="lite-chips">
            <span className={`risco risco--${risco.classe}`}>{risco.rotulo}</span>
            <span className="lite-chip">Resposta pública</span>
            <span className="lite-chip">{prazo}</span>
          </div>
        </div>
      )}
      <p className="plano-id">Plano {plano.plano} · a aprovação vale só para este texto: mudou o texto, é outro pedido</p>
      <div className="secao">{dois}</div>
      {soDoDono && souDono && (
        <div className="secao">
          <div className="politica">
            <Icone nome="shield" />
            <span>
              <b className="risco risco--alto">Só o dono aprova.</b> É uma avaliação de {estrelas ? estrelasEscritas(estrelas) : '1 ou 2 estrelas'}: a resposta só sai com a sua aprovação, e não com a de outro aprovador.
            </span>
          </div>
        </div>
      )}
      <div className="secao">
        <p className="rotulo-marca">O que foi conferido</p>
        <p className="nota">
          <Icone nome="check-circle" />
          <span>O Compliance conferiu o texto: não promete desconto, brinde nem reembolso, não cita o nome de quem avaliou e não traz dado pessoal.</span>
        </p>
        <p className="nota">
          <Icone nome="info" />
          <span>O Google também confere a resposta antes de mostrar. Se ele recusar, o motivo aparece aqui.</span>
        </p>
        <p className="nota">
          <Icone nome="undo" />
          <span>Depois de publicada, dá para apagar a resposta. Quem avaliou já terá sido avisado.</span>
        </p>
        <p className="nota">
          <Icone nome="clock" />
          <span>Prazo: {prazo}. Se ninguém decidir, o pedido expira e nada é publicado.</span>
        </p>
      </div>
      {esperaODono ? null : !podeDecidir ? (
        <p className="nota ap-so-leitura">
          <Icone nome="lock" />
          <span>Só quem pode aprovar decide este pedido. Você acompanha por aqui.</span>
        </p>
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
          campoCodigo={campoCodigo}
          motivos={MOTIVOS}
          dica="O código de 6 números que o app autenticador mostra agora. A aprovação vale só para este texto."
          aoAprovar={(codigo) => aoAprovar(acao, codigo)}
          aoRecusar={(motivo) => aoRecusar(acao, motivo)}
        />
      )}
    </>
  );
}

/** A avaliação que vai ganhar a resposta escrita pela pessoa, antes de o pedido existir. */
export type Rascunho = {
  avaliacao: ReviewItem;
  /** O nome da loja do perfil, para a frase "em nome da loja". */
  loja: string | null;
  /** O texto com que o campo abre (vazio, ou o da resposta que o Google recusou). */
  textoInicial: string;
  /** O pedido de resposta que já espera a aprovação para esta avaliação, se houver. */
  pendente: string | null;
};

/** A resposta que a pessoa escreve (P17, estado "escrever"): o pedido nasce quando ela salva o texto, e aí é aprovado. */
export function RascunhoDaResposta({
  rascunho,
  nome,
  meuNome,
  agora,
  podeOperar,
  titulo,
  aoVoltar,
  aoSalvar,
  aoAbrirPendente,
}: {
  rascunho: Rascunho;
  nome: string | null;
  meuNome: string;
  agora: Date;
  podeOperar: boolean;
  titulo: RefObject<HTMLHeadingElement | null>;
  aoVoltar: () => void;
  aoSalvar: (texto: string) => Promise<Feito>;
  aoAbrirPendente: (id: string) => void;
}) {
  const ids = useId();
  const a = rascunho.avaliacao;
  const loja = rascunho.loja ? `em nome da loja “${rascunho.loja}”` : 'em nome da empresa';
  const jaRespondida = a.reply && a.reply.state !== 'recusada';
  return (
    <>
      <Voltar aoVoltar={aoVoltar} />
      <div className="det-cab">
        <span>
          <b>{meuNome}</b> vai pedir
        </span>
        <span>· {quandoComHora(agora.toISOString(), agora)} · escrita por você</span>
      </div>
      <h2 className="det-titulo" id="ap-det-titulo" ref={titulo} tabIndex={-1}>
        {nome ? `Responder à avaliação de ${nome}` : `Responder a uma avaliação de ${estrelasEscritas(a.stars)}`}
      </h2>
      <div className="secao secao--lite">
        <p className="lite-frase lite-frase--grande">
          Você vai responder à avaliação de <b>{estrelasEscritas(a.stars)}</b>
          {nome ? ` que ${nome} deixou` : ''}. A resposta é <b>pública</b> e sai {loja}.
        </p>
      </div>
      {rascunho.pendente ? (
        <div className="secao">
          <div className="resultado resultado--espera" role="status" id="av-ja-espera">
            <Icone nome="clock" />
            <span>
              <b>Esta avaliação já tem uma resposta esperando a aprovação.</b> Abra a que existe para ler, editar ou decidir.
            </span>
          </div>
          <div className="desfazer">
            <button className="btn btn--primary" type="button" onClick={() => aoAbrirPendente(rascunho.pendente!)}>
              Ver a resposta
            </button>
          </div>
        </div>
      ) : jaRespondida ? (
        <div className="secao">
          <div className="resultado" id="av-ja-respondida">
            <Icone nome="info" />
            <span>
              <b>Esta avaliação já tem resposta no Google.</b> {a.reply?.state === 'pendente' ? 'O Google ainda confere a resposta.' : 'Para trocar, apague a resposta que está lá.'}
            </span>
          </div>
        </div>
      ) : !podeOperar ? (
        <p className="nota ap-so-leitura">
          <Icone nome="lock" />
          <span>O seu nível nesta empresa não pede ações. Quem pode pedir escreve a resposta.</span>
        </p>
      ) : null}
      <div className="secao">
        <div className="av-dois">
          <BlocoDaAvaliacao ids={ids} avaliacao={a} estrelas={a.stars} nome={nome} agora={agora} />
          <section className="av-bloco" aria-labelledby={`${ids}-sua`}>
            <h3 id={`${ids}-sua`}>A sua resposta</h3>
            {!rascunho.pendente && !jaRespondida && podeOperar ? (
              <FormularioDoTexto ids={ids} inicial={rascunho.textoInicial} podeCancelar={false} aoSalvar={aoSalvar} aoCancelar={aoVoltar} />
            ) : (
              <p className="av-fala av-item-txt--vazio">Nada a escrever aqui agora.</p>
            )}
          </section>
        </div>
      </div>
      {!rascunho.pendente && !jaRespondida && podeOperar && (
        <div className="secao">
          <p className="nota">
            <Icone nome="info" />
            <span>Salve o texto para poder aprovar. A aprovação pede o código do app e vale só para o texto salvo.</span>
          </p>
        </div>
      )}
    </>
  );
}
