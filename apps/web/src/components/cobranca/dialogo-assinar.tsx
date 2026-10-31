'use client';

import type { BillingPlan, BillingResponse } from '@liame/contracts';
import { type FormEvent, type RefObject, useId, useRef, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { useDialogo } from '@/components/ui/use-dialogo';
import { api, chamar, mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { reaisDeCentavos } from './textos';

type Props = {
  brandId: string;
  plano: BillingPlan;
  reserva: RefObject<HTMLElement | null>;
  aoFechar: () => void;
  /** A assinatura nasceu esperando o primeiro pagamento: a tela abre o PIX dela. */
  aoAssinar: (r: BillingResponse) => void;
};

// Assinar um plano (P26): o valor, sem fidelidade, e a forma de pagar. Por enquanto, só o PIX: o cartão chega com a W2b
// e o Pix Automático fica desligado até 30/12/2026 (D-A7-17). A assinatura nasce esperando o primeiro pagamento, e a
// tela abre o QR Code dela (`POST /v1/billing/subscription`; o mesmo pedido de novo não contrata duas vezes).
export function DialogoAssinar({ brandId, plano, reserva, aoFechar, aoAssinar }: Props) {
  const confirmar = useRef<HTMLButtonElement>(null);
  const { ref, fechar, devolverFoco } = useDialogo({ focoInicial: confirmar, reserva });
  const ids = useId();
  const [indo, setIndo] = useState(false);
  const [erro, setErro] = useState('');
  const preco = reaisDeCentavos(plano.price_cents);

  async function assinar(e: FormEvent) {
    e.preventDefault();
    setErro('');
    setIndo(true);
    const r = await chamar(() => api.POST('/v1/billing/subscription', { body: { brand_id: brandId, plan: plano.key, method: 'pix' } }));
    setIndo(false);
    if (!r.ok) return setErro(mensagemDe(r.problema));
    aoAssinar(r.data);
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
        if (e.target === ref.current && !indo) fechar();
      }}
    >
      <form className="dialogo-form" onSubmit={(e) => disparar(assinar(e))} noValidate>
        <div className="dialogo-cab">
          <h2 id={`${ids}-t`}>Assinar o {plano.name}</h2>
          <button className="btn btn--ghost btn--icon" type="button" onClick={fechar} aria-label="Fechar" disabled={indo}>
            <Icone nome="x" />
          </button>
        </div>
        <div className="dialogo-corpo">
          {erro && (
            <p className="dialogo-erro" role="alert">
              <Icone nome="alert" pequeno />
              <span>{erro}</span>
            </p>
          )}
          <p className="dlg-lead">{preco} por mês, sem fidelidade.</p>
          <fieldset className="campo">
            <legend>Como você quer pagar?</legend>
            <div className="opcoes">
              <label className="opcao">
                <input type="radio" name={`${ids}-forma`} value="pix" defaultChecked disabled={indo} />
                <span className="opcao-txt">
                  <b>PIX</b>
                  <span>Pague a primeira mensalidade agora pelo QR Code. A fatura de cada mês aparece aqui cinco dias antes do vencimento, e o código do PIX vai por e-mail a quem paga.</span>
                </span>
              </label>
            </div>
          </fieldset>
          <p className="dialogo-nota">
            <Icone nome="info" pequeno />
            <span>Na primeira contratação, você pode desistir em até 7 dias do pagamento e receber tudo de volta. Para cancelar depois, não há multa.</span>
          </p>
        </div>
        <div className="dialogo-acoes">
          <button className="btn" type="button" onClick={fechar} disabled={indo}>
            Cancelar
          </button>
          <button ref={confirmar} className="btn btn--primary" type="submit" disabled={indo} aria-busy={indo}>
            {indo ? 'Assinando…' : `Assinar e pagar ${preco}`}
          </button>
        </div>
      </form>
    </dialog>
  );
}
