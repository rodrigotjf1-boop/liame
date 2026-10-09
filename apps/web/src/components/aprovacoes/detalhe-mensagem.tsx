'use client';

import type { MessagingCampaignDetailResponse } from '@liame/contracts';
import { type RefObject, useEffect, useId, useRef, useState } from 'react';
import { detalheDaMensagem, numerosDa } from '@/components/mensagens/textos';
import { ConfirmaNaLinha } from '@/components/ui/confirma-na-linha';
import { Icone } from '@/components/ui/icone';
import { api, chamar } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { quandoComHora } from '@/lib/formato';
import { quemPediu } from './anuncio-textos';
import { BarraDaDecisao, type Decisao } from './barra-da-decisao';
import { type AcaoDeMensagem, impedimentoDoPedido, MOTIVOS_DA_MENSAGEM, type Pausa, resultadoDaPausa, resultadoDoEnvio, textosDaMensagem, type Trecho } from './mensagem-textos';
import { aprovacaoParcial, type Grupo, identidadeDoPlano, prazoDe, ROTULO_RISCO } from './textos';

// O pedido de mensagem de WhatsApp aberto (mockups/prototipo-mensagens.html, P15 aprovado em 09/10/2026). Esperando a
// decisão: o que impede a aprovação (quando há), a frase do que acontece, as quatro partes à vista (a mensagem, quem
// recebe, quando sai, quanto custa), o cupom, o risco e a aprovação com o código do app. Decidido: o resultado, com os
// números lidos do RegemCast na hora, e a pausa do que ainda não saiu, que é direta (confirmação na tela, sem código).

export type Feito = { ok: true } | { ok: false; texto: string };

type Props = {
  acao: AcaoDeMensagem;
  grupo: Grupo | null;
  agora: Date;
  pro: boolean;
  /** Pode aprovar, recusar e conferir de novo (`acoes.aprovar`). */
  podeDecidir: boolean;
  /** Pode pedir ação em campanha (`campanhas.operar`): pausar o envio. */
  podeOperar: boolean;
  temApp: boolean;
  /** Quem pausou este envio e quando, quando a lista traz o pedido de pausa. */
  pausa: Pausa;
  titulo: RefObject<HTMLHeadingElement | null>;
  campoCodigo: RefObject<HTMLInputElement | null>;
  aoVoltar: () => void;
  aoAprovar: (acao: AcaoDeMensagem, codigo: string) => Promise<Decisao>;
  aoRecusar: (acao: AcaoDeMensagem, motivo: string) => Promise<Decisao>;
  /** Lê o plano de agora no RegemCast e guarda no pedido. */
  aoConferir: (acao: AcaoDeMensagem) => Promise<Feito>;
  /** Pausa o envio (direto, sem o código do app). */
  aoPausar: (acao: AcaoDeMensagem) => Promise<Feito>;
};

const MOTIVOS = MOTIVOS_DA_MENSAGEM.map((m) => ({ valor: m, rotulo: m }));
type Leitura = { tipo: 'nada' } | { tipo: 'carregando' } | { tipo: 'ok'; dados: MessagingCampaignDetailResponse } | { tipo: 'erro' };

function Trechos({ trechos }: { trechos: Trecho[] }) {
  return (
    <>
      {trechos.map((t, i) =>
        t.variavel ? (
          <span className="mens-var" key={i}>
            {t.t}
          </span>
        ) : (
          <span key={i}>{t.t}</span>
        ),
      )}
    </>
  );
}

export function DetalheMensagem({ acao, grupo, agora, pro, podeDecidir, podeOperar, temApp, pausa, titulo, campoCodigo, aoVoltar, aoAprovar, aoRecusar, aoConferir, aoPausar }: Props) {
  const ids = useId();
  const t = textosDaMensagem(acao);
  const quem = quemPediu(acao);
  const plano = identidadeDoPlano(acao);
  const prazo = prazoDe(acao, agora);
  const ehPausa = acao.tool === 'mensagem_pausar';
  const noRegemcast = !ehPausa && acao.status === 'executada';
  const [leitura, setLeitura] = useState<Leitura>({ tipo: 'nada' });
  const [releitura, setReleitura] = useState(0);
  const [pausando, setPausando] = useState<'nao' | 'confirmando' | 'enviando'>('nao');
  const [erroDaPausa, setErroDaPausa] = useState<string | null>(null);
  const botaoPausar = useRef<HTMLButtonElement>(null);
  const voltaDaPausa = acao.undone_by?.status ?? null;

  // Depois do envio, os números são os do RegemCast, lidos na hora (de novo quando a pausa anda, ou a pedido).
  useEffect(() => {
    if (!noRegemcast) return setLeitura({ tipo: 'nada' });
    let vivo = true;
    setLeitura((l) => (l.tipo === 'ok' ? l : { tipo: 'carregando' }));
    disparar(
      chamar(() => api.GET('/v1/messaging/campaigns/{id}', { params: { path: { id: acao.message.campaign_id }, query: { connected_account_id: acao.account_id } } })).then((r) => {
        if (vivo) setLeitura(r.ok ? { tipo: 'ok', dados: r.data } : { tipo: 'erro' });
      }),
    );
    return () => {
      vivo = false;
    };
  }, [noRegemcast, acao.message.campaign_id, acao.account_id, voltaDaPausa, releitura]);

  // Outro pedido aberto: a confirmação da pausa era do anterior.
  useEffect(() => {
    setPausando('nao');
    setErroDaPausa(null);
  }, [acao.id]);

  async function pausar() {
    setPausando('enviando');
    setErroDaPausa(null);
    const r = await aoPausar(acao);
    setPausando('nao');
    if (!r.ok) setErroDaPausa(r.texto);
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
          <b>{quem.nome}</b> pediu
        </span>
        <span>
          · {quandoComHora(acao.created_at, agora)}
          {quem.funcionario ? ' · funcionário de IA' : ''}
        </span>
      </div>
      <h2 className="det-titulo" id="ap-det-titulo" ref={titulo} tabIndex={-1}>
        {t.titulo}
      </h2>
    </>
  );
  const quatro = (
    <div className="mens-quatro">
      <section className="mens-bloco" aria-labelledby={`${ids}-b1`}>
        <h3 id={`${ids}-b1`}>A mensagem</h3>
        <div className="mens-bolha" role="group" aria-label="A mensagem, como aparece no WhatsApp de quem recebe">
          {t.bolha.titulo && (
            <b>
              <Trechos trechos={t.bolha.titulo} />
            </b>
          )}
          <span>
            <Trechos trechos={t.bolha.corpo} />
          </span>
          {t.bolha.rodape && <small>{t.bolha.rodape}</small>}
          {t.bolha.botoes.map((b) => (
            <span className="mens-bolha-bt" key={b}>
              {b}
            </span>
          ))}
        </div>
        <p>{t.bolha.nota}</p>
      </section>
      <section className="mens-bloco" aria-labelledby={`${ids}-b2`}>
        <h3 id={`${ids}-b2`}>Quem recebe</h3>
        <p className="mens-forte num">{t.quem.forte}</p>
        <p>{t.quem.publico}</p>
        <ul className="mens-fora" aria-label="A conta de quem recebe">
          {t.quem.conta.map((c) => (
            <li key={c.rotulo}>
              <span>{c.rotulo}</span>
              <b className="num">{c.valor}</b>
            </li>
          ))}
        </ul>
        <p>{t.quem.nota}</p>
      </section>
      <section className="mens-bloco" aria-labelledby={`${ids}-b3`}>
        <h3 id={`${ids}-b3`}>Quando sai</h3>
        <p className="mens-forte">{t.quando.forte}</p>
        <p>{t.quando.texto}</p>
      </section>
      <section className="mens-bloco" aria-labelledby={`${ids}-b4`}>
        <h3 id={`${ids}-b4`}>Quanto custa</h3>
        <p className="mens-forte num">{t.custo.forte}</p>
        <p>{t.custo.texto}</p>
      </section>
    </div>
  );
  const cupom = t.cupom && (
    <div className="secao">
      <p className="rotulo-marca">O cupom da mensagem</p>
      <p className="nota">
        <Icone nome="ticket" />
        <span>
          <b>{t.cupom.codigo}</b>: {t.cupom.texto}
        </span>
      </p>
    </div>
  );

  if (grupo !== 'pendente') {
    const campanha = leitura.tipo === 'ok' ? leitura.dados.campaign : null;
    const detalhe = leitura.tipo === 'ok' ? detalheDaMensagem(leitura.dados, agora) : null;
    const r = ehPausa ? resultadoDaPausa(acao) : resultadoDoEnvio(acao, campanha, leitura.tipo === 'ok' ? leitura.dados.cost : null, pausa);
    // A pausa já foi pedida (o worker a executa em instantes): o botão não aparece de novo.
    const pausaPedida = voltaDaPausa !== null && voltaDaPausa !== 'cancelada' && voltaDaPausa !== 'expirada' && voltaDaPausa !== 'falhou';
    return (
      <>
        {voltar}
        {cabecalho}
        <p className="plano-id">
          Plano {plano.plano} · modelo <b>{acao.message.template.name}</b>
        </p>
        <div className="secao">
          <div className={r.tom === 'neutro' ? 'resultado' : `resultado resultado--${r.tom}`} role={r.tom === 'espera' ? 'status' : undefined} id="mens-resultado">
            <Icone nome={r.icone} />
            <span>
              {r.forte && <b>{r.forte}</b>}
              {r.texto}
            </span>
          </div>
          {noRegemcast && leitura.tipo === 'carregando' && (
            <p className="nota" aria-busy="true">
              <Icone nome="clock" />
              <span>Lendo o andamento no RegemCast…</span>
            </p>
          )}
          {noRegemcast && leitura.tipo === 'erro' && (
            <div className="desfazer">
              <p className="nota">
                <Icone nome="info" />
                <span>Não foi possível ler o andamento no RegemCast agora. O envio segue por lá.</span>
              </p>
              <button className="btn btn--sm" type="button" onClick={() => setReleitura((n) => n + 1)}>
                <Icone nome="refresh" pequeno />
                Ler de novo
              </button>
            </div>
          )}
          {r.podePausar && pausaPedida && (
            <p className="nota" role="status">
              <Icone nome="pause" />
              <span>A pausa foi pedida. O Liame pausa no RegemCast em instantes; o que já foi enviado não volta.</span>
            </p>
          )}
          {r.podePausar && !pausaPedida && podeOperar && (
            <div className="desfazer">
              {pausando === 'nao' ? (
                <button className="btn" type="button" ref={botaoPausar} data-mens-pausar onClick={() => setPausando('confirmando')}>
                  <Icone nome="pause" pequeno />
                  Pausar o envio
                </button>
              ) : (
                <ConfirmaNaLinha
                  texto="O que ainda não saiu fica parado. O que já foi enviado não volta."
                  rotulo="Pausar agora"
                  rotuloOcupado="Pausando…"
                  voltar="Continuar enviando"
                  ocupado={pausando === 'enviando'}
                  aoConfirmar={() => disparar(pausar())}
                  aoCancelar={() => {
                    setPausando('nao');
                    requestAnimationFrame(() => botaoPausar.current?.focus());
                  }}
                />
              )}
              {erroDaPausa && (
                <p className="campo-erro" role="alert">
                  {erroDaPausa}
                </p>
              )}
              <p className="nota">
                <Icone nome="info" />
                <span>Pausar segura o que ainda não saiu. O que já foi enviado não volta.</span>
              </p>
            </div>
          )}
          {campanha && r.podePausar && (
            <div className="desfazer">
              <button className="btn btn--sm" type="button" onClick={() => setReleitura((n) => n + 1)}>
                <Icone nome="refresh" pequeno />
                Ler de novo
              </button>
            </div>
          )}
        </div>
        {campanha && (
          <div className="secao">
            <p className="rotulo-marca">Como foi</p>
            <div className="mens-nums" role="group" aria-label="Como a mensagem foi">
              {numerosDa(campanha).map((n) => (
                <p className="mens-num" key={n.chave}>
                  <b className="num">{n.valor}</b>
                  <span>{n.rotulo}</span>
                </p>
              ))}
            </div>
          </div>
        )}
        {detalhe?.falhas && (
          <div className="secao">
            <p className="rotulo-marca">{detalhe.falhas.titulo}</p>
            {detalhe.falhas.semMotivo ? (
              <p className="nota">
                <Icone nome="info" />
                <span>O RegemCast não informou o motivo destas falhas.</span>
              </p>
            ) : (
              <ul className="mens-fora">
                {detalhe.falhas.itens.map((f) => (
                  <li key={f.chave}>
                    <span>
                      {f.titulo}
                      {f.acao ? `: ${f.acao}` : ''}
                    </span>
                    <b className="num">{f.quantas}</b>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div className="secao">
          <p className="rotulo-marca">O que foi pedido</p>
          {quatro}
        </div>
        {acao.status !== 'cancelada' && acao.status !== 'expirada' && cupom}
      </>
    );
  }

  const impede = impedimentoDoPedido(acao);
  const parcial = aprovacaoParcial(acao);
  return (
    <>
      {voltar}
      {cabecalho}
      {impede && (
        <div className="secao secao--lite">
          <div className={`resultado resultado--${impede.tom}`} role={impede.tom === 'falha' ? 'alert' : 'status'} id="mens-impede">
            <Icone nome={impede.icone} />
            <span>
              <b>{impede.forte}</b> {impede.texto}
            </span>
          </div>
        </div>
      )}
      {!pro && (
        <div className="secao secao--lite">
          <p className="lite-frase lite-frase--grande">{t.frase.map((x, i) => (x.b ? <b key={i}>{x.t}</b> : <span key={i}>{x.t}</span>))}</p>
          <div className="lite-chips">
            <span className={`risco risco--${t.risco}`}>{ROTULO_RISCO[t.risco]}</span>
            <span className="lite-chip">Mensagem enviada não volta</span>
            <span className="lite-chip">{prazo}</span>
          </div>
        </div>
      )}
      <p className="plano-id">
        Plano {plano.plano} · modelo <b>{acao.message.template.name}</b> · a aprovação vale só para este plano: mudou o texto, o público ou o horário, é outro pedido
      </p>
      <div className="secao">{quatro}</div>
      {cupom}
      <div className="secao">
        <p className="rotulo-marca">Risco e limites</p>
        <div className="politica">
          <Icone nome="shield" />
          <span>
            <b className={`risco risco--${t.risco}`}>{ROTULO_RISCO[t.risco]}.</b> {t.doRisco}
          </span>
        </div>
        <p className="nota">
          <Icone nome="undo" />
          <span>
            <b>Mensagem enviada não volta.</b> Depois de aprovar, dá para pausar o que ainda não saiu; o que já foi entregue, fica.
          </span>
        </p>
        <p className="nota">
          <Icone nome="clock" />
          <span>Prazo: {prazo}. Se ninguém decidir, o pedido expira e nada é enviado.</span>
        </p>
      </div>
      {parcial && (
        <p className="alerta-versao" role="status">
          <Icone nome="info" pequeno />
          <span>{parcial}</span>
        </p>
      )}
      {!podeDecidir ? (
        <p className="nota ap-so-leitura">
          <Icone nome="lock" />
          <span>Só quem pode aprovar decide este pedido. Você acompanha por aqui.</span>
        </p>
      ) : impede ? (
        <EsperaDoPedido key={`${acao.id}:${acao.plan_hash}`} ids={ids} aoConferir={() => aoConferir(acao)} aoRecusar={(motivo) => aoRecusar(acao, motivo)} />
      ) : (
        <BarraDaDecisao
          key={`${acao.id}:${acao.plan_hash}`}
          ids={ids}
          temApp={temApp}
          campoCodigo={campoCodigo}
          motivos={MOTIVOS}
          dica="O código de 6 números que o app autenticador mostra agora. A aprovação vale só para este plano."
          aoAprovar={(codigo) => aoAprovar(acao, codigo)}
          aoRecusar={(motivo) => aoRecusar(acao, motivo)}
        />
      )}
    </>
  );
}

/** Com um impedimento, o pedido não oferece "Aprovar": dá para conferir de novo (o plano de agora) ou recusar. */
function EsperaDoPedido({ ids, aoConferir, aoRecusar }: { ids: string; aoConferir: () => Promise<Feito>; aoRecusar: (motivo: string) => Promise<Decisao> }) {
  const primeiroMotivo = useRef<HTMLButtonElement>(null);
  const [recusando, setRecusando] = useState(false);
  const [ocupado, setOcupado] = useState<'conferir' | 'recusar' | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [conferido, setConferido] = useState(false);

  useEffect(() => {
    if (recusando) primeiroMotivo.current?.focus();
  }, [recusando]);

  async function conferir() {
    setErro(null);
    setConferido(false);
    setOcupado('conferir');
    const r = await aoConferir();
    setOcupado(null);
    if (r.ok) setConferido(true);
    else setErro(r.texto);
  }

  async function recusar(motivo: string) {
    setErro(null);
    setOcupado('recusar');
    const r = await aoRecusar(motivo);
    setOcupado(null);
    if (!r.ok) setErro(r.texto);
  }

  return (
    <div className="acoes-plano mens-espera">
      {erro && (
        <p className="campo-erro ap-erro" role="alert">
          {erro}
        </p>
      )}
      <p className="nota">
        <Icone nome="info" />
        <span>Enquanto isso não se resolve, o pedido espera aqui. Você pode recusar agora.</span>
      </p>
      <button className="btn" type="button" data-mens-conferir onClick={() => disparar(conferir())} disabled={ocupado !== null} aria-busy={ocupado === 'conferir'}>
        <Icone nome="refresh" pequeno />
        {ocupado === 'conferir' ? 'Conferindo…' : 'Conferir de novo'}
      </button>
      <button className="btn" type="button" aria-expanded={recusando} aria-controls={`${ids}-motivos`} onClick={() => setRecusando((x) => !x)} disabled={ocupado !== null}>
        <Icone nome="x" />
        Recusar
      </button>
      {conferido && (
        <p className="ap-dica" role="status">
          Conferido agora no RegemCast: o impedimento continua.
        </p>
      )}
      <div className="motivos" id={`${ids}-motivos`} hidden={!recusando} role="group" aria-label="Motivo da recusa">
        {MOTIVOS.map((m, i) => (
          <button key={m.valor} ref={i === 0 ? primeiroMotivo : undefined} className="chip-sug" type="button" onClick={() => disparar(recusar(m.valor))} disabled={ocupado !== null}>
            {m.rotulo}
          </button>
        ))}
      </div>
    </div>
  );
}
