'use client';

import type { MessagingCampaign, MessagingCampaignDetailResponse } from '@liame/contracts';
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { SeloDaMensagem } from './mensagens-conteudo';
import { dadosDa, detalheDaMensagem, numerosDa, seloDaCampanha } from './textos';

// Gaveta "Mensagem" (protótipo P15: o botão "Ver" de "O que foi enviado" abre o resultado da mensagem, com as peças do
// estado "Enviada" do pedido). Abre com o que a lista já sabe (a situação e os números) e pede ao RegemCast, pelo
// servidor, o que só o detalhe tem: por que está pausada ou esperando, as falhas por motivo e o custo. Só números:
// não diz quem recebeu. `<dialog>` nativo: foco preso, Esc fecha, foco volta a quem abriu.

type Props = {
  contaId: string;
  campanha: MessagingCampaign;
  agora: Date;
  reserva: RefObject<HTMLElement | null>;
  aoFechar: () => void;
};

type Carga = { tipo: 'carregando' } | { tipo: 'ok'; dados: MessagingCampaignDetailResponse } | { tipo: 'erro'; problema: Problema };

export function GavetaMensagem({ contaId, campanha, agora, reserva, aoFechar }: Props) {
  const { ref, fechar, devolverFoco } = useDialogo({ reserva });
  const [carga, setCarga] = useState<Carga>({ tipo: 'carregando' });
  const [tentativa, setTentativa] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    const id = ++seq.current;
    setCarga({ tipo: 'carregando' });
    disparar(
      chamar(() => api.GET('/v1/messaging/campaigns/{id}', { params: { path: { id: campanha.id }, query: { connected_account_id: contaId } } })).then((r) => {
        if (id !== seq.current) return;
        setCarga(r.ok ? { tipo: 'ok', dados: r.data } : { tipo: 'erro', problema: r.problema });
      }),
    );
  }, [contaId, campanha.id, tentativa]);

  // Com o detalhe lido, os números e a situação são os dele (mais novos que os da lista).
  const atual = carga.tipo === 'ok' ? carga.dados.campaign : campanha;
  const detalhe = useMemo(() => (carga.tipo === 'ok' ? detalheDaMensagem(carga.dados, agora) : null), [carga, agora]);
  const dados = detalhe?.dados ?? dadosDa(atual, agora);

  return (
    <dialog
      ref={ref}
      id="dlg-mensagem"
      className="dialogo dialogo--lado"
      aria-labelledby="dlg-mensagem-t"
      onClose={() => {
        aoFechar();
        devolverFoco();
      }}
      onClick={(e) => {
        if (e.target === ref.current) fechar();
      }}
    >
      <div className="dialogo-form">
        <div className="dialogo-cab">
          <div className="dlg-titulo">
            <p className="rotulo-marca">Mensagem</p>
            <h2 id="dlg-mensagem-t">{atual.name}</h2>
          </div>
          <button className="btn btn--ghost btn--icon" type="button" onClick={fechar} aria-label="Fechar">
            <Icone nome="x" />
          </button>
        </div>
        <div className="dialogo-corpo">
          <p>
            <SeloDaMensagem selo={seloDaCampanha(atual.status)} />
          </p>
          <dl className="det-dados">
            {dados.slice(1).map((x) => (
              <div key={x.rotulo}>
                <dt>{x.rotulo}</dt>
                <dd>{x.valor}</dd>
              </div>
            ))}
          </dl>

          <section className="det-bloco" aria-labelledby="mens-como">
            <h3 id="mens-como" className="rotulo-marca">
              Como foi
            </h3>
            <div className="mens-nums" role="group" aria-label="Como a mensagem foi">
              {numerosDa(atual).map((n) => (
                <p className="mens-num" key={n.chave}>
                  <b className="num">{n.valor}</b>
                  <span>{n.rotulo}</span>
                </p>
              ))}
            </div>
          </section>

          {carga.tipo === 'carregando' && (
            <div className="res-esqueleto" aria-busy="true" id="mens-det-carregando">
              <p className="sr-only">Lendo o detalhe no RegemCast…</p>
              <span className="esqueleto esqueleto--medio" aria-hidden="true" />
              <span className="esqueleto esqueleto--curto" aria-hidden="true" />
            </div>
          )}

          {carga.tipo === 'erro' && (
            <div className="mens-porque mens-porque--falha" role="alert" id="mens-det-erro">
              <Icone nome="alert-circle" />
              <div>
                <b>Não foi possível ler o detalhe desta mensagem</b>
                <span>{mensagemDe(carga.problema)}</span>
                <button className="btn btn--sm" type="button" onClick={() => setTentativa((t) => t + 1)}>
                  <Icone nome="refresh" pequeno />
                  Tentar de novo
                </button>
              </div>
            </div>
          )}

          {detalhe?.pausa && (
            <div className="mens-porque" id="mens-pausa">
              <Icone nome="pause" />
              <div>
                <b>{detalhe.pausa.titulo}</b>
                {detalhe.pausa.texto && <span>{detalhe.pausa.texto}</span>}
                {detalhe.pausa.volta && <span>{detalhe.pausa.volta}</span>}
                <span>O que já foi enviado não volta. Para retomar o envio, abra a campanha no RegemCast.</span>
              </div>
            </div>
          )}

          {detalhe?.espera && (
            <div className="mens-porque" id="mens-espera">
              <Icone nome="clock" />
              <div>
                <b>{detalhe.espera.titulo}</b>
                {detalhe.espera.volta && <span>{detalhe.espera.volta}</span>}
              </div>
            </div>
          )}

          {detalhe?.falhas && (
            <section className="det-bloco" aria-labelledby="mens-falhas-t">
              <h3 id="mens-falhas-t" className="rotulo-marca">
                {detalhe.falhas.titulo}
              </h3>
              {detalhe.falhas.semMotivo ? (
                <p className="eixo-nota">O RegemCast não informou o motivo destas falhas.</p>
              ) : (
                <ul className="mens-falhas">
                  {detalhe.falhas.itens.map((f) => (
                    <li key={f.chave}>
                      <div>
                        <b>{f.titulo}</b>
                        <span>{f.explicacao}</span>
                        {f.acao && <span>O que fazer: {f.acao}</span>}
                      </div>
                      <b className="num">{f.quantas}</b>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {detalhe?.trouxe && (
            <section className="det-bloco" aria-labelledby="mens-trouxe-t">
              <h3 id="mens-trouxe-t" className="rotulo-marca">
                O que trouxe
              </h3>
              <p id="mens-trouxe">{detalhe.trouxe.texto}</p>
              {detalhe.trouxe.voltou && <p className="mens-voltou">{detalhe.trouxe.voltou}</p>}
              <p className="eixo-nota">A conta é pelo cupom da mensagem: entram os pedidos confirmados no caixa, pelo Regem, que usaram o cupom.</p>
            </section>
          )}

          {carga.tipo === 'ok' && (
            <section className="det-bloco" aria-labelledby="mens-custo-t">
              <h3 id="mens-custo-t" className="rotulo-marca">
                Quanto custou
              </h3>
              {detalhe?.custo ? (
                <>
                  <ul className="mens-custo">
                    {detalhe.custo.linhas.map((l) => (
                      <li key={l.rotulo}>
                        <span>
                          {l.rotulo}
                          {l.detalhe && <small>{l.detalhe}</small>}
                        </span>
                        <b className="num">{l.valor}</b>
                      </li>
                    ))}
                  </ul>
                  {detalhe.custo.avisos.map((a) => (
                    <p className="eixo-nota" key={a}>
                      {a}
                    </p>
                  ))}
                  <p className="eixo-nota">O custo é o que o RegemCast informa: estimativa e teto. A Meta só cobra a mensagem entregue.</p>
                </>
              ) : (
                <p className="eixo-nota">O RegemCast não tem preço cadastrado para estimar o custo desta mensagem.</p>
              )}
            </section>
          )}

          {detalhe?.descanso && <p className="det-modelo">{detalhe.descanso}</p>}
          <p className="dialogo-nota">
            <Icone nome="shield" pequeno />
            <span>Só números: o Liame não vê o nome nem o telefone de quem recebeu.</span>
          </p>
        </div>
      </div>
    </dialog>
  );
}
