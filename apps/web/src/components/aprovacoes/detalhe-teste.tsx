'use client';

import type { ActionResponse, CreativeTestResponse } from '@liame/contracts';
import { type RefObject, useCallback, useEffect, useId, useState } from 'react';
import { linkDoGerenciador } from '@/components/criativos/campanha-nova-textos';
import { BotaoDetalhes } from '@/components/resultados/pecas';
import { Icone } from '@/components/ui/icone';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import type { Prova } from '@/lib/chave-de-acesso';
import { disparar } from '@/lib/disparar';
import { reaisDeMicros } from '@/lib/formato';
import { BarraDaDecisao, type Decisao } from './barra-da-decisao';
import {
  andamentoDoTeste,
  descontoDoTeste,
  dicaDoEncerrar,
  diaMes,
  fraseDaAtivacao,
  fraseDoTeste,
  idDoTeste,
  LIGACAO_DO_PEDIDO,
  linhasDoTeste,
  pausaDoPerdedor,
  podeEncerrar,
  proximaOlhada,
  rotulosDoEncerrar,
  publicoDoTeste,
  regrasDoTeste,
  riscoDoTeste,
  SITUACAO_DO_CUPOM,
  sinalDaVisita,
  situacaoDoTeste,
  tituloDoPedidoDoTeste,
  vereditoDoTeste,
} from './teste-textos';
import { cabecalhoDe, type Grupo, MOTIVOS_DA_RECUSA, politicaDe, prazoDe, resultadoDe, riscoDe, ROTULO_RISCO } from './textos';

// O teste de criativo em Aprovações (plano da região, R8; protótipo dos testes aprovado pelo dono em 13/11/2026; D-RG-76
// a D-RG-80 e D-RG-91 a D-RG-94). Os três pedidos do teste (criar a campanha de teste pausada, ativar e encerrar) abrem
// esta tela, que lê o teste e o acompanha depois de aprovado: a criação, o teste pronto com "Pedir para ativar", o teste
// rodando com o veredito da última olhada, os dois criativos lado a lado, o fim com o pedido para pausar o criativo que
// perdeu, e "Encerrar o teste", que não pede o código. Quem decide é o caixa: os pedidos confirmados de cada criativo.

type Props = {
  acao: ActionResponse;
  grupo: Grupo | null;
  agora: Date;
  podeDecidir: boolean;
  podeOperar: boolean;
  temApp: boolean;
  temChave?: boolean;
  titulo: RefObject<HTMLHeadingElement | null>;
  campoCodigo: RefObject<HTMLInputElement | null>;
  aoVoltar: () => void;
  aoAprovar: (acao: ActionResponse, prova: Prova) => Promise<Decisao>;
  aoRecusar: (acao: ActionResponse, motivo: string) => Promise<Decisao>;
  /** Pede para ativar o teste pronto: devolve o problema, ou nulo quando o pedido foi criado (e a tela o abre). */
  aoPedirAtivar: (teste: string) => Promise<Problema | null>;
  /** Pede para pausar o criativo que perdeu: devolve o problema, ou nulo quando o pedido foi feito. */
  aoPedirPausa: (teste: string) => Promise<Problema | null>;
  /** Abre outro pedido da lista (o de ativar ou o de pausar o criativo que perdeu). */
  aoAbrirPedido: (pedido: string) => void;
};

type Lido = { estado: 'lendo' } | { estado: 'ok'; t: CreativeTestResponse } | { estado: 'erro'; problema: Problema };

const MOTIVOS = MOTIVOS_DA_RECUSA.map((m) => ({ valor: m, rotulo: m }));
/** Enquanto a campanha de teste está sendo criada, a tela pergunta de novo neste intervalo. */
const ESPERA_MS = 10_000;
const reais = (micros: number) => reaisDeMicros(BigInt(Math.round(micros)));
/** O dia de hoje no fuso de Brasília (o das lojas do piloto), para o dia do teste. */
const hojeDe = (agora: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(agora);

export function DetalheTeste({ acao, grupo, agora, podeDecidir, podeOperar, temApp, temChave = false, titulo, campoCodigo, aoVoltar, aoAprovar, aoRecusar, aoPedirAtivar, aoPedirPausa, aoAbrirPedido }: Props) {
  const ids = useId();
  const id = idDoTeste(acao.resource_id);
  const [lido, setLido] = useState<Lido>({ estado: 'lendo' });
  const [detalhes, setDetalhes] = useState(false);
  const [encerrando, setEncerrando] = useState<'nao' | 'confirmar' | 'enviando'>('nao');
  const [enviando, setEnviando] = useState<'ativar' | 'pausar' | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const cab = cabecalhoDe(acao, agora);
  const criar = acao.tool === 'teste_de_criativo_criar';
  const ativar = acao.tool === 'teste_de_criativo_ativar';

  const ler = useCallback(async () => {
    if (!id) return;
    const r = await chamar(() => api.GET('/v1/creative-tests/{id}', { params: { path: { id } } }));
    setLido(r.ok ? { estado: 'ok', t: r.data } : { estado: 'erro', problema: r.problema });
  }, [id]);

  useEffect(() => {
    setLido({ estado: 'lendo' });
    setEncerrando('nao');
    setErro(null);
    disparar(ler());
  }, [ler, acao.status, acao.updated_at]);

  // Criando na Meta e pedindo os cupons ao Regem: a tela pergunta de novo até o teste ficar pronto.
  const criando = lido.estado === 'ok' && lido.t.status === 'criando';
  useEffect(() => {
    if (!criando) return;
    const t = setInterval(() => disparar(ler()), ESPERA_MS);
    return () => clearInterval(t);
  }, [criando, ler]);

  async function encerrar() {
    if (!id) return;
    setEncerrando('enviando');
    setErro(null);
    const r = await chamar(() => api.POST('/v1/creative-tests/{id}/stop', { params: { path: { id } } }));
    setEncerrando('nao');
    if (!r.ok) return setErro(mensagemDe(r.problema));
    setLido({ estado: 'ok', t: r.data });
  }

  async function pedir(qual: 'ativar' | 'pausar') {
    if (!id) return;
    setEnviando(qual);
    setErro(null);
    const problema = await (qual === 'ativar' ? aoPedirAtivar(id) : aoPedirPausa(id));
    setEnviando(null);
    if (problema) return setErro(mensagemDe(problema));
    await ler();
  }

  const voltar = (
    <button className="btn btn--ghost btn--sm voltar" type="button" onClick={aoVoltar}>
      <Icone nome="chevron-left" />
      Voltar para a lista
    </button>
  );
  const nome = lido.estado === 'ok' ? lido.t.name : null;
  const cabecalho = (
    <>
      <div className="det-cab">
        <span>
          <b>{cab.quem}</b> {cab.verbo}
        </span>
        <span>· {cab.quando}</span>
        {criar && <span>· em Criativos, na peça aprovada: “Testar contra outra peça”</span>}
      </div>
      <h2 className="det-titulo" id="ap-det-titulo" ref={titulo} tabIndex={-1}>
        {tituloDoPedidoDoTeste(acao.tool, nome)}
      </h2>
    </>
  );

  if (!id) {
    return (
      <>
        {voltar}
        {cabecalho}
        <p className="nota">
          <Icone nome="alert-circle" />
          <span>O pedido não aponta para um teste de criativo do Liame.</span>
        </p>
      </>
    );
  }
  if (lido.estado !== 'ok') {
    return (
      <>
        {voltar}
        {cabecalho}
        {lido.estado === 'erro' ? (
          <div className="plano-espera" role="alert">
            <p className="nota">
              <Icone nome="alert-circle" />
              <span>Não foi possível abrir o teste. {mensagemDe(lido.problema)}</span>
            </p>
            <div className="vazio-acoes">
              <button className="btn btn--sm" type="button" onClick={() => disparar(ler())}>
                <Icone nome="refresh" pequeno />
                Tentar de novo
              </button>
            </div>
          </div>
        ) : (
          <div className="plano-espera" aria-busy="true">
            <p className="sr-only">Abrindo o teste…</p>
            <span className="esqueleto esqueleto--curto" aria-hidden="true" />
            <span className="esqueleto" aria-hidden="true" />
          </div>
        )}
      </>
    );
  }

  const t = lido.t;
  const hoje = hojeDe(agora);
  const pendente = grupo === 'pendente';
  const situacao = situacaoDoTeste(t);
  const risco = riscoDe(acao);
  const veredito = vereditoDoTeste(t);
  const andamento = t.status === 'pedido' ? null : andamentoDoTeste(t, hoje);
  const proxima = t.status === 'rodando' ? proximaOlhada(t) : null;
  const pausa = pausaDoPerdedor(t);
  const linhas = linhasDoTeste(t);
  const sinal = sinalDaVisita(t);
  const vencedor = t.result?.verdict === 'venceu' ? t.result.winner : null;
  const resultado = pendente ? null : resultadoDe(acao);
  const perigo = t.status === 'interrompido' || t.status === 'cancelado';
  const metade = reais(t.daily_budget_micros / 2);
  const rotulos = rotulosDoEncerrar(t);

  const encerrarBotoes = podeOperar && podeEncerrar(t) && (
    <>
      <div className="r8-acoes">
        {encerrando === 'nao' ? (
          <button className="btn" type="button" onClick={() => setEncerrando('confirmar')} aria-describedby={`${ids}-encerrar-d`}>
            <Icone nome="pause" />
            {rotulos.botao}
          </button>
        ) : (
          <>
            <button className="btn btn--primary" type="button" onClick={() => disparar(encerrar())} disabled={encerrando === 'enviando'} aria-describedby={`${ids}-encerrar-d`}>
              <Icone nome="pause" />
              {encerrando === 'enviando' ? 'Encerrando…' : rotulos.confirmar}
            </button>
            <button className="btn btn--ghost" type="button" onClick={() => setEncerrando('nao')} disabled={encerrando === 'enviando'}>
              Deixar como está
            </button>
          </>
        )}
      </div>
      <p className="campo-dica" id={`${ids}-encerrar-d`}>
        {dicaDoEncerrar(t)}
      </p>
    </>
  );

  return (
    <>
      {voltar}
      {cabecalho}
      <div className="det-chips">
        <span className={`st st--${situacao.tom}`}>{situacao.rotulo}</span>
        {pendente && <span className={`risco risco--${risco}`}>{ROTULO_RISCO[risco]}</span>}
      </div>

      {criar && pendente && (
        <div className="secao secao--lite">
          <p className="lite-frase lite-frase--grande">{fraseDoTeste(t)}</p>
          <div className="lite-chips">
            <span className="lite-chip">{reais(t.daily_budget_micros)} por dia, dentro da verba do mês</span>
            <span className="lite-chip">Nasce pausada</span>
            <span className="lite-chip">Dá para encerrar a qualquer hora</span>
          </div>
        </div>
      )}
      {ativar && pendente && (
        <div className="secao">
          <p className="lite-frase lite-frase--grande">{fraseDaAtivacao(t)}</p>
        </div>
      )}

      {andamento && (
        <div className="secao">
          {perigo ? (
            <div className="pd-aviso pd-aviso--perigo" role="alert">
              <Icone nome="alert-circle" />
              <div>
                <b>{t.status === 'interrompido' ? 'O teste foi interrompido' : 'A campanha de teste não foi criada'}</b>
                <span>{andamento}</span>
              </div>
            </div>
          ) : (
            <div className="politica">
              <Icone nome={t.status === 'encerrado' ? 'pause' : t.status === 'criando' ? 'clock' : 'check'} />
              <span>{andamento}</span>
            </div>
          )}
          {criando && (
            <p className="nota" role="status">
              <Icone nome="refresh" pequeno />
              <span>Você não precisa fazer nada: esta tela se atualiza sozinha.</span>
            </p>
          )}

          {veredito && (
            <div className={`r8-veredito${veredito.venceu ? ' r8-veredito--venceu' : ''}`} id={`${ids}-veredito`}>
              <b>{veredito.titulo}</b>
              <span>{veredito.texto}</span>
            </div>
          )}
          {proxima && (
            <p className="nota">
              <Icone nome="clock" pequeno />
              <span>
                A próxima olhada é a do dia {proxima.dia} ({proxima.data}), com os pedidos até esse dia. Ela sai no dia seguinte, depois da leitura do caixa; entre uma olhada e outra, o Liame não espia.
              </span>
            </p>
          )}

          {pausa.tipo === 'pedir' && podeOperar && (
            <>
              <div className="r8-acoes">
                <button className="btn btn--primary" type="button" onClick={() => disparar(pedir('pausar'))} disabled={enviando !== null} aria-describedby={`${ids}-pausa-d`}>
                  <Icone nome="pause" />
                  {enviando === 'pausar' ? 'Pedindo…' : `Pedir: pausar o criativo ${pausa.perdeu}`}
                </button>
              </div>
              <p className="campo-dica" id={`${ids}-pausa-d`}>
                {pausa.dica}
              </p>
            </>
          )}
          {pausa.tipo === 'esperando' && (
            <p className="nota">
              <Icone nome="clock" pequeno />
              <span>
                {pausa.texto}{' '}
                <button className="btn btn--sm btn--ghost" type="button" onClick={() => aoAbrirPedido(pausa.actionId)}>
                  Abrir o pedido
                </button>
              </span>
            </p>
          )}
          {pausa.tipo === 'feito' && (
            <p className="nota">
              <Icone nome="check" pequeno />
              <span>{pausa.texto}</span>
            </p>
          )}

          {t.status === 'pronto' &&
            (t.pending_action_id ? (
              t.pending_action_id !== acao.id && (
                <div className="r8-acoes">
                  <button className="btn btn--sm" type="button" onClick={() => aoAbrirPedido(t.pending_action_id!)}>
                    Abrir o pedido de ativar
                  </button>
                </div>
              )
            ) : (
              podeOperar && (
                <>
                  <div className="r8-acoes">
                    <button className="btn btn--primary" type="button" onClick={() => disparar(pedir('ativar'))} disabled={enviando !== null} aria-describedby={`${ids}-ativar-d`}>
                      <Icone nome="play" />
                      {enviando === 'ativar' ? 'Pedindo…' : 'Pedir para ativar'}
                    </button>
                  </div>
                  <p className="campo-dica" id={`${ids}-ativar-d`}>
                    Ativar é outro pedido, com o código do app: a verba diária do teste ({reais(t.daily_budget_micros)}) passa de novo pelo teto por campanha e pela verba do mês. A volta é “Encerrar o teste”.
                  </p>
                </>
              )
            ))}

          {encerrarBotoes}
          {erro && (
            <p className="campo-erro" role="alert">
              {erro}
            </p>
          )}
          {t.meta.campaign_id && (
            <div className="r8-acoes">
              <a className="btn btn--sm" href={linkDoGerenciador(t.meta.campaign_id, t.meta.account_id)} target="_blank" rel="noopener noreferrer">
                <Icone nome="external" pequeno />
                Abrir no Gerenciador de Anúncios
                <span className="sr-only"> (abre em outra aba)</span>
              </a>
            </div>
          )}
        </div>
      )}

      {resultado && (
        <div className="secao">
          <div className="politica">
            <Icone nome={resultado.ok ? 'check' : 'x'} />
            <span>{resultado.texto}</span>
          </div>
        </div>
      )}

      {linhas.length > 0 && (
        <div className="secao">
          <p className="rotulo-marca">O que cada criativo trouxe</p>
          <div className="r8-envolve">
            <table className="tabela r8-tabela r8-ab">
              <caption className="sr-only">Os dois criativos do teste, lado a lado: o gasto, as visitas, os pedidos e a receita no caixa de cada um, até a última olhada</caption>
              <thead>
                <tr>
                  <th scope="col">Até a última olhada</th>
                  {(['A', 'B'] as const).map((l) => (
                    <th scope="col" className={`n${vencedor === l ? ' r8-frente' : ''}`} key={l}>
                      <span className="r8-letra" aria-hidden="true">
                        {l}
                      </span>{' '}
                      <span className="sr-only">Criativo </span>
                      {t.arms.find((a) => a.letter === l)?.title}
                      {vencedor === l && <small>venceu</small>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {linhas.map((linha) => (
                  <tr key={linha.rotulo}>
                    <th scope="row">
                      {linha.rotulo}
                      {linha.sub && <small>{linha.sub}</small>}
                    </th>
                    {(['A', 'B'] as const).map((l) => {
                      const c = linha.valores[l];
                      return (
                        <td className={`n${vencedor === l ? ' r8-frente' : ''}`} key={l}>
                          {c.forte ? <b>{c.texto}</b> : c.texto}
                          {c.sub && <small>{c.sub}</small>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="nota">
            <Icone nome="info" pequeno />
            <span>Quem decide são os pedidos no caixa. Visitas e cliques são sinal, não prova: um criativo pode trazer mais visita e menos pedido.</span>
          </p>
          {sinal && t.result?.verdict === 'sem_vencedor' && (
            <p className="nota">
              <Icone nome="chart" pequeno />
              <span>{sinal}</span>
            </p>
          )}
        </div>
      )}

      <div className="secao">
        <p className="rotulo-marca">Os dois criativos</p>
        <ul className="r8-pecas">
          {t.arms.map((a) => (
            <li className="r8-peca" key={a.letter}>
              <b>
                <span className="r8-letra" aria-hidden="true">
                  {a.letter}
                </span>{' '}
                <span className="sr-only">Criativo {a.letter}: </span>
                {a.title}
              </b>
              <span className="r8-texto">{a.ad_text}</span>
              <span>
                cupom <b className="num">{a.coupon_code}</b> · {SITUACAO_DO_CUPOM[a.coupon_status]}
              </span>
            </li>
          ))}
        </ul>
        <p className="nota">
          <Icone nome="ticket" pequeno />
          <span>
            Os dois cupons: {descontoDoTeste(t.discount)}, até {diaMes(t.discount.valid_until)}. Os dois anúncios levam ao cardápio da loja.
          </span>
        </p>
        <p className="nota">
          <Icone nome="info" pequeno />
          <span>Só o criativo muda: quem vê ({publicoDoTeste(t)}), a verba ({metade} por dia em cada um), o objetivo e o desconto são iguais nos dois.</span>
        </p>
        <p className="nota">
          <Icone nome="link" pequeno />
          <span>{LIGACAO_DO_PEDIDO}</span>
        </p>
      </div>

      {criar && pendente && (
        <div className="secao">
          <BotaoDetalhes aberto={detalhes} controla={`${ids}-detalhes`} aoAlternar={() => setDetalhes((v) => !v)} />
        </div>
      )}
      {pendente && (
        <div id={`${ids}-detalhes`} hidden={criar && !detalhes}>
          {criar && (
            <div className="secao">
              <p className="rotulo-marca">O que o Liame cria na Meta</p>
              <p className="nota">
                <Icone nome="megaphone" pequeno />
                <span>
                  Uma campanha, “Teste · {t.name}”, com dois conjuntos iguais: {publicoDoTeste(t)}, {metade} por dia cada um. A verba fica em cada conjunto, nunca na campanha, para o teste continuar meio a meio.
                </span>
              </p>
              <p className="nota">
                <Icone nome="link" pequeno />
                <span>Um anúncio em cada conjunto, com o criativo dele e a linha do cupom dele no fim do texto. Os dois cupons são criados no Regem depois da aprovação, com o mesmo desconto.</span>
              </p>
              <p className="nota">
                <Icone nome="pause" pequeno />
                <span>Tudo nasce pausado. Ativar é outro pedido, com outra aprovação.</span>
              </p>
            </div>
          )}
          <div className="secao">
            <p className="rotulo-marca">Risco e limites</p>
            <div className="politica">
              <Icone nome="shield" />
              <span>
                <b className={`risco risco--${risco}`}>{ROTULO_RISCO[risco]}.</b> {criar ? riscoDoTeste(t) : `A verba diária do teste (${reais(t.daily_budget_micros)}) entra na verba do mês, conferida de novo agora com o teto por campanha.`}{' '}
                {politicaDe(acao)}
              </span>
            </div>
            {criar &&
              regrasDoTeste(t).map((r) => (
                <p className="nota" key={r.texto}>
                  <Icone nome={r.icone} pequeno />
                  <span>{r.texto}</span>
                </p>
              ))}
            <p className="nota">
              <Icone nome="clock" pequeno />
              <span>Prazo deste pedido: {prazoDe(acao, agora)}. Se ninguém decidir, o pedido expira e nada é feito.</span>
            </p>
          </div>
        </div>
      )}

      {pendente &&
        (podeDecidir ? (
          <BarraDaDecisao
            key={`${acao.id}:${acao.plan_hash}`}
            ids={ids}
            temApp={temApp}
            temChave={temChave}
            campoCodigo={campoCodigo}
            motivos={MOTIVOS}
            dica={
              ativar
                ? 'O código de 6 números que o app autenticador mostra agora. A aprovação ativa a campanha de teste: os dois criativos passam a gastar.'
                : 'O código de 6 números que o app autenticador mostra agora. A aprovação cria a campanha de teste pausada.'
            }
            aoAprovar={(prova) => aoAprovar(acao, prova)}
            aoRecusar={(motivo) => aoRecusar(acao, motivo)}
          />
        ) : (
          <p className="nota ap-so-leitura">
            <Icone nome="lock" />
            <span>Só quem pode aprovar decide este pedido. Você acompanha por aqui.</span>
          </p>
        ))}
    </>
  );
}
