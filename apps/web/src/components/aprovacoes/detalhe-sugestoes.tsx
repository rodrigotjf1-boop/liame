'use client';

import { type RefObject, useEffect, useId, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { disparar } from '@/lib/disparar';
import { quandoComHora } from '@/lib/formato';
import { BarraDaDecisao, type Decisao } from './barra-da-decisao';
import type { Feito } from './detalhe-mensagem';
import { BlocoDaAvaliacao, FormularioDoTexto, Frase, Resultado, Voltar } from './detalhe-resposta';
import { type AcaoDeResposta, emNomeDa, estrelasDoPedido, estrelasEscritas, podeEscreverOutra, riscoDaResposta, situacaoDaResposta, tituloDaResposta } from './resposta-textos';
import { contaDeCaracteres, escolhaDoPedido, fraseDasSugestoes, MOTIVOS_DAS_SUGESTOES, type Opcao, outrasNaTela, resultadoDasSugestoes } from './sugestoes-textos';
import { type Grupo, identidadeDoPlano, prazoDe } from './textos';

// O pedido do Social media em Aprovações (mockups/prototipo-respostas-sugeridas.html, P31 aprovado em 21/10/2026;
// A6 · Z6, parte 3c). Esperando a decisão: a avaliação e as sugestões lado a lado; a pessoa escolhe uma (escolher é
// alterar o texto do pedido, e a aprovação vale para o escolhido), ajusta o texto, escreve do zero ou pede outras (uma
// vez por avaliação); a de 1 ou 2 estrelas segue só com o dono. Decidido sem publicar (recusado, ou tirado daqui porque
// a avaliação mudou ou foi respondida no Google): o resultado e o que tinha sido sugerido. Os outros decididos são os
// da resposta (P17), em `DetalheResposta`.

const MOTIVOS = MOTIVOS_DAS_SUGESTOES.map((m) => ({ valor: m, rotulo: m }));

/**
 * As opções da escolha, para ler (quem não escolhe: os cartões, rotulados pelo título do bloco) ou para escolher (os
 * botões de opção, com a legenda "Escolha a resposta"). O P31 repetia o título do bloco numa legenda ("As sugestões do
 * Social media" duas vezes na leitura, e "A sugestão do Social media" duas vezes com uma sugestão só); aqui, não.
 */
function ListaDasOpcoes({
  ids,
  opcoes,
  daPrimeira,
  escolhida,
  soLeitura,
  ocupado,
  legenda,
  aoEscolher,
}: {
  ids: string;
  opcoes: Opcao[];
  daPrimeira: Opcao[];
  escolhida: string | null;
  soLeitura: boolean;
  ocupado: boolean;
  legenda: RefObject<HTMLLegendElement | null>;
  aoEscolher: (o: Opcao) => void;
}) {
  const cartao = (o: Opcao) => {
    const eh = o.chave === escolhida;
    const corpo = (
      <span className="av-sug-txt">
        <span className="av-sug-rot">{soLeitura && eh ? `${o.rotulo} · a escolhida` : o.rotulo}</span>
        <span className="av-sug-fala">{o.texto}</span>
        <span className="av-sug-conta">{contaDeCaracteres(o.texto)}</span>
      </span>
    );
    if (soLeitura)
      return (
        <div key={o.chave} className={eh ? 'av-sug av-sug--leitura av-sug--escolhida' : 'av-sug av-sug--leitura'}>
          {corpo}
        </div>
      );
    return (
      <label key={o.chave} className="av-sug">
        <input type="radio" name={`${ids}-escolha`} value={o.chave} checked={eh} onChange={() => aoEscolher(o)} data-sug-escolher={o.chave} />
        {corpo}
      </label>
    );
  };
  const antigas = daPrimeira.length ? (
    <>
      <p className="av-sug-sub">As da primeira rodada</p>
      {daPrimeira.map(cartao)}
    </>
  ) : null;
  if (soLeitura)
    return (
      <div className="av-sugs">
        {opcoes.map(cartao)}
        {antigas}
      </div>
    );
  return (
    <fieldset className="av-sugs" aria-busy={ocupado || undefined}>
      <legend className="av-sug-legenda" id="av-sug-legenda" tabIndex={-1} ref={legenda}>
        Escolha a resposta
      </legend>
      {opcoes.map(cartao)}
      {antigas}
    </fieldset>
  );
}

type Props = {
  acao: AcaoDeResposta;
  grupo: Grupo | null;
  agora: Date;
  pro: boolean;
  /** O nome de quem avaliou, lido do Google na hora; nulo quando ele não informou (ou a leitura não voltou). */
  nome: string | null;
  /** Quem vê é o dono da empresa: é ele que decide a resposta a 1 ou 2 estrelas. */
  souDono: boolean;
  /** Pode aprovar e recusar (`acoes.aprovar`). */
  podeDecidir: boolean;
  /** Pode pedir (`campanhas.operar`): escolher, ajustar, escrever do zero, pedir outras. */
  podeOperar: boolean;
  temApp: boolean;
  titulo: RefObject<HTMLHeadingElement | null>;
  campoCodigo: RefObject<HTMLInputElement | null>;
  aoVoltar: () => void;
  aoAprovar: (acao: AcaoDeResposta, codigo: string) => Promise<Decisao>;
  aoRecusar: (acao: AcaoDeResposta, motivo: string) => Promise<Decisao>;
  /** Grava o texto do pedido (a sugestão escolhida, ou a versão ajustada), com o aviso que a tela mostra. */
  aoAlterarTexto: (acao: AcaoDeResposta, texto: string, aviso: string) => Promise<Feito>;
  aoPedirOutras: (acao: AcaoDeResposta) => Promise<Feito>;
  aoEscreverOutra: (acao: AcaoDeResposta) => void;
  aoAvisar: (texto: string) => void;
};

export function DetalheSugestoes({
  acao,
  grupo,
  agora,
  pro,
  nome,
  souDono,
  podeDecidir,
  podeOperar,
  temApp,
  titulo,
  campoCodigo,
  aoVoltar,
  aoAprovar,
  aoRecusar,
  aoAlterarTexto,
  aoPedirOutras,
  aoEscreverOutra,
  aoAvisar,
}: Props) {
  const ids = useId();
  const plano = identidadeDoPlano(acao);
  const prazo = prazoDe(acao, agora);
  const estrelas = estrelasDoPedido(acao);
  const soDoDono = acao.review.owner_only;
  const esperaODono = soDoDono && !souDono;
  const podeMexer = podeOperar && !esperaODono;
  const escolha = escolhaDoPedido(acao);
  const opcoes = [...(escolha.ajustada ? [escolha.ajustada] : []), ...escolha.novas];
  const todas = [...opcoes, ...escolha.daPrimeira];
  const escolhida = todas.find((o) => o.chave === escolha.escolhida) ?? null;
  const outras = outrasNaTela(acao, agora);
  const umaSo = escolha.novas.length === 1;
  const [editando, setEditando] = useState<'ajustar' | 'zero' | null>(null);
  const [escolhendo, setEscolhendo] = useState<string | null>(null);
  const [pedindo, setPedindo] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const legenda = useRef<HTMLLegendElement | null>(null);
  const botaoAjustar = useRef<HTMLButtonElement>(null);
  const botaoZero = useRef<HTMLButtonElement>(null);
  const voltarPara = useRef<'ajustar' | 'zero' | 'legenda' | null>(null);
  const antes = useRef({ id: acao.id, outras });

  // Outro pedido aberto: o que estava aberto era do anterior. O mesmo pedido com outro plano (outra sugestão escolhida,
  // as outras que chegaram) só fecha a edição.
  useEffect(() => {
    setEditando(null);
    setEscolhendo(null);
    setPedindo(false);
    setErro(null);
  }, [acao.id]);
  // Quem fecha a edição volta ao botão que a abriu; quem salva, à lista das opções (depois de ela voltar à tela, V82).
  useEffect(() => {
    if (editando) return;
    const alvo = voltarPara.current;
    voltarPara.current = null;
    if (alvo === 'ajustar') botaoAjustar.current?.focus();
    else if (alvo === 'zero') botaoZero.current?.focus();
    else if (alvo === 'legenda') legenda.current?.focus();
  }, [editando]);
  // As outras chegaram (ou não deu) NESTE pedido: o aviso, e o foco vai para a lista, se ele não estiver num campo
  // (P31). Trocar de pedido não é chegada: a comparação é com o mesmo pedido.
  useEffect(() => {
    const anterior = antes.current;
    antes.current = { id: acao.id, outras };
    if (anterior.id !== acao.id) return;
    const eraEscrevendo = anterior.outras === 'escrevendo' || anterior.outras === 'demorando';
    if (!eraEscrevendo || (outras !== 'feitas' && outras !== 'nao_deu')) return;
    if (outras === 'feitas') aoAvisar(umaSo ? 'Uma sugestão nova. A primeira continua abaixo.' : 'Duas sugestões novas. As primeiras continuam abaixo.');
    else aoAvisar('Não deu para escrever outras sugestões. As primeiras continuam abaixo.');
    const ativo = document.activeElement;
    if (!ativo || ativo === document.body || !ativo.closest('input, textarea, select')) legenda.current?.focus();
  }, [acao.id, outras, umaSo, aoAvisar]);

  const cabecalho = (
    <>
      <div className="det-cab">
        <span>
          <b>Social media</b> sugeriu
        </span>
        <span>· {quandoComHora(acao.created_at, agora)} · funcionário de IA</span>
      </div>
      <h2 className="det-titulo" id="ap-det-titulo" ref={titulo} tabIndex={-1}>
        {tituloDaResposta(acao, nome)}
      </h2>
    </>
  );
  const avaliacao = <BlocoDaAvaliacao ids={ids} avaliacao={acao.review.current} estrelas={estrelas} nome={nome} agora={agora} />;

  // ---- decidido sem publicar: recusado, ou tirado daqui pelo Social media
  if (grupo !== 'pendente') {
    const r = resultadoDasSugestoes(acao, agora);
    const outra = situacaoDaResposta(acao) === 'recusada' && podeMexer && podeEscreverOutra(acao);
    return (
      <>
        <Voltar aoVoltar={aoVoltar} />
        {cabecalho}
        <p className="plano-id">Plano {plano.plano}</p>
        <div className="secao">
          {r && <Resultado id="av-resultado" {...r} />}
          {outra && (
            <div className="desfazer">
              <button className="btn" type="button" data-av-outra onClick={() => aoEscreverOutra(acao)}>
                <Icone nome="pencil" pequeno />
                Escrever a resposta
              </button>
            </div>
          )}
        </div>
        <div className="secao">
          <p className="rotulo-marca">O que tinha sido sugerido</p>
          <div className="av-dois">
            {avaliacao}
            <section className="av-bloco" aria-labelledby={`${ids}-sug`}>
              <h3 id={`${ids}-sug`}>{todas.length === 1 ? 'A sugestão' : 'As sugestões'}</h3>
              <ListaDasOpcoes ids={ids} opcoes={opcoes} daPrimeira={escolha.daPrimeira} escolhida={escolha.escolhida} soLeitura ocupado={false} legenda={legenda} aoEscolher={() => {}} />
            </section>
          </div>
        </div>
      </>
    );
  }

  async function escolher(o: Opcao) {
    if (escolhendo || o.chave === escolha.escolhida) return;
    setEscolhendo(o.chave);
    setErro(null);
    const nomeDela = o.chave === escolha.ajustada?.chave ? 'A versão ajustada' : o.rotulo.split(' · ')[0];
    const r = await aoAlterarTexto(acao, o.texto, `${nomeDela} escolhida. A aprovação vale para ela.`);
    setEscolhendo(null);
    if (!r.ok) setErro(r.texto);
  }

  async function salvar(texto: string): Promise<Feito> {
    if (editando === 'ajustar' && texto === escolhida?.texto) {
      voltarPara.current = 'legenda';
      setEditando(null);
      aoAvisar('Nada mudou: segue o texto escolhido.');
      return { ok: true };
    }
    const r = await aoAlterarTexto(acao, texto, 'Texto salvo e conferido de novo. A aprovação vale para a versão ajustada.');
    if (r.ok) {
      voltarPara.current = 'legenda';
      setEditando(null);
    }
    return r;
  }

  async function pedirOutras() {
    setPedindo(true);
    setErro(null);
    const r = await aoPedirOutras(acao);
    setPedindo(false);
    if (!r.ok) setErro(r.texto);
  }

  const escrevendo = outras === 'escrevendo';
  let blocoDasSugestoes;
  if (escrevendo) {
    blocoDasSugestoes = (
      <section className="av-bloco" aria-labelledby={`${ids}-sug`}>
        <h3 id={`${ids}-sug`}>As sugestões do Social media</h3>
        <div className="av-sug-escrevendo" role="status" id="av-sug-escrevendo">
          <span className="av-sug-giro" aria-hidden="true" />
          <span>O Social media está escrevendo {umaSo ? 'outra sugestão' : 'outras duas sugestões'}. Costuma levar menos de um minuto; as primeiras continuam guardadas.</span>
        </div>
      </section>
    );
  } else if (editando) {
    blocoDasSugestoes = (
      <section className="av-bloco" aria-labelledby={`${ids}-sug`}>
        <h3 id={`${ids}-sug`}>{editando === 'zero' ? 'A sua resposta, do zero' : 'Ajuste o texto'}</h3>
        <FormularioDoTexto
          ids={ids}
          inicial={editando === 'zero' ? '' : (escolhida?.texto ?? acao.review.reply_text ?? '')}
          podeCancelar
          comConta
          aoSalvar={salvar}
          aoCancelar={() => {
            voltarPara.current = editando;
            setEditando(null);
          }}
        />
      </section>
    );
  } else {
    const notaDasOutras =
      outras === 'demorando'
        ? 'As outras sugestões estão demorando mais que o normal. O Social media continua tentando, e elas aparecem aqui quando ficarem prontas; enquanto isso, dá para decidir com estas.'
        : outras === 'nao_deu'
          ? 'Não deu para escrever outras sugestões. Para outro texto, ajuste uma das sugestões ou escreva do zero.'
          : null;
    blocoDasSugestoes = (
      <section className="av-bloco" aria-labelledby={`${ids}-sug`}>
        <h3 id={`${ids}-sug`}>{todas.length === 1 ? 'A sugestão do Social media' : 'As sugestões do Social media'}</h3>
        <ListaDasOpcoes
          ids={ids}
          opcoes={opcoes}
          daPrimeira={escolha.daPrimeira}
          escolhida={escolhendo ?? escolha.escolhida}
          soLeitura={!podeMexer}
          ocupado={escolhendo !== null}
          legenda={legenda}
          aoEscolher={(o) => disparar(escolher(o))}
        />
        {notaDasOutras && (
          <p className="nota" id="av-sug-outras">
            <Icone nome={outras === 'demorando' ? 'clock' : 'info'} />
            <span>{notaDasOutras}</span>
          </p>
        )}
        {podeMexer && (
          <div className="av-sug-acoes">
            <button
              ref={botaoAjustar}
              className="btn btn--sm"
              type="button"
              data-sug-ajustar
              onClick={() => {
                setErro(null);
                setEditando('ajustar');
              }}
            >
              <Icone nome="pencil" pequeno />
              Ajustar o texto escolhido
            </button>
            {outras === 'pode_pedir' && (
              <button className="btn btn--sm" type="button" data-sug-outras disabled={pedindo} aria-busy={pedindo || undefined} onClick={() => disparar(pedirOutras())}>
                <Icone nome="refresh" pequeno />
                {pedindo ? 'Pedindo…' : umaSo ? 'Pedir outra sugestão' : 'Pedir outras sugestões'}
              </button>
            )}
            <button
              ref={botaoZero}
              className="btn btn--sm btn--ghost"
              type="button"
              data-sug-zero
              onClick={() => {
                setErro(null);
                setEditando('zero');
              }}
            >
              Escrever do zero
            </button>
          </div>
        )}
        {erro && (
          <p className="campo-erro" role="alert" id="av-sug-erro">
            {erro}
          </p>
        )}
        {podeMexer && outras === 'feitas' && <p className="av-sug-conta">Esta é a segunda rodada: para outro texto, ajuste uma das sugestões ou escreva do zero.</p>}
        <p>A escolhida aparece embaixo da avaliação, {emNomeDa(acao)}. Quem avaliou é avisado pelo Google quando a resposta sai.</p>
      </section>
    );
  }

  const risco = riscoDaResposta(acao);
  const umaSugestao = escolha.novas.length + escolha.daPrimeira.length === 1;
  return (
    <>
      <Voltar aoVoltar={aoVoltar} />
      {cabecalho}
      {esperaODono && (
        <div className="secao secao--lite">
          <div className="resultado resultado--espera" role="status">
            <Icone nome="lock" />
            <span>
              <b id="av-dono-t">Esta resposta espera o dono.</b> Resposta a avaliação de 1 ou 2 estrelas só sai com a aprovação do dono da empresa. Você pode ler as sugestões; não pode escolher, ajustar nem aprovar.
            </span>
          </div>
        </div>
      )}
      {acao.review.changed && (
        <div className="secao secao--lite">
          <div className="resultado resultado--falha" role="alert" id="av-mudou">
            <Icone nome="alert" />
            <span>
              <b>A avaliação mudou depois das sugestões.</b> Aprovada assim, a resposta não é publicada. Em alguns minutos, este pedido sai daqui, e o Social media escreve outras para a avaliação como está agora.
            </span>
          </div>
        </div>
      )}
      {!pro && (
        <div className="secao secao--lite">
          <p className="lite-frase lite-frase--grande">
            <Frase pedacos={fraseDasSugestoes(acao, nome, { possoMexer: podeMexer, possoAprovar: podeDecidir && !esperaODono })} />
          </p>
          <div className="lite-chips">
            <span className={`risco risco--${risco.classe}`}>{risco.rotulo}</span>
            <span className="lite-chip">Resposta pública</span>
            <span className="lite-chip">{prazo}</span>
          </div>
        </div>
      )}
      <p className="plano-id">Plano {plano.plano} · a aprovação vale só para o texto escolhido: mudou o texto, é outro pedido</p>
      <div className="secao">
        <div className="av-dois">
          {avaliacao}
          {blocoDasSugestoes}
        </div>
      </div>
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
          <span>
            {umaSugestao
              ? 'O Compliance conferiu a sugestão antes de ela chegar aqui: ela não promete desconto, brinde nem reembolso, não cita o nome de quem avaliou, não traz dado pessoal e não afirma o que a loja não confirmou.'
              : 'O Compliance conferiu as sugestões antes de elas chegarem aqui: elas não prometem desconto, brinde nem reembolso, não citam o nome de quem avaliou, não trazem dado pessoal e não afirmam o que a loja não confirmou.'}
          </span>
        </p>
        {escolha.ajustada && (
          <p className="nota">
            <Icone nome="check-circle" />
            <span>A versão ajustada foi conferida de novo, com as regras da resposta escrita por uma pessoa: não promete desconto, brinde nem reembolso, não cita o nome de quem avaliou e não traz dado pessoal.</span>
          </p>
        )}
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
          <span>Prazo: {prazo}. Se ninguém decidir, o pedido expira, nada é publicado e a avaliação volta para “sem resposta”, sem sugestão nova.</span>
        </p>
      </div>
      <div className="secao">
        <p className="rotulo-marca">Como o Social media escreveu</p>
        <p className="nota">
          <Icone nome="sparkles" />
          <span>Leu a nota, o texto e a data da avaliação, e Minha marca: o nome da marca, o tom de voz e o resto do dossiê.</span>
        </p>
        <p className="nota">
          <Icone nome="lock" />
          <span>Não recebeu o nome de quem avaliou, que o Liame não guarda, nem pedidos ou dados de clientes da loja.</span>
        </p>
        {soDoDono && (
          <p className="nota">
            <Icone nome="message" />
            <span>
              Numa avaliação ruim, ele pede desculpas e chama para conversar pelos contatos do perfil da loja: não discute o caso em público e não diz que a loja já resolveu algo que não está confirmado. Se a loja já resolveu, ajuste o texto e
              conte.
            </span>
          </p>
        )}
        {!acao.review.current?.text && acao.review.current && (
          <p className="nota">
            <Icone nome="info" />
            <span>Só a nota, sem texto: uma sugestão só, curta.</span>
          </p>
        )}
      </div>
      {esperaODono ? null : !podeDecidir ? (
        <p className="nota ap-so-leitura">
          <Icone nome="lock" />
          <span>Só quem pode aprovar decide este pedido. Você acompanha por aqui.</span>
        </p>
      ) : escrevendo ? (
        <div className="secao">
          <p className="nota">
            <Icone nome="info" />
            <span>Espere as sugestões novas para aprovar.</span>
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
          campoCodigo={campoCodigo}
          motivos={MOTIVOS}
          dica="O código de 6 números que o app autenticador mostra agora. A aprovação vale só para o texto escolhido."
          aoAprovar={(codigo) => aoAprovar(acao, codigo)}
          aoRecusar={(motivo) => aoRecusar(acao, motivo)}
        />
      )}
    </>
  );
}
