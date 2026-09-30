'use client';

import type { ClosedLoopResponse, OrderOrigin } from '@liame/contracts';
import { type RefObject, useMemo } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { detalheDoPedido } from './pedidos';

// Gaveta "Origem do pedido" (protótipo P1): o resultado, a evidência usada, como o Liame sabe, a linha do
// tempo, a margem e o modelo. Sem dado pessoal. `<dialog>` nativo: foco preso, Esc fecha, foco volta a
// quem abriu (ou ao título da tela, se a linha sumiu).

type Props = {
  pedido: OrderOrigin;
  fuso: string;
  loja: string | null;
  modelo: ClosedLoopResponse['model'];
  reserva: RefObject<HTMLElement | null>;
  aoFechar: () => void;
};

export function GavetaOrigem({ pedido, fuso, loja, modelo, reserva, aoFechar }: Props) {
  const { ref, fechar, devolverFoco } = useDialogo({ reserva });
  const d = useMemo(() => detalheDoPedido(pedido, { fuso, loja, modelo }), [pedido, fuso, loja, modelo]);
  const r = d.resultado;

  return (
    <dialog
      ref={ref}
      id="dlg-origem"
      className="dialogo dialogo--lado"
      aria-labelledby="dlg-origem-t"
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
            <p className="rotulo-marca">Origem do pedido</p>
            <h2 id="dlg-origem-t">{d.titulo}</h2>
          </div>
          <button className="btn btn--ghost btn--icon" type="button" onClick={fechar} aria-label="Fechar">
            <Icone nome="x" />
          </button>
        </div>
        <div className="dialogo-corpo">
          <dl className="det-dados">
            {d.dados.map((x) => (
              <div key={x.rotulo}>
                <dt>{x.rotulo}</dt>
                <dd className={x.mono ? 'num' : undefined}>{x.riscado ? <s>{x.valor}</s> : x.valor}</dd>
              </div>
            ))}
          </dl>

          <section className="det-bloco" aria-labelledby="det-resultado">
            <h3 id="det-resultado" className="rotulo-marca">
              Resultado
            </h3>
            <p className="det-resultado">
              {r.tipo === 'campanha' && (
                <>
                  <span>
                    <b>{r.campanha}</b>
                  </span>
                  {r.plataforma && <span className={`plat plat--${r.plataforma.classe}`}>{r.plataforma.nome}</span>}
                  <span className={`st st--${d.confianca.classe}`}>
                    {d.confianca.ponto && <span className="dot" aria-hidden="true" />}
                    {d.confianca.rotulo}
                  </span>
                  <span className="eixo-nota">{r.nota}</span>
                </>
              )}
              {r.tipo === 'plataforma' && (
                <>
                  <span>
                    <b>{r.plataforma.nome}</b>, sem campanha identificada
                  </span>
                  <span className={`st st--${d.confianca.classe}`}>
                    <span className="dot" aria-hidden="true" />
                    {d.confianca.rotulo}
                  </span>
                  <span className="eixo-nota">{r.nota}</span>
                </>
              )}
              {r.tipo === 'sem' && (
                <>
                  <span className="st st--espera">Sem origem</span>
                  <span>{r.motivo}</span>
                </>
              )}
              {r.tipo === 'cancelado' && (
                <>
                  <span className="st st--perigo">
                    <span className="dot" aria-hidden="true" />
                    {d.confianca.rotulo}
                  </span>
                  {r.campanha && (
                    <span>
                      Era da campanha <b>{r.campanha}</b>
                      {r.plataforma ? ` (${r.plataforma})` : ''}
                    </span>
                  )}
                </>
              )}
            </p>
          </section>

          <section className="det-bloco" aria-labelledby="det-evidencia">
            <h3 id="det-evidencia" className="rotulo-marca">
              Evidência usada
            </h3>
            <p className={d.evidencia.tom === 'normal' ? 'evid' : `evid evid--${d.evidencia.tom}`}>{d.evidencia.texto}</p>
          </section>

          <section className="det-bloco" aria-labelledby="det-como">
            <h3 id="det-como" className="rotulo-marca">
              Como o Liame sabe
            </h3>
            <ul className="det-lista">
              {d.comoSabe.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </section>

          <section className="det-bloco" aria-labelledby="det-tempo">
            <h3 id="det-tempo" className="rotulo-marca">
              Linha do tempo
            </h3>
            <ol className="linha-tempo">
              {d.linhaDoTempo.map((t) => (
                <li key={`${t.iso}-${t.oque}`} className={t.usado ? 'vence' : undefined}>
                  <time dateTime={t.iso}>{t.quando}</time>
                  <span>
                    {t.oque}
                    {t.usado && <span className="eixo-nota"> · toque usado</span>}
                  </span>
                </li>
              ))}
            </ol>
          </section>

          <section className="det-bloco" aria-labelledby="det-margem">
            <h3 id="det-margem" className="rotulo-marca">
              Margem do pedido
            </h3>
            <p>{d.margem}</p>
          </section>

          <p className="det-modelo">{d.modelo}</p>
          <p className="dialogo-nota">
            <Icone nome="shield" pequeno />
            <span>Sem dado pessoal: o Liame não guarda nome nem telefone do cliente. A conversa e o pedido se ligam por um identificador pseudonimizado.</span>
          </p>
        </div>
      </div>
    </dialog>
  );
}
