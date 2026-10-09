'use client';

import type { ActionOptionsResponse, ActionResponse, BudgetMonthResponse } from '@liame/contracts';
import Link from 'next/link';
import { type FormEvent, Fragment, type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { enderecoDoPedido } from '@/components/aprovacoes/textos';
import { TextoRico } from '@/components/resultados/pecas';
import { fusoValido } from '@/components/resultados/textos';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { useAgora } from '@/lib/agora';
import { api, chamar, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import {
  type Acao,
  acoesDe,
  agoraNaPlataforma,
  conferirPedido,
  depoisDeCriar,
  dicaDaVerba,
  efeitoDoPedido,
  erroDoPedido,
  falhaDaLeitura,
  lendoNaPlataforma,
  limitesDaGaveta,
  listaLidaEm,
  naPlataforma,
  notaDoPedido,
  ondeDe,
  semOpcoes,
  temOnde,
  tituloDoPedido,
  verbaDividida,
  verbaNoCampo,
} from './textos';

// A gaveta "Pedir uma mudança" (protótipo P9: mockups/prototipo-anuncios.html). Ao abrir, a campanha é lida NA
// PLATAFORMA (`GET /v1/actions/options`), para o pedido partir do que está valendo agora; cada escolha no campo "Onde"
// é outra leitura. Os limites da empresa e a conta do mês vêm de `GET /v1/budget/month`. Enviar cria o pedido
// (`POST /v1/actions`), que espera a aprovação com o código do app: nada muda na plataforma por aqui.
// Numa campanha do Google (protótipo P13, parte 1: mockups/prototipo-google-pedido.html) a mudança é na campanha
// inteira: não há campo "Onde"; e, com a verba dividida entre campanhas, a gaveta diz com quem e só deixa pausar e
// retomar. `<dialog>` nativo: foco preso, Esc fecha, foco volta a quem abriu.

export type CampanhaDoPedido = { id: string; nome: string; provider: string };

/** De onde o pedido parte quando não é do zero: o objeto, a ação e o valor sugeridos, e a recomendação de que nasce. */
export type PedidoInicial = { alvo?: string; acao?: Acao; valorMicros?: number; recomendacao?: string };

type Props = {
  campanha: CampanhaDoPedido;
  inicial?: PedidoInicial;
  /** Quem gerencia o orçamento leva ao formulário dos limites; os outros leem quem define. */
  podeDefinirLimites: boolean;
  podeVerContas: boolean;
  reserva: RefObject<HTMLElement | null>;
  /** Para onde o foco volta se, ao fechar, ele ficou solto na página (quem abriu não tinha o foco): o botão de quem abriu. */
  voltarPara?: () => HTMLElement | null;
  aoFechar: () => void;
  /** O pedido entrou: quem abriu a gaveta lê de novo os pedidos em aberto. */
  aoCriar: () => void;
};

type Leitura = { tipo: 'lendo' } | { tipo: 'ok'; opcoes: ActionOptionsResponse } | { tipo: 'falha'; problema: Problema };
type Erro = { texto: string; noValor: boolean; ver?: string; limites?: boolean };

export function GavetaPedir({ campanha, inicial, podeDefinirLimites, podeVerContas, reserva, voltarPara, aoFechar, aoCriar }: Props) {
  const { ref, fechar, devolverFoco } = useDialogo({ reserva });
  const [leitura, setLeitura] = useState<Leitura>({ tipo: 'lendo' });
  const [verba, setVerba] = useState<BudgetMonthResponse | null>(null);
  const [alvo, setAlvo] = useState(inicial?.alvo ?? '');
  const [tentativa, setTentativa] = useState(0);
  const [acao, setAcao] = useState<Acao | null>(null);
  const [valor, setValor] = useState('');
  const [erro, setErro] = useState<Erro | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [criado, setCriado] = useState<ActionResponse | null>(null);
  const [anuncio, setAnuncio] = useState(() => lendoNaPlataforma(campanha.provider));
  /** A última leitura boa: a lista do campo "Onde" segue na tela enquanto o objeto escolhido é lido. */
  const [ultima, setUltima] = useState<ActionOptionsResponse | null>(null);
  // Só a leitura mais nova vale (trocar o "Onde" no meio de uma leitura não mistura os objetos).
  const seq = useRef(0);
  /** A sugestão de quem abriu a gaveta vale só na primeira leitura boa; depois, a pessoa é quem escolhe. */
  const primeira = useRef(true);
  /** A próxima leitura boa leva o foco ao formulário: ao abrir e depois do "Tentar de novo" (trocar o "Onde" não). */
  const focarNoForm = useRef(true);
  /** O que recebe o foco depois do próximo desenho. */
  const focar = useRef<'form' | 'falha' | 'criado' | 'valor' | 'erro' | null>(null);
  const campoValor = useRef<HTMLInputElement>(null);
  const campoOnde = useRef<HTMLSelectElement>(null);
  const escolha = useRef<HTMLDivElement>(null);
  const tituloDaFalha = useRef<HTMLElement>(null);
  const tituloDoCriado = useRef<HTMLHeadingElement>(null);
  const paragrafoDoErro = useRef<HTMLParagraphElement>(null);

  const na = naPlataforma(campanha.provider);
  const fuso = fusoValido(verba?.timezone);
  const relogio = useAgora(60_000, ultima?.read_at);

  // Os limites da empresa e a conta do mês: uma leitura só. Sem ela a gaveta segue, e o servidor confere no pedido.
  useEffect(() => {
    let vivo = true;
    disparar(
      chamar(() => api.GET('/v1/budget/month')).then((r) => {
        if (vivo && r.ok) setVerba(r.data);
      }),
    );
    return () => {
      vivo = false;
    };
  }, []);

  // O objeto escolhido, lido na plataforma agora.
  useEffect(() => {
    const id = ++seq.current;
    const query = { campaign_id: campanha.id, ...(alvo ? { target: alvo } : {}) };
    disparar(
      chamar(() => api.GET('/v1/actions/options', { params: { query } })).then((r) => {
        if (id !== seq.current) return;
        if (!r.ok) {
          setLeitura({ tipo: 'falha', problema: r.problema });
          setAnuncio('Não foi possível seguir com o pedido.');
          focar.current = 'falha';
          return;
        }
        const opcoes = acoesDe(r.data.tools);
        const sugerida = primeira.current ? inicial?.acao : undefined;
        const escolhida = opcoes.find((a) => a.acao === sugerida)?.acao ?? opcoes[0]?.acao ?? null;
        const sugerido = primeira.current && escolhida === 'verba' ? inicial?.valorMicros : undefined;
        setAcao(escolhida);
        setValor(escolhida === 'verba' && r.data.target.daily_micros !== null ? verbaNoCampo(sugerido ?? r.data.target.daily_micros) : '');
        setUltima(r.data);
        setLeitura({ tipo: 'ok', opcoes: r.data });
        setAnuncio(`Campanha lida ${na}.`);
        // Ao abrir (e depois do "Tentar de novo") o foco vai para o formulário; ao trocar o "Onde", fica onde a pessoa está.
        if (focarNoForm.current) focar.current = 'form';
        focarNoForm.current = false;
        primeira.current = false;
      }),
    );
    // A leitura que chega depois de a gaveta fechar, ou de outra escolha, não vale mais.
    return () => {
      seq.current++;
    };
    // `inicial` vale só na primeira leitura (a referência dele não refaz a leitura).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campanha.id, alvo, tentativa, na]);

  useEffect(() => {
    const destino = focar.current;
    if (!destino) return;
    // Sem o campo da verba e sem o "Onde" (verba dividida no Google), o foco vai para a escolha do que mudar.
    const naEscolha = escolha.current?.querySelector<HTMLInputElement>('input:checked') ?? escolha.current?.querySelector<HTMLInputElement>('input') ?? null;
    const elemento =
      destino === 'form'
        ? (campoValor.current ?? campoOnde.current ?? naEscolha)
        : destino === 'valor'
          ? campoValor.current
          : destino === 'erro'
            ? paragrafoDoErro.current
            : destino === 'falha'
              ? tituloDaFalha.current
              : tituloDoCriado.current;
    if (!elemento) return;
    focar.current = null;
    elemento.focus({ preventScroll: true });
    if (destino === 'erro' || destino === 'valor') paragrafoDoErro.current?.scrollIntoView({ block: 'nearest' });
  }, [leitura, erro, criado]);

  const opcoes = leitura.tipo === 'ok' ? leitura.opcoes : null;
  const acoes = useMemo(() => (opcoes ? acoesDe(opcoes.tools) : []), [opcoes]);
  const agoraNoObjeto = useMemo(() => (opcoes ? agoraNaPlataforma(opcoes, fuso) : null), [opcoes, fuso]);
  const lista = useMemo(() => (ultima ? { onde: ondeDe(ultima), lidaEm: listaLidaEm(ultima, fuso, relogio) } : null), [ultima, fuso, relogio]);
  const limites = useMemo(() => limitesDaGaveta(verba), [verba]);
  const dividida = useMemo(() => (opcoes ? verbaDividida(opcoes) : null), [opcoes]);
  const efeito = useMemo(() => (opcoes && acao ? efeitoDoPedido(opcoes, { acao, valor }, verba) : null), [opcoes, acao, valor, verba]);
  const dica = opcoes && acao === 'verba' && opcoes.target.daily_micros !== null ? dicaDaVerba(opcoes.target.daily_micros, verba) : null;
  const falha = leitura.tipo === 'falha' ? falhaDaLeitura(leitura.problema, campanha.provider) : null;

  function lerDeNovo() {
    setErro(null);
    setLeitura({ tipo: 'lendo' });
    setAnuncio(lendoNaPlataforma(campanha.provider));
  }

  function mudarOnde(novo: string) {
    if (novo === alvo) return;
    lerDeNovo();
    setAlvo(novo);
  }

  function tentarDeNovo() {
    focarNoForm.current = true;
    lerDeNovo();
    setTentativa((t) => t + 1);
  }

  function mudarAcao(nova: Acao) {
    setAcao(nova);
    setErro(null);
    if (nova === 'verba' && !valor && opcoes && opcoes.target.daily_micros !== null) setValor(verbaNoCampo(opcoes.target.daily_micros));
  }

  function recusar(e: Erro) {
    focar.current = e.noValor ? 'valor' : 'erro';
    setErro(e);
  }

  async function enviar(e: FormEvent) {
    e.preventDefault();
    if (enviando || !opcoes || !acao) return;
    const conferido = conferirPedido(opcoes, { acao, valor }, verba, inicial?.recomendacao ?? null);
    if (!conferido.ok) return recusar({ texto: conferido.erro, noValor: conferido.noValor, ver: conferido.ver, limites: conferido.limites });
    setErro(null);
    setEnviando(true);
    const r = await chamar(() => api.POST('/v1/actions', { body: conferido.corpo }));
    setEnviando(false);
    if (!r.ok) {
      const recusa = erroDoPedido(r.problema);
      return recusar({ texto: recusa.erro, noValor: false, ver: recusa.ver, limites: recusa.limites });
    }
    focar.current = 'criado';
    setCriado(r.data);
    setAnuncio('Pedido criado. Ele espera a aprovação com o código do app.');
    aoCriar();
  }

  const botaoFechar = (
    <button className="btn" type="button" onClick={fechar}>
      Fechar
    </button>
  );

  const campoDoOnde = lista && temOnde(lista.onde) && (
    <div className="campo">
      <label htmlFor="pd-alvo">Onde</label>
      <select ref={campoOnde} className="input" id="pd-alvo" value={alvo} disabled={enviando} aria-describedby={lista.lidaEm ? 'pd-lista' : undefined} onChange={(e) => mudarOnde(e.target.value)}>
        <option value="">A campanha inteira</option>
        {lista.onde.conjuntos.length > 0 && (
          <optgroup label="Conjuntos">
            {lista.onde.conjuntos.map((c) => (
              <option key={c.valor} value={c.valor}>
                {c.rotulo}
              </option>
            ))}
          </optgroup>
        )}
        {lista.onde.anuncios.length > 0 && (
          <optgroup label="Anúncios">
            {lista.onde.anuncios.map((a) => (
              <option key={a.valor} value={a.valor}>
                {a.rotulo}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      {lista.lidaEm && (
        <p className="campo-dica" id="pd-lista">
          {lista.lidaEm}
        </p>
      )}
    </div>
  );

  const lendo = (
    <div className="pd-bloco" aria-busy="true">
      <p className="pd-nota">
        <Icone nome="refresh" />
        <span>{lendoNaPlataforma(campanha.provider)}</span>
      </p>
      <span className="esqueleto esqueleto--medio" />
      <span className="esqueleto" />
      <span className="esqueleto esqueleto--curto" />
    </div>
  );

  let corpo;
  let rodape;
  if (criado) {
    const alvoCriado = opcoes?.target ?? { kind: 'campanha', name: campanha.nome };
    corpo = (
      <div className="pd-feito">
        <span className="vazio-ic vazio-ic--ok" aria-hidden="true">
          <Icone nome="check" />
        </span>
        <h3 id="pd-feito-t" ref={tituloDoCriado} tabIndex={-1}>
          Pedido criado
        </h3>
        <p>
          <b>{tituloDoPedido(criado.action, alvoCriado)}.</b> {depoisDeCriar(criado.status, campanha.provider)}
        </p>
      </div>
    );
    rodape = (
      <>
        {botaoFechar}
        <Link className="btn btn--primary" href={enderecoDoPedido(criado.id)}>
          Ver em Aprovações
        </Link>
      </>
    );
  } else if (falha) {
    corpo = (
      <>
        {campoDoOnde}
        <div className={falha.tipo === 'fora' ? 'pd-aviso pd-aviso--perigo' : 'pd-aviso'} role="alert">
          <Icone nome={falha.tipo === 'fora' ? 'alert-circle' : falha.tipo === 'reconectar' ? 'plug' : 'alert'} />
          <div>
            <b id="pd-falha" ref={tituloDaFalha} tabIndex={-1}>
              {falha.titulo}
            </b>
            <span>{falha.texto}</span>
            {falha.tipo === 'fora' && (
              <button className="btn btn--sm" type="button" onClick={tentarDeNovo}>
                <Icone nome="refresh" pequeno />
                Tentar de novo
              </button>
            )}
            {falha.tipo === 'reconectar' &&
              (podeVerContas ? (
                <Link className="btn btn--primary btn--sm" href="/contas">
                  Abrir Contas conectadas
                </Link>
              ) : (
                <span>Quem conecta as contas é o Dono ou o Administrador.</span>
              ))}
          </div>
        </div>
      </>
    );
    rodape = botaoFechar;
  } else if (!opcoes || !agoraNoObjeto) {
    corpo = (
      <>
        {campoDoOnde}
        {lendo}
      </>
    );
    rodape = botaoFechar;
  } else {
    corpo = (
      <>
        {campoDoOnde}
        <div className="pd-bloco">
          <p className="rotulo-marca">{agoraNoObjeto.titulo}</p>
          <dl className="pd-agora">
            {agoraNoObjeto.linhas.map((l) => (
              <Fragment key={l.rotulo}>
                <dt>{l.rotulo}</dt>
                <dd>
                  {l.valor}
                  {l.sub && <small>{l.sub}</small>}
                </dd>
              </Fragment>
            ))}
          </dl>
        </div>
        {dividida && (
          <div className="pd-aviso" id="pd-dividida">
            <Icone nome="info" />
            <div>
              <b>{dividida.titulo}</b>
              <span>
                <TextoRico frase={dividida.texto} />
              </span>
              {dividida.campanhas.length > 0 && (
                <ul className="pd-dividida" aria-label="Campanhas que dividem esta verba">
                  {dividida.campanhas.map((c, i) => (
                    <li key={`${i}-${c.nome}`}>
                      <span>{c.nome}</span>
                      <span>{c.papel}</span>
                    </li>
                  ))}
                  {dividida.mais && (
                    <li>
                      <span>{dividida.mais}</span>
                    </li>
                  )}
                </ul>
              )}
              <span>{dividida.depois}</span>
            </div>
          </div>
        )}
        {acoes.length === 0 ? (
          <p className="pd-aviso">
            <Icone nome="alert" />
            <span>{semOpcoes(opcoes)}</span>
          </p>
        ) : (
          <>
            <fieldset className="campo">
              <legend>O que você quer mudar?</legend>
              <div className="pd-escolha" ref={escolha}>
                {acoes.map((a) => (
                  <label className="pd-opcao" key={a.acao}>
                    <input type="radio" name="pd-acao" value={a.acao} checked={acao === a.acao} disabled={enviando} onChange={() => mudarAcao(a.acao)} />
                    <Icone nome={a.icone} />
                    {a.rotulo}
                  </label>
                ))}
              </div>
            </fieldset>
            {dica && (
              <div className="campo">
                <label htmlFor="pd-valor">Nova verba diária</label>
                <div className="pd-verba">
                  <div className="pd-valor">
                    <span aria-hidden="true">R$</span>
                    <input
                      ref={campoValor}
                      id="pd-valor"
                      inputMode="decimal"
                      autoComplete="off"
                      maxLength={10}
                      value={valor}
                      disabled={enviando}
                      aria-invalid={erro?.noValor ? true : undefined}
                      aria-describedby={erro?.noValor ? 'pd-dica pd-erro' : 'pd-dica'}
                      onChange={(e) => {
                        setValor(e.target.value);
                        setErro(null);
                      }}
                    />
                  </div>
                  {dica.atalhos &&
                    [dica.atalhos.reduzir, dica.atalhos.aumentar].map((atalho) => (
                      <button
                        className="btn btn--sm"
                        type="button"
                        key={atalho.rotulo}
                        disabled={enviando}
                        onClick={() => {
                          setValor(atalho.valor);
                          setErro(null);
                        }}
                      >
                        {atalho.rotulo}
                      </button>
                    ))}
                </div>
                <p className="campo-dica" id="pd-dica">
                  {dica.texto}
                </p>
              </div>
            )}
            {erro && (
              <p className="campo-erro" id="pd-erro" ref={paragrafoDoErro} role="alert" tabIndex={-1}>
                {erro.texto}
                {erro.ver && (
                  <>
                    {' '}
                    <Link className="link-bt" href={erro.ver}>
                      Ver o pedido
                    </Link>
                  </>
                )}
                {/* Com o aviso dos limites na tela, o atalho já está nele. */}
                {erro.limites && podeDefinirLimites && limites?.tipo !== 'sem' && (
                  <>
                    {' '}
                    <Link className="link-bt" href="/verba#limites">
                      Definir os limites
                    </Link>
                  </>
                )}
              </p>
            )}
            {efeito && (
              <p className="pd-efeito" id="pd-efeito" role="status">
                <TextoRico frase={efeito} />
              </p>
            )}
          </>
        )}
        {limites?.tipo === 'sem' && (
          <div className="pd-aviso">
            <Icone nome="alert" />
            <div>
              <b>{limites.titulo}</b>
              <span>{limites.texto}</span>
              {podeDefinirLimites ? (
                <Link className="btn btn--sm" href="/verba#limites">
                  Definir os limites
                </Link>
              ) : (
                <span>Quem define é o Dono ou o Administrador.</span>
              )}
            </div>
          </div>
        )}
        {limites?.tipo === 'ok' && (
          <div className="pd-bloco">
            <p className="rotulo-marca">Limites da empresa</p>
            <ul className="pd-limites">
              {limites.linhas.map((l) => (
                <li key={l.rotulo}>
                  <span>{l.rotulo}</span>
                  <b>{l.valor}</b>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="pd-nota">
          <Icone nome="shield" />
          <span>{notaDoPedido(campanha.provider)}</span>
        </p>
      </>
    );
    rodape = (
      <>
        <button className="btn" type="button" onClick={fechar} disabled={enviando}>
          Cancelar
        </button>
        <button className="btn btn--primary" type="submit" disabled={enviando || acoes.length === 0} aria-busy={enviando}>
          {enviando ? 'Pedindo…' : 'Pedir aprovação'}
        </button>
      </>
    );
  }

  return (
    <dialog
      ref={ref}
      id="dlg-pedir"
      className="dialogo dialogo--lado"
      aria-labelledby="dlg-pedir-t"
      onClose={() => {
        aoFechar();
        devolverFoco();
        // O navegador que não foca o botão no clique deixa o foco solto (na página, ou ainda dentro da gaveta que
        // acabou de fechar): ele vai para o botão de quem abriu.
        const foco = document.activeElement;
        if (!foco || foco === document.body || ref.current?.contains(foco)) (voltarPara?.() ?? reserva.current)?.focus({ preventScroll: true });
      }}
      onClick={(e) => {
        if (e.target === ref.current && !enviando) fechar();
      }}
    >
      <form className="dialogo-form" noValidate onSubmit={(e) => disparar(enviar(e))}>
        <div className="dialogo-cab">
          <div className="dlg-titulo">
            <p className="rotulo-marca">Pedir uma mudança</p>
            <h2 id="dlg-pedir-t">{campanha.nome}</h2>
          </div>
          <button className="btn btn--ghost btn--icon" type="button" onClick={fechar} aria-label="Fechar">
            <Icone nome="x" />
          </button>
        </div>
        <div className="dialogo-corpo" id="pedir-corpo">
          <p className="sr-only" role="status" aria-live="polite">
            {anuncio}
          </p>
          {corpo}
        </div>
        <div className="dialogo-acoes">{rodape}</div>
      </form>
    </dialog>
  );
}
