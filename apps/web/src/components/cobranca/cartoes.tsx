import type { BillingInvoice, BillingPlan, BrandSubscription } from '@liame/contracts';
import { Estado } from '@/components/ui/estado';
import { Icone } from '@/components/ui/icone';
import { diaMesDe, emAtraso, type Fase, funcionariosDo, linhaDaFatura, type Momento, nomeDaFatura, reaisDeCentavos, type TextoDaSituacao, type Tom } from './textos';

// Os cartões de Plano e cobrança (P26): a situação no alto, com a ação do momento; o plano e a forma de pagamento; as
// faturas e o que acontece em cada fase do atraso.

const Selo = ({ texto, tom }: { texto: string; tom: Tom }) => (
  <span className={`st st--${tom}`}>
    <span className="dot" aria-hidden="true" />
    {texto}
  </span>
);

type AcoesDaSituacao = {
  pagarRotulo: string | null;
  aoPagar: () => void;
  aoExportar: () => void;
  exportando: boolean;
  desistirRotulo?: string;
  aoDesistir?: () => void;
  aoManter?: () => void;
  mantendo?: boolean;
};

export function CartaoSituacao({ s, acoes, idTitulo }: { s: TextoDaSituacao; acoes: AcoesDaSituacao; idTitulo: string }) {
  const temAcoes = (s.pagar && acoes.pagarRotulo) || s.exportar || (s.desistir && acoes.aoDesistir) || (s.manter && acoes.aoManter);
  return (
    <article className={`card sit${s.tom ? ` sit--${s.tom}` : ''}`} aria-labelledby={idTitulo}>
      <div className="sit-cab">
        {s.selos.map((x) => (
          <Selo key={x.texto} texto={x.texto} tom={x.tom} />
        ))}
      </div>
      <h2 className="sit-titulo" id={idTitulo} tabIndex={-1}>
        {s.titulo}
      </h2>
      <p className="sit-frase">{s.frase}</p>
      {s.continua.length > 0 && (
        <ul className="sit-continua">
          {s.continua.map((c) => (
            <li key={c.texto}>
              <span className={c.sim ? 'sim' : 'nao'} aria-hidden="true">
                <Icone nome={c.sim ? 'check' : 'x'} pequeno />
              </span>
              <span>
                <span className="sr-only">{c.sim ? 'Continua: ' : 'Para: '}</span>
                {c.texto}
              </span>
            </li>
          ))}
        </ul>
      )}
      {s.degraus.length > 0 && (
        <dl className="degraus">
          {s.degraus.map((d) => (
            <div key={d.dia + d.oQue} className={`degrau${d.tom ? ` degrau--${d.tom}` : ''}`}>
              <dt>{diaMesDe(d.dia)}</dt>
              <dd>{d.oQue}</dd>
            </div>
          ))}
        </dl>
      )}
      {s.nota && <p className="sit-nota">{s.nota}</p>}
      {temAcoes && (
        <div className="sit-acoes">
          {s.pagar && acoes.pagarRotulo && (
            <button className="btn btn--primary" type="button" aria-haspopup="dialog" onClick={acoes.aoPagar}>
              <Icone nome="qr" />
              {acoes.pagarRotulo}
            </button>
          )}
          {s.exportar && (
            <button className="btn btn--ghost" type="button" onClick={acoes.aoExportar} disabled={acoes.exportando} aria-busy={acoes.exportando}>
              <Icone nome="download" />
              {acoes.exportando ? 'Exportando…' : 'Exportar os dados'}
            </button>
          )}
          {s.manter && acoes.aoManter && (
            <button className="btn btn--primary" type="button" onClick={acoes.aoManter} disabled={acoes.mantendo} aria-busy={acoes.mantendo}>
              {acoes.mantendo ? 'Mantendo…' : 'Manter a assinatura'}
            </button>
          )}
          {s.desistir && acoes.aoDesistir && (
            <button className="btn btn--perigo" type="button" aria-haspopup="dialog" onClick={acoes.aoDesistir}>
              {acoes.desistirRotulo ?? 'Desistir'}
            </button>
          )}
        </div>
      )}
    </article>
  );
}

export function Funcionarios({ plano }: { plano: BillingPlan }) {
  return (
    <ul className="funcs" aria-label={`Funcionários do plano ${plano.name}`}>
      {funcionariosDo(plano).map((f) => (
        <li key={f} className="func">
          {f}
        </li>
      ))}
    </ul>
  );
}

export function Preco({ centavos }: { centavos: string }) {
  return (
    <span className="plano-preco">
      {reaisDeCentavos(centavos)}
      <small> por mês</small>
    </span>
  );
}

/** O plano em vigor, com o que muda no período seguinte e quem pode trocar. */
export function CartaoPlano({
  s,
  momento,
  souDono,
  nomeDoDono,
  aoTrocar,
}: {
  s: BrandSubscription;
  momento: Momento;
  souDono: boolean;
  nomeDoDono: string | null;
  /** "Trocar de plano": o Dono, com a assinatura em dia (o servidor recusa o resto: D-A7-16). */
  aoTrocar?: () => void;
}) {
  let nota: string | null = null;
  if (momento === 'cancelada' || momento === 'aguardando') nota = null;
  else if (emAtraso(momento)) nota = 'Para trocar de plano, pague antes a mensalidade em aberto.';
  else if (!souDono) nota = `Trocar de plano, cancelar e desistir ficam com o Dono${nomeDoDono ? `, ${nomeDoDono}` : ''}.`;
  const podeTrocar = souDono && aoTrocar && (momento === 'em-dia' || momento === 'primeira');
  return (
    <article className="card" aria-labelledby="cob-plano-t">
      <div className="plano-cab">
        <div>
          <p className="rotulo-marca">Plano</p>
          <h2 className="plano-nome" id="cob-plano-t">
            {s.plan.name}
          </h2>
        </div>
        <Preco centavos={s.plan.price_cents} />
      </div>
      <Funcionarios plano={s.plan} />
      {s.next_plan && s.period_end && (
        <p className="sit-nota">
          A partir de <b>{diaMesDe(s.period_end)}</b>, o plano passa a ser o {s.next_plan.name}, por {reaisDeCentavos(s.next_plan.price_cents)} por mês.
        </p>
      )}
      {nota && <p className="sit-nota">{nota}</p>}
      {podeTrocar && (
        <button className="btn" type="button" aria-haspopup="dialog" onClick={aoTrocar}>
          Trocar de plano
        </button>
      )}
    </article>
  );
}

/** Cancelar, no fim da tela, só para o Dono e com a assinatura em dia (P26): vale no fim do período pago. */
export function RodapeCancelar({ fim, aoCancelar }: { fim: string | null; aoCancelar: () => void }) {
  return (
    <div className="cob-rodape">
      <p>{fim ? `Sem multa. A assinatura termina no fim do período pago, em ${diaMesDe(fim)}.` : 'Sem multa. A assinatura termina no fim do período pago.'}</p>
      <button className="btn btn--sm btn--perigo" type="button" aria-haspopup="dialog" onClick={aoCancelar}>
        Cancelar a assinatura
      </button>
    </div>
  );
}

/** A forma de pagamento das próximas cobranças. Por enquanto, o PIX (o cartão chega com a W2b). */
export function CartaoForma({ s }: { s: BrandSubscription }) {
  const cartao = s.method === 'cartao';
  return (
    <article className="card" aria-labelledby="cob-forma-t">
      <p className="rotulo-marca">Forma de pagamento</p>
      <div className="forma">
        <span className="forma-ic" aria-hidden="true">
          <Icone nome={cartao ? 'wallet' : 'qr'} />
        </span>
        <div className="forma-txt">
          <b id="cob-forma-t">{cartao ? 'Cartão' : 'PIX a cada mês'}</b>
          <span>
            {cartao
              ? 'A cobrança sai no cartão. O número do cartão fica só no meio de pagamento.'
              : 'A fatura de cada mês aparece aqui cinco dias antes do vencimento, com o QR Code para pagar.'}
          </span>
        </div>
      </div>
    </article>
  );
}

export function CartaoFaturas({ invoices, hoje }: { invoices: BillingInvoice[]; hoje: string }) {
  return (
    <article className="card" aria-labelledby="cob-fat-t">
      <h2 className="card-titulo" id="cob-fat-t">
        Faturas
      </h2>
      {invoices.length === 0 ? (
        <Estado icone="file" titulo="Nenhuma fatura ainda" compacto>
          As faturas aparecem aqui depois da primeira mensalidade.
        </Estado>
      ) : (
        <ul className="faturas">
          {invoices.map((f) => {
            const l = linhaDaFatura(f, hoje);
            return (
              <li key={f.id} className="fatura">
                <div>
                  <span className="fat-mes">{nomeDaFatura(f)}</span>
                  <br />
                  <span className="fat-det">{l.detalhe}</span>
                </div>
                <div className="fat-lado">
                  <span className="fat-valor">{reaisDeCentavos(f.amount_cents)}</span>
                  <Selo texto={l.selo} tom={l.tom} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </article>
  );
}

export function CartaoFases({ linhas }: { linhas: Fase[] }) {
  return (
    <article className="card" aria-labelledby="cob-fases-t">
      <h2 className="card-titulo" id="cob-fases-t">
        Se a mensalidade atrasar
      </h2>
      <ol className="fases">
        {linhas.map((l) => (
          <li key={l.quando} className={`fase${l.agora ? ' fase--agora' : ''}`}>
            <span className="fase-quando">
              {l.quando}
              {l.dia && <span className="num">{diaMesDe(l.dia)}</span>}
            </span>
            <span className="fase-oque">
              {l.oQue}
              {l.agora && <b> (agora)</b>}
            </span>
          </li>
        ))}
      </ol>
      <p className="fase-volta">Pagou, tudo volta na hora.</p>
    </article>
  );
}

/** Os planos para escolher (a marca sem assinatura, ou depois que ela terminou). Assinar é com o Dono (D-A7-13). */
export function PlanosParaAssinar({ planos, podeAssinar, aoAssinar }: { planos: BillingPlan[]; podeAssinar: boolean; aoAssinar: (p: BillingPlan) => void }) {
  return (
    <>
      <div className="planos planos--tela">
        {planos.map((p, i) => (
          <div key={p.key} className="plano-op">
            <div className="plano-op-cab">
              <b>{p.name}</b>
              <Preco centavos={p.price_cents} />
            </div>
            <Funcionarios plano={p} />
            {podeAssinar && (
              <button className={i === 0 ? 'btn btn--primary' : 'btn'} type="button" aria-haspopup="dialog" onClick={() => aoAssinar(p)}>
                Assinar o {p.name}
              </button>
            )}
          </div>
        ))}
      </div>
      {!podeAssinar && <p className="sit-nota">Assinar é com o Dono.</p>}
    </>
  );
}
