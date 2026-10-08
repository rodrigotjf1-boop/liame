'use client';

import type { AdPieceOptionsResponse, AdPieceRequestResponse, AdPieceResponse, AdPieceVersion } from '@liame/contracts';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { ListaDeFontes, TextoComNumeros, useFontes } from '@/components/resumo/numeros';
import { Fontes } from '@/components/resumo/textos';
import { Estado } from '@/components/ui/estado';
import { Icone } from '@/components/ui/icone';
import { mensagemDe, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { quandoComHora } from '@/lib/formato';
import {
  BOTOES,
  botaoEscrito,
  cabecalhoDaPeca,
  contagem,
  custoDaPeca,
  custoDeOutraVersao,
  DESTINOS,
  erroDaPeca,
  itensDaConferencia,
  MOTIVOS_DA_RECUSA,
  motivoDeNaoRefazer,
  origemDaPeca,
  resultadoDaPeca,
  resumoDaConferencia,
  rotuloDaVersao,
  SUGESTOES_DE_MUDANCA,
  textoMarcado,
} from './textos';

// A peça aberta (protótipo P10, na entrega do texto): a prévia do anúncio, o texto com a contagem de cada campo, a
// conferência do Compliance item por item e a decisão. Aprovar não pede o código do app: a peça só vai para a
// biblioteca. Editar cria uma versão nova, conferida de novo; a peça barrada não pode ser aprovada.

type Detalhe = { id: string; estado: 'carregando' } | { id: string; estado: 'ok'; peca: AdPieceResponse } | { id: string; estado: 'erro'; problema: Problema };
type Botao = 'pedir_agora' | 'ver_cardapio' | 'enviar_mensagem';
type Motivo = (typeof MOTIVOS_DA_RECUSA)[number]['valor'];

interface Props {
  detalhe: Detalhe;
  /** A peça como a lista a conhece (para o título enquanto o detalhe carrega). */
  naLista: AdPieceResponse | null;
  /** As peças do mesmo pedido, para andar entre elas. */
  irmas: string[];
  pedido: AdPieceRequestResponse | null;
  opcoes: AdPieceOptionsResponse;
  nomeDaMarca: string;
  pro: boolean;
  pode: boolean;
  agora: Date;
  ocupado: string | null;
  aoVoltar: () => void;
  aoAbrir: (id: string) => void;
  aoTentarDeNovo: () => void;
  aoAprovar: (p: AdPieceResponse) => void;
  aoRecusar: (p: AdPieceResponse, motivo: Motivo) => void;
  aoSalvar: (p: AdPieceResponse, texto: { title: string; body: string; button: Botao }) => Promise<Problema | null>;
  aoPedirOutra: (p: AdPieceResponse, instrucao: string) => Promise<Problema | null>;
  aoContestar: (p: AdPieceResponse, comentario: string) => Promise<Problema | null>;
  aoAvisar: (texto: string, tipo?: 'ok' | 'perigo') => void;
}

const iniciais = (nome: string) =>
  nome
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((x) => x.charAt(0).toLocaleUpperCase('pt-BR'))
    .join('');
const contar = (t: string) => [...t].length;

function Previa({ v, marca, destino }: { v: AdPieceVersion; marca: string; destino: string }) {
  return (
    <div className="previa" role="group" aria-label="Prévia do anúncio no Feed">
      <div className="pv-cab">
        <span className="pv-av" aria-hidden="true">
          {iniciais(marca)}
        </span>
        <span className="pv-quem">
          <b>{marca}</b>
          <small>Patrocinado</small>
        </span>
        <span className="pv-mais" aria-hidden="true">
          ···
        </span>
      </div>
      <p className="pv-texto">{v.body}</p>
      <div className="pv-arte pc-arte--texto">
        <Icone nome="image" />
        <span>A imagem entra aqui</span>
      </div>
      <div className="pv-pe">
        <span className="pv-pe-txt">
          <small>{DESTINOS[destino]?.site ?? destino}</small>
          <b>{v.title}</b>
        </span>
        <span className="pv-bt">{botaoEscrito(v.button)}</span>
      </div>
    </div>
  );
}

export function PecaAberta(props: Props) {
  const { detalhe, naLista, irmas, aoVoltar, aoAbrir, aoTentarDeNovo } = props;
  const pos = irmas.indexOf(detalhe.id);
  const vizinha = (d: number, rotulo: string, icone: 'chevron-left' | 'arrow-right') => {
    const alvo = irmas[pos + d];
    return (
      <button className="btn btn--sm btn--icon" type="button" disabled={!alvo} aria-label={rotulo} onClick={() => alvo && aoAbrir(alvo)}>
        <Icone nome={icone} />
      </button>
    );
  };
  const topo = (
    <div className="peca-topo">
      <button className="btn btn--ghost btn--sm" type="button" onClick={aoVoltar}>
        <Icone nome="chevron-left" />
        Voltar para as peças
      </button>
      {irmas.length > 1 && pos >= 0 && (
        <div className="peca-vizinhas">
          <span>
            Peça {pos + 1} de {irmas.length}
          </span>
          {vizinha(-1, 'Peça anterior', 'chevron-left')}
          {vizinha(1, 'Próxima peça', 'arrow-right')}
        </div>
      )}
    </div>
  );
  if (detalhe.estado === 'erro') {
    return (
      <div className="cri">
        {topo}
        <div className="card">
          <Estado
            icone="alert-circle"
            perigo
            titulo="Não foi possível abrir a peça"
            acao={
              <div className="vazio-acoes">
                <button className="btn btn--primary" type="button" onClick={aoTentarDeNovo}>
                  <Icone nome="refresh" />
                  Tentar de novo
                </button>
              </div>
            }
          >
            {mensagemDe(detalhe.problema)} Nada foi perdido.
          </Estado>
        </div>
      </div>
    );
  }
  if (detalhe.estado === 'carregando') {
    return (
      <div className="cri" aria-busy="true">
        {topo}
        <div className="card">
          <h2 className="det-titulo" id="pc-titulo" tabIndex={-1}>
            {naLista?.current.title ?? 'Abrindo a peça…'}
          </h2>
          <p className="sr-only">Carregando a peça…</p>
          <span className="esqueleto esqueleto--bloco" aria-hidden="true" />
          <span className="esqueleto esqueleto--medio" aria-hidden="true" />
        </div>
      </div>
    );
  }
  return (
    <div className="cri">
      {topo}
      {/* A chave refaz o estado da peça (edição aberta, versão à vista) quando a pessoa troca de peça. */}
      <Corpo key={detalhe.id} {...props} p={detalhe.peca} />
    </div>
  );
}

function Corpo({ p, pedido, opcoes, nomeDaMarca, pro, pode, agora, ocupado, aoAprovar, aoRecusar, aoSalvar, aoPedirOutra, aoContestar, aoAvisar }: Props & { p: AdPieceResponse }) {
  const ids = useId();
  const versoes = p.versions ?? [p.current];
  const [vista, setVista] = useState<number | null>(null);
  const [aberto, setAberto] = useState<'editar' | 'outra' | 'recusar' | 'contestar' | null>(null);
  const [detalhes, setDetalhes] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [rascunho, setRascunho] = useState({ title: p.current.title, body: p.current.body, button: p.current.button as Botao });
  const [instrucao, setInstrucao] = useState('');
  const [comentario, setComentario] = useState('');
  const campoInicial = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement | null>(null);
  const voltarPara = useRef<HTMLButtonElement | string | null>(null);
  const devolverFoco = useRef<HTMLButtonElement | string | null>(null);

  const v = versoes.find((x) => x.version === vista) ?? p.current;
  const atual = v.version === p.current.version;
  const decidindo = p.status === 'decidir' && !p.redoing && atual;
  const resumo = resumoDaConferencia(v.review);
  const barrada = resumo.situacao === 'falha';
  const itens = itensDaConferencia(v.review, p.offer, nomeDaMarca);
  const cab = cabecalhoDaPeca(p, v, agora);
  const resultado = resultadoDaPeca(p, v, agora, pode, nomeDaMarca);
  const fontes = new Fontes();
  const origem = origemDaPeca(p, v, pedido, opcoes.reference_ads, opcoes.reference_period, fontes);
  const estado = useFontes(fontes.lista);
  const custo = custoDaPeca(p, v, opcoes.usd_brl);
  const detalhado = pro || detalhes;
  const contestada = p.decisions?.find((d) => d.decision === 'contestada' && d.version === v.version) ?? null;
  const semIa = motivoDeNaoRefazer(opcoes);

  // A versão mais nova chegou (edição salva, ou o Criativo refez): a tela volta para ela e fecha o que estava aberto.
  const versaoAtual = p.current.version;
  useEffect(() => {
    setVista(null);
    setAberto(null);
    setErro(null);
    setRascunho({ title: p.current.title, body: p.current.body, button: p.current.button as Botao });
    setInstrucao('');
    // Só quando a versão muda: os campos não voltam ao texto antigo no meio da digitação.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versaoAtual, p.status]);

  // O que abre recebe o foco; o que fecha devolve o foco a quem abriu, depois que a tela já mostra o botão de novo (o
  // "Editar o texto" some enquanto o formulário está aberto: quem volta é um botão novo, achado pelo id).
  useEffect(() => {
    if (aberto) return campoInicial.current?.focus({ preventScroll: aberto !== 'outra' });
    const alvo = devolverFoco.current;
    devolverFoco.current = null;
    const el = typeof alvo === 'string' ? document.getElementById(alvo) : alvo;
    if (el?.isConnected) el.focus({ preventScroll: true });
  }, [aberto]);
  function alternar(qual: NonNullable<typeof aberto>, botao: HTMLButtonElement | null) {
    setErro(null);
    if (aberto === qual) return fechar();
    voltarPara.current = qual === 'editar' ? `${ids}-bt-editar` : botao;
    setAberto(qual);
  }
  function fechar() {
    devolverFoco.current = voltarPara.current;
    setAberto(null);
    setErro(null);
  }

  async function salvar(e: FormEvent) {
    e.preventDefault();
    const [title, body] = [rascunho.title.trim(), rascunho.body.trim()];
    if (!title) return setErro('Escreva o título.');
    if (!body) return setErro('Escreva o texto principal.');
    if (title === p.current.title && body === p.current.body && rascunho.button === p.current.button) {
      fechar();
      return aoAvisar(`Nada mudou: a peça segue na versão ${p.current.version}.`, 'ok');
    }
    setEnviando(true);
    const problema = await aoSalvar(p, { title, body, button: rascunho.button });
    setEnviando(false);
    if (problema) setErro(erroDaPeca(problema).texto);
  }
  async function pedirOutra(e: FormEvent) {
    e.preventDefault();
    setEnviando(true);
    const problema = await aoPedirOutra(p, instrucao.trim());
    setEnviando(false);
    if (problema) setErro(erroDaPeca(problema).texto);
  }
  async function contestar(e: FormEvent) {
    e.preventDefault();
    if (comentario.trim().length < 3) return setErro('Escreva o que a conferência entendeu errado.');
    setEnviando(true);
    const problema = await aoContestar(p, comentario.trim());
    setEnviando(false);
    if (problema) setErro(erroDaPeca(problema).texto);
    else {
      setAberto(null);
      setComentario('');
    }
  }

  // A contagem à vista é a da conferência (a do servidor); no formulário, a do que está sendo digitado.
  const nT = contagem(v.review.characters.title, v.review.recommended.title);
  const nX = contagem(v.review.characters.body, v.review.recommended.body);
  const rT = contagem(contar(rascunho.title), v.review.recommended.title);
  const rX = contagem(contar(rascunho.body), v.review.recommended.body);
  const marcado = (texto: string, campo: 'titulo' | 'texto') => textoMarcado(texto, campo, v.review).map((x, i) => (x.marcado ? <mark key={i}>{x.t}</mark> : <span key={i}>{x.t}</span>));
  const ROTULO = { ok: ['check', 'Passou'], aviso: ['alert', 'Aviso'], falha: ['x', 'Barrou'] } as const;

  return (
    <div className="peca-pag">
      <div className="card peca-previa">
        <div className="card-cab">
          <h2 className="rotulo-marca">Prévia do anúncio</h2>
        </div>
        <Previa v={v} marca={nomeDaMarca} destino={p.destination} />
        <p className="nota">
          <Icone nome="info" />
          <span>É um desenho de como o texto fica no Feed. Na Meta, cada posição mostra de um jeito.</span>
        </p>
        <p className="nota">
          <Icone nome="image" />
          <span>Por enquanto o Criativo faz só o texto. A imagem a partir da foto do seu produto chega numa próxima fase.</span>
        </p>
      </div>

      <article className="card inbox-det peca-det" aria-labelledby="pc-titulo">
        <div className="det-cab">
          <span>
            <b>{cab.quem}</b> fez
          </span>
          <span>· {cab.quando}</span>
        </div>
        <h2 className="det-titulo" id="pc-titulo" tabIndex={-1}>
          {v.title}
        </h2>
        <div className="det-chips">
          {p.ai_generated && (
            <span className="st st--ia">
              <Icone nome="sparkles" pequeno />
              Texto feito com IA
            </span>
          )}
          {cab.chips.map((c) => (
            <span key={c.rotulo} className={c.classe}>
              {c.rotulo}
            </span>
          ))}
          <span className="st st--neutro">{cab.versao}</span>
        </div>
        {!atual && (
          <p className="alerta-versao" role="status">
            <Icone nome="history" pequeno />
            <span>
              Você está vendo a versão {v.version}. A decisão vale para a versão {p.current.version}, a mais recente.{' '}
              <button className="link-bt" type="button" onClick={() => setVista(null)}>
                Ver a versão {p.current.version}
              </button>
            </span>
          </p>
        )}

        {resultado && (
          <div className="secao">
            <div className={`resultado${resultado.tom === 'neutro' ? '' : ` resultado--${resultado.tom}`}`} role={resultado.tom === 'espera' || resultado.tom === 'falha' ? 'status' : undefined}>
              <Icone nome={resultado.icone} />
              <span>
                <b id="pc-resultado" tabIndex={-1}>
                  {resultado.forte}
                </b>
                {resultado.texto}
              </span>
            </div>
          </div>
        )}

        <div className="secao">
          <div className="card-cab">
            <p className="rotulo-marca">O texto</p>
            {pode && decidindo && aberto !== 'editar' && (
              <button className="btn btn--sm" type="button" id={`${ids}-bt-editar`} onClick={(e) => alternar('editar', e.currentTarget)}>
                <Icone nome="pencil" pequeno />
                Editar o texto
              </button>
            )}
          </div>
          {aberto === 'editar' && decidindo ? (
            <form className="peca-form" id={`${ids}-editar`} noValidate onSubmit={(e) => disparar(salvar(e))}>
              <div className="campo">
                <div className="campo-rot">
                  <label htmlFor={`${ids}-titulo`}>Título</label>
                  <small id={`${ids}-titulo-n`} className={rT.acima ? 'pt-conta--acima' : undefined}>
                    {rT.texto}
                  </small>
                </div>
                <input
                  className="input"
                  id={`${ids}-titulo`}
                  ref={(el) => {
                    campoInicial.current = el;
                  }}
                  autoComplete="off"
                  maxLength={60}
                  value={rascunho.title}
                  onChange={(e) => setRascunho((r) => ({ ...r, title: e.target.value }))}
                  aria-describedby={`${ids}-titulo-n ${ids}-erro`}
                />
              </div>
              <div className="campo">
                <div className="campo-rot">
                  <label htmlFor={`${ids}-texto`}>Texto principal</label>
                  <small id={`${ids}-texto-n`} className={rX.acima ? 'pt-conta--acima' : undefined}>
                    {rX.texto}
                  </small>
                </div>
                <textarea className="area" id={`${ids}-texto`} rows={4} maxLength={400} value={rascunho.body} onChange={(e) => setRascunho((r) => ({ ...r, body: e.target.value }))} aria-describedby={`${ids}-texto-n ${ids}-erro`} />
              </div>
              <div className="campo">
                <div className="campo-rot">
                  <label htmlFor={`${ids}-botao`}>Botão</label>
                </div>
                <select className="input" id={`${ids}-botao`} value={rascunho.button} onChange={(e) => setRascunho((r) => ({ ...r, button: e.target.value as Botao }))}>
                  {Object.entries(BOTOES).map(([valor, rotulo]) => (
                    <option key={valor} value={valor}>
                      {rotulo}
                    </option>
                  ))}
                </select>
              </div>
              <div id={`${ids}-erro`} role="alert">
                {erro && <p className="campo-erro">{erro}</p>}
              </div>
              <p className="nota">
                <Icone nome="info" />
                <span>
                  Salvar cria a versão {p.current.version + 1}, com o seu texto. A conferência é feita de novo, e a decisão passa a valer para ela. O texto que seria barrado não é salvo.
                </span>
              </p>
              <div className="peca-form-acoes">
                <button className="btn btn--primary btn--sm" type="submit" disabled={enviando} aria-busy={enviando}>
                  {enviando ? 'Salvando…' : `Salvar como versão ${p.current.version + 1}`}
                </button>
                <button className="btn btn--sm" type="button" onClick={fechar} disabled={enviando}>
                  Cancelar
                </button>
              </div>
            </form>
          ) : (
            <div className="pt">
              <div className="pt-linha">
                <p className="pt-rot">
                  <span>Título</span>
                  <span className={`num${nT.acima ? ' pt-conta--acima' : ''}`}>{nT.texto}</span>
                </p>
                <p className="pt-val">{marcado(v.title, 'titulo')}</p>
              </div>
              <div className="pt-linha">
                <p className="pt-rot">
                  <span>Texto principal</span>
                  <span className={`num${nX.acima ? ' pt-conta--acima' : ''}`}>{nX.texto}</span>
                </p>
                <p className="pt-val">{marcado(v.body, 'texto')}</p>
              </div>
              <div className="pt-linha">
                <p className="pt-rot">
                  <span>Botão</span>
                </p>
                <p className="pt-val">{botaoEscrito(v.button)}</p>
              </div>
            </div>
          )}
        </div>

        <div className="secao">
          <p className="rotulo-marca">Conferência do Compliance</p>
          <div className="politica">
            <Icone nome="shield" />
            <span>
              <b>{resumo.texto}.</b> Cada peça é conferida antes de aparecer: o preço da oferta, as regras da Liame e das plataformas, as regras da marca e o tamanho. A conferência reduz o risco, não
              elimina: leia a peça antes de aprovar. Quem aprova responde pelo anúncio.
            </span>
          </div>
          <div className="conf-grupo">
            <p>O texto</p>
            <ul className="conf">
              {itens.map((i) => (
                <li key={i.chave} data-st={i.situacao}>
                  <span className="conf-ic" aria-hidden="true">
                    <Icone nome={ROTULO[i.situacao][0]} />
                  </span>
                  <span>
                    <b>
                      <span className="sr-only">{ROTULO[i.situacao][1]}: </span>
                      {i.titulo}
                    </b>
                    <small>{i.texto}</small>
                  </span>
                </li>
              ))}
            </ul>
          </div>
          {contestada ? (
            <p className="nota" id="pc-contestada" tabIndex={-1}>
              <Icone nome="check" />
              <span>
                Motivo registrado {quandoComHora(contestada.created_at, agora)}
                {contestada.decided_by ? `, por ${contestada.decided_by.name}` : ''}. Ele fica guardado com esta conferência, para a regra ser revista. A decisão sobre esta peça não muda sozinha.
              </span>
            </p>
          ) : (
            pode &&
            decidindo &&
            resumo.situacao !== 'ok' && (
              <>
                <button className="link-bt" type="button" aria-expanded={aberto === 'contestar'} aria-controls={aberto === 'contestar' ? `${ids}-contestar` : undefined} onClick={(e) => alternar('contestar', e.currentTarget)}>
                  A conferência errou?
                </button>
                {aberto === 'contestar' && (
                  <form className="peca-form" id={`${ids}-contestar`} noValidate onSubmit={(e) => disparar(contestar(e))}>
                    <div className="campo">
                      <div className="campo-rot">
                        <label htmlFor={`${ids}-contestar-txt`}>O que a conferência entendeu errado?</label>
                      </div>
                      <textarea
                        className="area"
                        id={`${ids}-contestar-txt`}
                        ref={(el) => {
                          campoInicial.current = el;
                        }}
                        rows={2}
                        maxLength={500}
                        placeholder="Ex.: “da casa” é o nome do nosso molho"
                        value={comentario}
                        onChange={(e) => setComentario(e.target.value)}
                        aria-describedby={`${ids}-contestar-dica ${ids}-contestar-erro`}
                        aria-invalid={erro ? 'true' : undefined}
                      />
                      <p className="campo-dica" id={`${ids}-contestar-dica`}>
                        Não escreva nome, telefone nem outro dado de cliente. O motivo fica guardado; ele não destrava a peça.
                      </p>
                    </div>
                    <div id={`${ids}-contestar-erro`} role="alert">
                      {erro && <p className="campo-erro">{erro}</p>}
                    </div>
                    <div className="peca-form-acoes">
                      <button className="btn btn--primary btn--sm" type="submit" disabled={enviando} aria-busy={enviando}>
                        {enviando ? 'Registrando…' : 'Registrar o motivo'}
                      </button>
                      <button className="btn btn--sm" type="button" onClick={fechar} disabled={enviando}>
                        Cancelar
                      </button>
                    </div>
                  </form>
                )}
              </>
            )
          )}
        </div>

        {!pro && (
          <div className="secao secao--lite">
            <button className="detalhes-bt" type="button" aria-expanded={detalhes} aria-controls={`${ids}-detalhes`} onClick={() => setDetalhes((d) => !d)}>
              <Icone nome="chevron-down" />
              <span className="rot">{detalhes ? 'Ocultar detalhes' : 'Ver detalhes'}</span>
            </button>
          </div>
        )}
        <div id={`${ids}-detalhes`} hidden={!detalhado}>
          <div className="secao">
            <p className="rotulo-marca">De onde veio</p>
            <ul className="origem-peca">
              {origem.map((o) => (
                <li key={o.forte}>
                  <Icone nome={o.icone} />
                  <span>
                    <b>{o.forte}</b>
                    <TextoComNumeros texto={o.texto} lista={fontes.lista} aoTocar={estado.mostrar} />
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className="secao">
            <p className="rotulo-marca">Custo</p>
            <ul className="custos">
              {custo.linhas.map((l) => (
                <li key={l.rotulo}>
                  <span>{l.rotulo}</span>
                  <b className="num">{l.valor}</b>
                </li>
              ))}
            </ul>
            {custo.total && <p className="eixo-nota">{custo.total}</p>}
            {custo.nota && <p className="eixo-nota">{custo.nota}</p>}
          </div>
          {versoes.length > 1 && (
            <div className="secao">
              <p className="rotulo-marca">Versões</p>
              <div className="versoes" role="group" aria-label="Versões desta peça">
                {versoes.map((x) => (
                  <button
                    key={x.version}
                    className="chip"
                    type="button"
                    aria-pressed={x.version === v.version}
                    onClick={() => {
                      setAberto(null);
                      setVista(x.version === p.current.version ? null : x.version);
                    }}
                  >
                    {rotuloDaVersao(x, agora)}
                  </button>
                ))}
              </div>
            </div>
          )}
          <ListaDeFontes lista={fontes.lista} estado={estado} id={`${ids}-fontes`} />
        </div>

        {aberto === 'outra' && decidindo && pode && (
          <form className="peca-form secao" id={`${ids}-outra`} noValidate onSubmit={(e) => disparar(pedirOutra(e))}>
            <div className="campo">
              <div className="campo-rot">
                <label htmlFor={`${ids}-instr`}>
                  O que mudar? <span className="campo-dica">Opcional.</span>
                </label>
              </div>
              <div className="rapidas" role="group" aria-label="Sugestões de mudança">
                {SUGESTOES_DE_MUDANCA.map((t) => (
                  <button key={t} className="chip" type="button" onClick={() => setInstrucao((i) => (i.trim() ? `${i.trim()}. ${t}` : t))}>
                    {t}
                  </button>
                ))}
              </div>
              <textarea
                className="area"
                id={`${ids}-instr`}
                ref={(el) => {
                  campoInicial.current = el;
                }}
                rows={2}
                maxLength={opcoes.limits.instruction_max}
                placeholder="Ex.: fale da retirada no balcão"
                value={instrucao}
                onChange={(e) => setInstrucao(e.target.value)}
                aria-describedby={`${ids}-outra-custo ${ids}-outra-erro`}
              />
            </div>
            <p className="campo-dica" id={`${ids}-outra-custo`}>
              {custoDeOutraVersao(opcoes.ai, opcoes.usd_brl)}
            </p>
            <div id={`${ids}-outra-erro`} role="alert">
              {erro && <p className="campo-erro">{erro}</p>}
            </div>
            <div className="peca-form-acoes">
              <button className="btn btn--primary btn--sm" type="submit" disabled={enviando} aria-busy={enviando}>
                {enviando ? 'Pedindo…' : `Pedir a versão ${p.current.version + 1}`}
              </button>
              <button className="btn btn--sm" type="button" onClick={fechar} disabled={enviando}>
                Cancelar
              </button>
            </div>
          </form>
        )}

        {decidindo && pode && aberto === 'editar' && (
          <p className="nota ap-so-leitura">
            <Icone nome="info" />
            <span>Salve ou cancele a edição para decidir a peça.</span>
          </p>
        )}
        {decidindo && pode && aberto !== 'editar' && (
          <div className="acoes-plano" role="group" aria-label="Decidir esta peça">
            {!barrada && (
              <button className="btn btn--primary" type="button" onClick={() => aoAprovar(p)} disabled={ocupado !== null} aria-busy={ocupado === `aprovar:${p.id}`}>
                <Icone nome="check" />
                {ocupado === `aprovar:${p.id}` ? 'Aprovando…' : 'Aprovar a peça'}
              </button>
            )}
            <button
              className="btn"
              type="button"
              aria-expanded={aberto === 'outra'}
              aria-controls={aberto === 'outra' ? `${ids}-outra` : undefined}
              aria-disabled={semIa ? 'true' : undefined}
              disabled={ocupado !== null}
              onClick={(e) => (semIa ? aoAvisar(semIa) : alternar('outra', e.currentTarget))}
            >
              <Icone nome="refresh" />
              Pedir outra
            </button>
            <button className="btn" type="button" aria-expanded={aberto === 'recusar'} aria-controls={aberto === 'recusar' ? `${ids}-motivos` : undefined} disabled={ocupado !== null} onClick={(e) => alternar('recusar', e.currentTarget)}>
              <Icone nome="x" />
              Recusar
            </button>
            <p className="ap-dica">
              {barrada
                ? 'A peça barrada não pode ser aprovada. Editar o texto ou pedir outra faz uma versão nova, que passa de novo pela conferência.'
                : 'Aprovar guarda a peça na biblioteca. Nada vai para a Meta agora.'}
              {semIa ? ' Pedir outra volta quando o Criativo puder escrever.' : ''}
            </p>
            {aberto === 'recusar' && (
              <div className="motivos" id={`${ids}-motivos`} role="group" aria-label="Motivo da recusa">
                {MOTIVOS_DA_RECUSA.map((m, i) => (
                  <button
                    key={m.valor}
                    className="chip-sug"
                    type="button"
                    ref={
                      i === 0
                        ? (el) => {
                            campoInicial.current = el;
                          }
                        : undefined
                    }
                    disabled={ocupado !== null}
                    onClick={() => aoRecusar(p, m.valor)}
                  >
                    {m.rotulo}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {!pode && p.status === 'decidir' && (
          <p className="nota ap-so-leitura">
            <Icone nome="lock" />
            <span>Só quem opera campanhas (Dono, Administrador e Gestor) aprova, pede outra e recusa. Você acompanha por aqui.</span>
          </p>
        )}
      </article>
    </div>
  );
}
