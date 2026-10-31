'use client';

import type { BillingInvoice, BillingPixResponse, BillingResponse } from '@liame/contracts';
import { type RefObject, useCallback, useEffect, useId, useRef, useState } from 'react';
import { copiar } from '@/components/links/copiar';
import { useAvisar } from '@/components/ui/avisos';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { mesEAno, reaisDeCentavos } from './textos';

/** Enquanto o QR Code está aberto, a cobrança é relida neste intervalo: o PIX confirma em segundos (P26). */
export const RELER_PIX_MS = 5_000;
/** Depois disso, a tela para de reler sozinha e oferece conferir de novo. */
export const RELER_PIX_ATE_MS = 10 * 60_000;

type Props = {
  brandId: string;
  marca: string;
  fatura: BillingInvoice;
  /** O pagamento é o da primeira mensalidade, logo depois de assinar. */
  assinando: boolean;
  reserva: RefObject<HTMLElement | null>;
  aoFechar: () => void;
  /** A cobrança lida de novo: a tela inteira se atualiza com ela. */
  aoAtualizar: (r: BillingResponse) => void;
};

type Pix = { tipo: 'carregando' } | { tipo: 'ok'; pix: BillingPixResponse } | { tipo: 'erro'; texto: string };

// Pagar com PIX (P26): o resumo do que se paga (o mesmo que o banco vai mostrar), o QR Code e o código para copiar.
// O QR Code vem do meio de pagamento (`GET /v1/billing/invoices/{id}/pix`); a tela relê a cobrança enquanto espera e
// muda sozinha quando a fatura fica paga.
export function DialogoPix({ brandId, marca, fatura, assinando, reserva, aoFechar, aoAtualizar }: Props) {
  const fecharBt = useRef<HTMLButtonElement>(null);
  const pagoRef = useRef<HTMLParagraphElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: fecharBt, reserva });
  const ids = useId();
  const avisar = useAvisar();
  const [pix, setPix] = useState<Pix>({ tipo: 'carregando' });
  const [pago, setPago] = useState(false);
  const [parou, setParou] = useState(false);
  const [rodada, setRodada] = useState(0);
  const valor = reaisDeCentavos(fatura.amount_cents);
  const oQue =
    fatura.kind === 'diferenca'
      ? `a diferença para o plano ${fatura.plan_name}, da ${marca}`
      : assinando
        ? `a primeira mensalidade do plano ${fatura.plan_name}, da ${marca}`
        : `a mensalidade de ${mesEAno(fatura.period_start ?? fatura.due_date)} da ${marca}, plano ${fatura.plan_name}`;

  const carregar = useCallback(async () => {
    setPix({ tipo: 'carregando' });
    const r = await chamar(() => api.GET('/v1/billing/invoices/{id}/pix', { params: { path: { id: fatura.id } } }));
    setPix(r.ok ? { tipo: 'ok', pix: r.data } : { tipo: 'erro', texto: mensagemDe(r.problema) });
  }, [fatura.id]);

  useEffect(() => {
    disparar(carregar());
  }, [carregar]);

  // Relê a cobrança enquanto o QR Code está na tela, até a fatura ficar paga ou o tempo de espera passar.
  useEffect(() => {
    if (pix.tipo !== 'ok' || pago) return;
    const inicio = Date.now();
    let parado = false;
    const vez = window.setInterval(() => {
      if (Date.now() - inicio > RELER_PIX_ATE_MS) {
        window.clearInterval(vez);
        setParou(true);
        return;
      }
      disparar(
        chamar(() => api.GET('/v1/billing', { params: { query: { brand_id: brandId } } })).then((r) => {
          if (parado || !r.ok) return;
          const agora = r.data.invoices.find((f) => f.id === fatura.id);
          if (agora && agora.status !== 'aberta') {
            window.clearInterval(vez);
            setPago(agora.status === 'paga');
            aoAtualizar(r.data);
          }
        }),
      );
    }, RELER_PIX_MS);
    return () => {
      parado = true;
      window.clearInterval(vez);
    };
  }, [pix.tipo, pago, brandId, fatura.id, aoAtualizar, rodada]);

  useEffect(() => {
    if (pago) pagoRef.current?.focus();
  }, [pago]);

  async function copiarCodigo(codigo: string) {
    const ok = await copiar(codigo);
    avisar(ok ? 'Código do PIX copiado.' : 'Não deu para copiar. Selecione o código e copie.', ok ? {} : { tipo: 'perigo' });
  }

  return (
    <dialog
      ref={ref}
      className="dialogo"
      aria-labelledby={`${ids}-t`}
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
          <h2 id={`${ids}-t`}>Pagar {valor} com PIX</h2>
          <button className="btn btn--ghost btn--icon" type="button" onClick={fechar} aria-label="Fechar">
            <Icone nome="x" />
          </button>
        </div>
        <div className="dialogo-corpo">
          <dl className="resumo-banco">
            <b>O que você está pagando</b>
            <div>
              <dt>Para</dt>
              <dd>Liame</dd>
            </div>
            <div>
              <dt>O que é</dt>
              <dd>{oQue}</dd>
            </div>
            <div>
              <dt>Valor</dt>
              <dd>{valor}</dd>
            </div>
          </dl>
          {pix.tipo === 'carregando' && (
            <p className="pix-espera" role="status">
              <span className="girando" aria-hidden="true" />
              Gerando o QR Code…
            </p>
          )}
          {pix.tipo === 'erro' && (
            <div className="dialogo-erro" role="alert">
              <Icone nome="alert" pequeno />
              <span>{pix.texto}</span>
              <button className="btn btn--sm" type="button" onClick={() => disparar(carregar())}>
                Tentar de novo
              </button>
            </div>
          )}
          {pix.tipo === 'ok' && (
            <>
              <div className="pix-qr-caixa">
                <div className="pix-qr">
                  <img src={`data:image/png;base64,${pix.pix.qr_code_png_base64}`} alt="QR Code do PIX" width={164} height={164} />
                </div>
                <div className="pix-codigo">
                  <code>{pix.pix.copy_paste}</code>
                  <button className="btn btn--sm" type="button" onClick={() => disparar(copiarCodigo(pix.pix.copy_paste))}>
                    <Icone nome="copy" pequeno />
                    Copiar o código
                  </button>
                </div>
              </div>
              <p className="sit-nota">No app do seu banco, leia o QR Code ou cole o código. O PIX confirma em segundos, e esta tela muda sozinha.</p>
              {pago ? (
                <p className="pix-pago" ref={pagoRef} tabIndex={-1} role="status">
                  <Icone nome="check-circle" />
                  <span>Pagamento recebido. {assinando ? 'A assinatura começou.' : 'Tudo voltou a funcionar.'}</span>
                </p>
              ) : parou ? (
                <p className="pix-espera">
                  Ainda não chegou o pagamento.
                  <button
                    className="link-bt"
                    type="button"
                    onClick={() => {
                      setParou(false);
                      setRodada((n) => n + 1);
                    }}
                  >
                    Conferir de novo
                  </button>
                </p>
              ) : (
                <p className="pix-espera" role="status">
                  <span className="girando" aria-hidden="true" />
                  Esperando o pagamento…
                </p>
              )}
            </>
          )}
        </div>
        <div className="dialogo-acoes">
          <button ref={fecharBt} className={pago ? 'btn btn--primary' : 'btn'} type="button" onClick={fechar}>
            {pago ? 'Concluir' : 'Fechar'}
          </button>
        </div>
      </div>
    </dialog>
  );
}
