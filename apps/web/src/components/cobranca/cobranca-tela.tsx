'use client';

import type { BillingContactsResponse, BillingInvoice, BillingPlan, BillingResponse, BrandResponse } from '@liame/contracts';
import { useSearchParams } from 'next/navigation';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useAvisar } from '@/components/ui/avisos';
import { Estado } from '@/components/ui/estado';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { useSessao } from '@/lib/sessao';
import { CartaoFases, CartaoFaturas, CartaoForma, CartaoPlano, CartaoSituacao, PlanosParaAssinar, RodapeCancelar } from './cartoes';
import { DialogoAssinar } from './dialogo-assinar';
import { DialogoPix } from './dialogo-pix';
import { DialogoCancelar, DialogoDesistir, DialogoTrocarPlano } from './dialogos-do-contrato';
import { diaMesDe, emAberto, fases, momentoDa, reaisDeCentavos, situacao, textoDoFim, ultimaPaga, valorDaDesistencia } from './textos';

// Plano e cobrança (A7 · W5, parte 2; protótipo P26, aprovado em 22/10/2026; `plano-a7.md` D-A7-13 a D-A7-19, D-A7-41).
// Para o Dono e o Administrador com a cobrança liberada (`cobranca.ver`): a situação da assinatura da marca, com a ação
// do momento (pagar com PIX, exportar os dados na conta suspensa), o plano, a forma de pagamento, as faturas e o que
// acontece em cada fase do atraso; e, sem assinatura, os planos para assinar. O link do e-mail do atraso abre a marca
// pelo endereço (`/cobranca?marca=…`, a cada chegada: V148). Trocar de plano, cancelar e desistir chegam na parte 3; a
// faixa do atraso nas outras telas e a conta suspensa para a equipe, na parte 4.

type Carga = { tipo: 'carregando' } | { tipo: 'ok'; dados: BillingResponse } | { tipo: 'erro'; problema: Problema };
type Dialogo =
  | { tipo: 'pix'; fatura: BillingInvoice; assinando: boolean }
  | { tipo: 'assinar'; plano: BillingPlan }
  | { tipo: 'trocar' }
  | { tipo: 'cancelar' }
  | { tipo: 'desistir' };

/** O nome do arquivo da exportação: "liame-dados-2026-10-31.json". */
const nomeDaExportacao = (hoje: string) => `liame-dados-${hoje}.json`;

export function CobrancaTela() {
  const { empresa, pode } = useSessao();
  const avisar = useAvisar();
  const parametros = useSearchParams();
  const marcaDoEndereco = parametros.get('marca');
  const podeVer = pode('cobranca.ver');
  const souDono = empresa?.role === 'dono';
  const titulo = useRef<HTMLHeadingElement>(null);
  const [marcas, setMarcas] = useState<BrandResponse[] | null>(null);
  const [erroMarcas, setErroMarcas] = useState<Problema | null>(null);
  const [marca, setMarca] = useState<string | null>(null);
  const [carga, setCarga] = useState<Carga>({ tipo: 'carregando' });
  const [tentativa, setTentativa] = useState(0);
  const [planos, setPlanos] = useState<BillingPlan[] | null>(null);
  const [contatos, setContatos] = useState<BillingContactsResponse | null>(null);
  const [dialogo, setDialogo] = useState<Dialogo | null>(null);
  const [exportando, setExportando] = useState(false);
  const [mantendo, setMantendo] = useState(false);
  const seq = useRef(0);

  const carregarMarcas = useCallback(async () => {
    setErroMarcas(null);
    const r = await chamar(() => api.GET('/v1/brands'));
    if (!r.ok) return setErroMarcas(r.problema);
    setMarcas(r.data.items.filter((b) => !b.archived_at));
  }, []);

  useEffect(() => {
    disparar(carregarMarcas());
    // Quem cuida da cobrança: o nome do Dono nas frases de quem não muda o contrato, e a lista para quem não vê.
    disparar(chamar(() => api.GET('/v1/billing/contacts')).then((r) => setContatos(r.ok ? r.data : null)));
  }, [carregarMarcas]);

  // A marca do endereço vale a cada chegada (V148); sem ela, a que já estava, ou a primeira.
  useEffect(() => {
    if (!marcas) return;
    setMarca((m) => {
      if (marcaDoEndereco && marcas.some((b) => b.id === marcaDoEndereco)) return marcaDoEndereco;
      return m && marcas.some((b) => b.id === m) ? m : (marcas[0]?.id ?? null);
    });
  }, [marcas, marcaDoEndereco]);

  useEffect(() => {
    if (!marca || !podeVer) return;
    const id = ++seq.current;
    setCarga({ tipo: 'carregando' });
    disparar(
      chamar(() => api.GET('/v1/billing', { params: { query: { brand_id: marca } } })).then((r) => {
        // Só a resposta mais nova vale (trocar de marca no meio de uma leitura não mistura as cobranças).
        if (id !== seq.current) return;
        setCarga(r.ok ? { tipo: 'ok', dados: r.data } : { tipo: 'erro', problema: r.problema });
      }),
    );
  }, [marca, podeVer, tentativa]);

  // Os planos fazem falta sem assinatura viva (para escolher um) e para trocar de plano.
  const dados = carga.tipo === 'ok' ? carga.dados : null;
  const precisaDosPlanos = Boolean(dados?.enabled && (!dados.subscription || dados.subscription.status === 'encerrada' || dialogo?.tipo === 'trocar'));
  useEffect(() => {
    if (!precisaDosPlanos || planos) return;
    disparar(chamar(() => api.GET('/v1/billing/plans')).then((r) => setPlanos(r.ok ? r.data.items : [])));
  }, [precisaDosPlanos, planos]);

  const atualizar = useCallback((r: BillingResponse) => {
    seq.current++;
    setCarga({ tipo: 'ok', dados: r });
  }, []);

  const dono = contatos?.items.find((c) => c.role === 'dono')?.name ?? null;
  const nomeDaMarca = marcas?.find((b) => b.id === marca)?.name ?? 'a marca';

  async function exportar(hoje: string) {
    setExportando(true);
    const r = await chamar(() => api.GET('/v1/export'));
    setExportando(false);
    if (!r.ok) return avisar(mensagemDe(r.problema), { tipo: 'perigo' });
    const url = URL.createObjectURL(new Blob([JSON.stringify(r.data, null, 2)], { type: 'application/json;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = nomeDaExportacao(hoje);
    a.click();
    URL.revokeObjectURL(url);
    avisar('Os dados da empresa foram baixados, em JSON.');
  }

  // Manter a assinatura cancelada (P26): sem o código do app, como pagar; só o Dono (D-A7-13).
  async function manter() {
    if (!marca) return;
    setMantendo(true);
    const r = await chamar(() => api.POST('/v1/billing/subscription/keep', { body: { brand_id: marca } }));
    setMantendo(false);
    if (!r.ok) return avisar(mensagemDe(r.problema), { tipo: 'perigo' });
    atualizar(r.data);
    const fim = r.data.subscription?.period_end;
    avisar(fim ? `Assinatura mantida. A próxima cobrança é em ${diaMesDe(fim)}.` : 'Assinatura mantida.');
    titulo.current?.focus({ preventScroll: true });
  }

  // Depois de mudar o contrato: a tela com a resposta; subir de plano deixa a diferença em aberto, e o PIX dela abre.
  const depoisDeMudar = (anterior: Dialogo['tipo']) => (r: BillingResponse) => {
    atualizar(r);
    const diferenca = anterior === 'trocar' ? r.invoices.find((f) => f.kind === 'diferenca' && f.status === 'aberta') : undefined;
    if (diferenca) setDialogo({ tipo: 'pix', fatura: diferenca, assinando: false });
    else if (anterior === 'trocar') {
      const s = r.subscription;
      avisar(s?.next_plan && s.period_end ? `A partir de ${diaMesDe(s.period_end)}, o plano passa a ser o ${s.next_plan.name}.` : 'Plano trocado.');
    }
    else if (anterior === 'cancelar') avisar(r.subscription?.period_end ? `Assinatura cancelada. Ela termina em ${diaMesDe(r.subscription.period_end)}.` : 'Assinatura cancelada.');
  };

  const cabecalho = (
    <div className="view-cab">
      <div>
        <h1 id="h-cobranca" ref={titulo} tabIndex={-1}>
          Plano e cobrança
        </h1>
        <p>A assinatura da {nomeDaMarca}: o plano, a forma de pagamento e as faturas.</p>
      </div>
      {marcas && marcas.length > 1 && (
        <div className="cab-acoes">
          <label className="res-campo">
            <span>Marca</span>
            <select className="input" value={marca ?? ''} onChange={(e) => setMarca(e.target.value)}>
              {marcas.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </div>
  );

  // Quem não vê a cobrança chega aqui só por um link: a tela diz quem cuida dela (D-A7-13, D-A7-41).
  if (!podeVer) {
    const quem = contatos?.enabled ? contatos.items : [];
    return (
      <section aria-labelledby="h-cobranca">
        <div className="view-cab">
          <div>
            <h1 id="h-cobranca" tabIndex={-1}>
              Plano e cobrança
            </h1>
          </div>
        </div>
        <div className="card">
          <Estado icone="lock" titulo="A cobrança fica com o Dono">
            {quem.length ? 'O plano e os pagamentos são vistos só por quem cuida da cobrança. Fale com um deles se precisar de uma mudança no plano:' : 'O plano e os pagamentos são vistos só por quem cuida da cobrança. Se precisar, fale com o Dono da conta.'}
          </Estado>
          {quem.length > 0 && (
            <ul className="quem-cuida">
              {quem.map((c) => (
                <li key={`${c.role}-${c.name}`}>
                  <span className="av-user" aria-hidden="true">
                    {c.name.charAt(0).toUpperCase()}
                  </span>
                  {c.name}, {c.role === 'dono' ? 'Dono' : 'Administrador com a cobrança liberada'}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    );
  }

  let corpo: ReactNode;
  if (erroMarcas) {
    corpo = (
      <div className="card">
        <Estado icone="alert" titulo="Não deu para abrir as marcas" perigo acao={<button className="btn" type="button" onClick={() => disparar(carregarMarcas())}>Tentar de novo</button>}>
          {mensagemDe(erroMarcas)}
        </Estado>
      </div>
    );
  } else if (marcas && !marcas.length) {
    corpo = (
      <div className="card">
        <Estado icone="info" titulo="Nenhuma marca ativa nesta empresa">
          A assinatura é por marca: quando a empresa tiver uma marca ativa, o plano dela aparece aqui.
        </Estado>
      </div>
    );
  } else if (carga.tipo === 'carregando') {
    corpo = (
      <div className="card" aria-busy="true">
        <p className="pix-espera" role="status">
          <span className="girando" aria-hidden="true" />
          Carregando a cobrança…
        </p>
      </div>
    );
  } else if (carga.tipo === 'erro') {
    corpo = (
      <div className="card">
        <Estado icone="alert" titulo="Não deu para abrir a cobrança" perigo acao={<button className="btn" type="button" onClick={() => setTentativa((n) => n + 1)}>Tentar de novo</button>}>
          {mensagemDe(carga.problema)}
        </Estado>
      </div>
    );
  } else {
    const r = carga.dados;
    const m = momentoDa(r);
    if (m === 'desligada') {
      corpo = (
        <div className="card">
          <Estado icone="wallet" titulo="O plano e a cobrança ainda não estão ligados para esta empresa">
            Quem liga é a Liame, quando a cobrança da empresa começar. Até lá, nada é cobrado.
          </Estado>
        </div>
      );
    } else if (m === 'sem' || m === 'terminou') {
      corpo = (
        <div className="cob-grade">
          <div className="cob-col cob-col--toda">
            <article className="card sit" aria-labelledby="cob-sit-t">
              <div className="sit-cab">
                <span className="st st--espera">
                  <span className="dot" aria-hidden="true" />
                  Sem assinatura
                </span>
              </div>
              <h2 className="sit-titulo" id="cob-sit-t" tabIndex={-1}>
                {m === 'terminou' ? 'A assinatura terminou' : 'Escolha um plano para a equipe começar'}
              </h2>
              {m === 'terminou' && r.subscription && <p className="sit-frase">{textoDoFim(r.subscription, r.invoices)}</p>}
              <p className="sit-nota">Sem fidelidade: você cancela quando quiser, sem multa. Na primeira contratação, pode desistir em até 7 dias e receber tudo de volta.</p>
              {planos === null ? (
                <p className="pix-espera" role="status">
                  <span className="girando" aria-hidden="true" />
                  Carregando os planos…
                </p>
              ) : (
                <PlanosParaAssinar planos={planos} podeAssinar={r.can_manage} aoAssinar={(p) => setDialogo({ tipo: 'assinar', plano: p })} />
              )}
            </article>
          </div>
          {r.invoices.length > 0 && (
            <div className="cob-col">
              <CartaoFaturas invoices={r.invoices} hoje={r.today} />
            </div>
          )}
        </div>
      );
    } else {
      const aberta = emAberto(r.invoices);
      const sit = situacao(m, r, { aberta, paga: ultimaPaga(r.invoices), souDono });
      const s = r.subscription!;
      corpo = (
        <div className="cob-grade">
          <div className="cob-col cob-col--toda">
            <CartaoSituacao
              s={sit}
              idTitulo="cob-sit-t"
              acoes={{
                pagarRotulo: aberta ? `Pagar ${reaisDeCentavos(aberta.amount_cents)} com PIX` : null,
                aoPagar: () => aberta && setDialogo({ tipo: 'pix', fatura: aberta, assinando: m === 'aguardando' }),
                aoExportar: () => disparar(exportar(r.today)),
                exportando,
                desistirRotulo: `Desistir e receber ${reaisDeCentavos(valorDaDesistencia(r.invoices, s.plan.price_cents))}`,
                aoDesistir: () => setDialogo({ tipo: 'desistir' }),
                aoManter: () => disparar(manter()),
                mantendo,
              }}
            />
          </div>
          <div className="cob-col">
            <CartaoPlano s={s} momento={m} souDono={souDono && r.can_manage} nomeDoDono={dono} aoTrocar={() => setDialogo({ tipo: 'trocar' })} />
            <CartaoForma s={s} />
          </div>
          <div className="cob-col">
            <CartaoFaturas invoices={r.invoices} hoje={r.today} />
            <CartaoFases linhas={fases(m, s)} />
          </div>
          {souDono && r.can_manage && (m === 'em-dia' || m === 'primeira') && (
            <div className="cob-col cob-col--toda">
              <RodapeCancelar fim={s.period_end} aoCancelar={() => setDialogo({ tipo: 'cancelar' })} />
            </div>
          )}
        </div>
      );
    }
  }

  return (
    <section aria-labelledby="h-cobranca">
      {cabecalho}
      {corpo}
      {dialogo?.tipo === 'assinar' && marca && (
        <DialogoAssinar
          brandId={marca}
          plano={dialogo.plano}
          reserva={titulo}
          aoFechar={() => setDialogo((d) => (d?.tipo === 'assinar' ? null : d))}
          aoAssinar={(r) => {
            atualizar(r);
            const primeira = emAberto(r.invoices);
            setDialogo(primeira ? { tipo: 'pix', fatura: primeira, assinando: true } : null);
          }}
        />
      )}
      {dialogo?.tipo === 'trocar' && marca && dados?.subscription && planos && (
        <DialogoTrocarPlano
          brandId={marca}
          s={dados.subscription}
          hoje={dados.today}
          planos={planos}
          reserva={titulo}
          aoFechar={() => setDialogo((d) => (d?.tipo === 'trocar' ? null : d))}
          aoMudar={depoisDeMudar('trocar')}
        />
      )}
      {dialogo?.tipo === 'cancelar' && marca && dados?.subscription && (
        <DialogoCancelar
          brandId={marca}
          s={dados.subscription}
          reserva={titulo}
          aoFechar={() => setDialogo((d) => (d?.tipo === 'cancelar' ? null : d))}
          aoMudar={depoisDeMudar('cancelar')}
        />
      )}
      {dialogo?.tipo === 'desistir' && marca && dados?.subscription && (
        <DialogoDesistir
          brandId={marca}
          s={dados.subscription}
          valorCentavos={valorDaDesistencia(dados.invoices, dados.subscription.plan.price_cents)}
          reserva={titulo}
          aoFechar={() => setDialogo((d) => (d?.tipo === 'desistir' ? null : d))}
          aoMudar={depoisDeMudar('desistir')}
        />
      )}
      {dialogo?.tipo === 'pix' && marca && (
        <DialogoPix
          brandId={marca}
          marca={nomeDaMarca}
          fatura={dialogo.fatura}
          assinando={dialogo.assinando}
          reserva={titulo}
          aoFechar={() => setDialogo((d) => (d?.tipo === 'pix' ? null : d))}
          aoAtualizar={atualizar}
        />
      )}
    </section>
  );
}
