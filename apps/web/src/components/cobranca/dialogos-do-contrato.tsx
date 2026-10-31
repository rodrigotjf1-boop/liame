'use client';

import type { BillingPlan, BillingResponse, BrandSubscription } from '@liame/contracts';
import { type RefObject, useState } from 'react';
import { api, chamar, type Resultado as RespostaDaApi } from '@/lib/api';
import { Funcionarios, Preco } from './cartoes';
import { DialogoComCodigo, type Resultado } from './dialogo-com-codigo';
import { contaDaTroca, diaMesDe, reaisDeCentavos } from './textos';

// As mudanças do contrato, só do Dono e com o código do app (D-A7-13, D-A7-14; P26): trocar de plano (D-A7-16),
// cancelar no fim do período pago (Termos 11.1) e desistir em 7 dias na primeira contratação (D-A7-19). Cada diálogo diz
// só o que o servidor faz; o que acontece com os dados depois do fim é a W3, parte 4, e fica fora (V39).

type Base = { brandId: string; s: BrandSubscription; reserva: RefObject<HTMLElement | null>; aoFechar: () => void; aoMudar: (r: BillingResponse) => void };

/** O pedido com o código: atualiza a tela com a resposta e devolve se deu certo. */
async function pedir(fazer: () => Promise<RespostaDaApi<BillingResponse>>, aoMudar: (r: BillingResponse) => void): Promise<Resultado> {
  const r = await fazer();
  if (!r.ok) return r;
  aoMudar(r.data);
  return { ok: true };
}

export function DialogoTrocarPlano({ brandId, s, hoje, planos, reserva, aoFechar, aoMudar }: Base & { hoje: string; planos: BillingPlan[] }) {
  const [escolhido, setEscolhido] = useState(s.plan.key);
  const novo = planos.find((p) => p.key === escolhido) ?? s.plan;
  const conta = contaDaTroca(s, novo, hoje);
  const rotulo = conta.tipo === 'sobe' ? `Subir para o ${novo.name}` : conta.tipo === 'desce' ? `Descer para o ${novo.name}` : 'Trocar de plano';
  return (
    <DialogoComCodigo
      titulo="Trocar de plano"
      dica="Trocar de plano muda o contrato: confirme com os 6 números do app."
      rotulo={rotulo}
      rotuloEnviando="Trocando…"
      semConfirmar={conta.tipo === 'igual'}
      reserva={reserva}
      aoFechar={aoFechar}
      enviar={(code) => pedir(() => chamar(() => api.POST('/v1/billing/subscription/plan', { body: { brand_id: brandId, plan: escolhido, code } })), aoMudar)}
    >
      <fieldset className="campo">
        <legend>Escolha o plano</legend>
        <div className="planos">
          {planos.map((p) => (
            <label key={p.key} className="plano-op">
              <span className="plano-op-cab">
                <input type="radio" name={`plano-${brandId}`} value={p.key} checked={escolhido === p.key} onChange={() => setEscolhido(p.key)} />
                <b>
                  {p.name}
                  {p.key === s.plan.key ? ' · o seu plano' : ''}
                </b>
                <Preco centavos={p.price_cents} />
              </span>
              <Funcionarios plano={p} />
            </label>
          ))}
        </div>
      </fieldset>
      <p className="conta-hoje" aria-live="polite">
        {conta.tipo === 'igual' && 'Este é o seu plano.'}
        {conta.tipo === 'sobe' && (
          <>
            <b>Hoje: {reaisDeCentavos(String(conta.hojeCentavos))}</b>, a diferença pelos {conta.faltam} dias que faltam até {diaMesDe(conta.fim)}, paga com PIX. O {novo.name} vale quando
            ela for paga.
            <br />A partir de {diaMesDe(conta.fim)}: {reaisDeCentavos(novo.price_cents)} por mês.
          </>
        )}
        {conta.tipo === 'desce' && (
          <>
            <b>Hoje: nada.</b> O {conta.atual.name} continua até {diaMesDe(conta.fim)}.
            <br />A partir de {diaMesDe(conta.fim)}: o {novo.name}, por {reaisDeCentavos(novo.price_cents)} por mês.
          </>
        )}
      </p>
    </DialogoComCodigo>
  );
}

export function DialogoCancelar({ brandId, s, reserva, aoFechar, aoMudar }: Base) {
  const fim = s.period_end ? diaMesDe(s.period_end) : null;
  return (
    <DialogoComCodigo
      titulo="Cancelar a assinatura"
      dica="Cancelar muda o contrato: confirme com os 6 números do app."
      rotulo={fim ? `Cancelar em ${fim}` : 'Cancelar a assinatura'}
      rotuloEnviando="Cancelando…"
      perigo
      reserva={reserva}
      aoFechar={aoFechar}
      enviar={(code) => pedir(() => chamar(() => api.POST('/v1/billing/subscription/cancel', { body: { brand_id: brandId, code } })), aoMudar)}
    >
      <p className="dlg-lead">{fim ? `A assinatura termina em ${fim}, no fim do período que você já pagou.` : 'A assinatura termina no fim do período que você já pagou.'}</p>
      <ul className="lista-dlg">
        <li>Até lá, tudo funciona como hoje, e a mensalidade seguinte não é cobrada.</li>
        <li>Não há multa. Você pode manter a assinatura até lá, e voltar a assinar quando quiser.</li>
      </ul>
    </DialogoComCodigo>
  );
}

export function DialogoDesistir({ brandId, s, valorCentavos, reserva, aoFechar, aoMudar }: Base & { valorCentavos: string }) {
  const valor = reaisDeCentavos(valorCentavos);
  const [quando, setQuando] = useState<Date | null>(null);
  const [protocolo, setProtocolo] = useState<string | null>(null);
  return (
    <DialogoComCodigo
      titulo="Desistir da assinatura"
      dica="Desistir muda o contrato: confirme com os 6 números do app."
      rotulo={`Desistir e receber ${valor}`}
      rotuloEnviando="Pedindo a devolução…"
      perigo
      reserva={reserva}
      aoFechar={aoFechar}
      enviar={async (code) => {
        const r = await chamar(() => api.POST('/v1/billing/subscription/withdraw', { body: { brand_id: brandId, code } }));
        if (!r.ok) return r;
        // A confirmação imediata (D-A7-19, D-A7-43): o protocolo da resposta, o mesmo do e-mail que acabou de sair.
        setProtocolo(r.data.subscription?.withdraw_protocol ?? null);
        setQuando(new Date());
        aoMudar(r.data);
        return { ok: true };
      }}
      concluido={
        quando && (
          <>
            <b>
              Pedido recebido em {String(quando.getDate()).padStart(2, '0')}/{String(quando.getMonth() + 1).padStart(2, '0')} às {String(quando.getHours()).padStart(2, '0')}:
              {String(quando.getMinutes()).padStart(2, '0')}
              {protocolo ? ` · protocolo ${protocolo}` : ''}
            </b>
            <span>A assinatura terminou, e a devolução de {valor} foi pedida ao meio de pagamento. A confirmação, com o protocolo, foi para o seu e-mail.</span>
          </>
        )
      }
    >
      <p className="dlg-lead">Na primeira contratação, você pode desistir em até 7 dias do primeiro pagamento, com a devolução de 100%.</p>
      <dl className="resumo-banco">
        <div>
          <dt>Devolução</dt>
          <dd>{valor}</dd>
        </div>
        <div>
          <dt>Volta para</dt>
          <dd>a conta que pagou o PIX</dd>
        </div>
        {s.withdraw_until && (
          <div>
            <dt>Prazo</dt>
            <dd>até {diaMesDe(s.withdraw_until)}</dd>
          </div>
        )}
      </dl>
      <ul className="lista-dlg">
        <li>A assinatura termina agora, sem multa.</li>
      </ul>
    </DialogoComCodigo>
  );
}
