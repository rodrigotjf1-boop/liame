'use client';

import type { BudgetLimitsRequest, BudgetMonthResponse } from '@liame/contracts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAvisar } from '@/components/ui/avisos';
import { Estado } from '@/components/ui/estado';
import { Icone } from '@/components/ui/icone';
import { useAgora } from '@/lib/agora';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { useSessao } from '@/lib/sessao';
import { telaDaVerba } from './textos';
import { VerbaConteudo } from './verba-conteudo';

// "Verba do mês" (mockups/prototipo-anuncios.html, P9 aprovado em 05/10/2026): quanto a empresa pode gastar em
// anúncios, quanto já gastou, os dois limites e o que o Liame mudou. A conta é do servidor (`GET /v1/budget/month`,
// de quem acompanha as campanhas); definir os limites é de quem gerencia o orçamento (`PUT /v1/budget/limits`).

type Carga = { tipo: 'carregando' } | { tipo: 'ok'; dados: BudgetMonthResponse } | { tipo: 'erro'; problema: Problema };

/** O endereço `/verba#limites` abre a tela já no formulário dos limites (o botão "Definir os limites" do Resumo). */
const ANCORA_DOS_LIMITES = '#limites';

export function VerbaTela() {
  const { pode } = useSessao();
  const avisar = useAvisar();
  const podeVer = pode('campanhas.ver');
  const podeDefinir = pode('orcamento.gerenciar');
  const titulo = useRef<HTMLHeadingElement>(null);
  const botaoEditar = useRef<HTMLButtonElement>(null);
  const [carga, setCarga] = useState<Carga>({ tipo: 'carregando' });
  const [tentativa, setTentativa] = useState(0);
  const [editando, setEditando] = useState(false);
  /** O que recebe o foco depois do próximo desenho: o título (depois de "Tentar de novo") ou o botão dos limites. */
  const focar = useRef<'titulo' | 'botao' | null>(null);
  // Só a resposta mais nova vale (salvar os limites no meio de uma leitura não volta os números de antes).
  const seq = useRef(0);
  const agora = useAgora(60_000, carga.tipo === 'ok' ? carga.dados.generated_at : null);

  useEffect(() => {
    if (!podeVer) return;
    const id = ++seq.current;
    disparar(
      chamar(() => api.GET('/v1/budget/month')).then((r) => {
        if (id !== seq.current) return;
        setCarga(r.ok ? { tipo: 'ok', dados: r.data } : { tipo: 'erro', problema: r.problema });
      }),
    );
  }, [podeVer, tentativa]);

  // Quem chega pelo "Definir os limites" do Resumo já encontra o formulário aberto.
  useEffect(() => {
    if (podeDefinir && window.location.hash === ANCORA_DOS_LIMITES) setEditando(true);
  }, [podeDefinir]);

  useEffect(() => {
    if (!focar.current) return;
    if (focar.current === 'titulo' && carga.tipo !== 'ok') return;
    const alvo = focar.current === 'titulo' ? titulo.current : botaoEditar.current;
    focar.current = null;
    alvo?.focus({ preventScroll: true });
  }, [carga, editando]);

  const tela = useMemo(() => (carga.tipo === 'ok' ? telaDaVerba(carga.dados, agora) : null), [carga, agora]);

  if (!podeVer) {
    return (
      <Estado icone="lock" titulo="Esta tela é de quem acompanha as campanhas">
        O seu nível nesta empresa não mostra a verba dos anúncios. Se precisar, peça ao dono da conta.
      </Estado>
    );
  }

  function tentarDeNovo() {
    focar.current = 'titulo';
    setCarga({ tipo: 'carregando' });
    setTentativa((t) => t + 1);
  }

  function fecharOFormulario() {
    focar.current = 'botao';
    setEditando(false);
  }

  async function salvar(corpo: BudgetLimitsRequest): Promise<Problema | null> {
    const id = ++seq.current;
    const r = await chamar(() => api.PUT('/v1/budget/limits', { body: corpo }));
    if (!r.ok) return r.problema;
    // A resposta já é a verba do mês com os limites novos.
    if (id === seq.current) setCarga({ tipo: 'ok', dados: r.data });
    fecharOFormulario();
    avisar('Limites salvos. Eles já valem para os próximos pedidos.');
    return null;
  }

  let corpo;
  if (carga.tipo === 'erro') {
    corpo = (
      <div className="card">
        <Estado
          icone="alert-circle"
          perigo
          titulo="Não foi possível carregar a verba do mês"
          acao={
            <div className="vazio-acoes">
              <button className="btn btn--primary" type="button" onClick={tentarDeNovo}>
                <Icone nome="refresh" />
                Tentar de novo
              </button>
            </div>
          }
        >
          {mensagemDe(carga.problema)} Nada foi perdido, e nada mudou nas campanhas.
        </Estado>
      </div>
    );
  } else if (carga.tipo !== 'ok' || !tela) {
    corpo = <VerbaCarregando />;
  } else {
    corpo = (
      <VerbaConteudo
        tela={tela}
        limites={{ mes: carga.dados.limits.month_micros, campanha: carga.dados.limits.campaign_daily_micros }}
        podeDefinir={podeDefinir}
        podeVerContas={pode('contas.ver')}
        podeVerResultados={pode('vendas.ver')}
        editando={editando}
        aoEditar={() => setEditando(true)}
        aoCancelar={fecharOFormulario}
        aoSalvar={salvar}
        botaoEditar={botaoEditar}
      />
    );
  }

  return (
    <section aria-labelledby="h-verba">
      <div className="view-cab anima" style={{ ['--i' as string]: 0 }}>
        <div>
          <h1 id="h-verba" ref={titulo} tabIndex={-1}>
            Verba do mês
          </h1>
          <p>Quanto a sua empresa pode gastar em anúncios, quanto já gastou e o que o Liame mudou. O pedido que faria o mês passar do teto é negado.</p>
        </div>
        {tela?.lido && <span className="lite-chip">{tela.lido}</span>}
      </div>
      {corpo}
    </section>
  );
}

function VerbaCarregando() {
  return (
    <div className="verba" aria-busy="true">
      <p className="sr-only">Carregando a verba do mês…</p>
      <div className="card res-esqueleto" aria-hidden="true">
        <span className="esqueleto esqueleto--curto" />
        <span className="esqueleto esqueleto--alto" />
        <span className="esqueleto esqueleto--medio" />
        <span className="esqueleto esqueleto--medio" />
      </div>
      <div className="card res-esqueleto" aria-hidden="true">
        <span className="esqueleto esqueleto--medio" />
        <span className="esqueleto esqueleto--bloco" />
      </div>
    </div>
  );
}
