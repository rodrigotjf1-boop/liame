'use client';

import type { BrandResponse, WeeklyReviewResponse } from '@liame/contracts';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Estado } from '@/components/ui/estado';
import { Icone } from '@/components/ui/icone';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { useSessao } from '@/lib/sessao';
import { RevisaoConteudo } from './revisao-conteudo';
import { diaEscrito, introDaRevisao, semanaEscrita } from './textos';

// "Revisão da semana" (mockups/prototipo-explicar.html, P4 aprovado em 02/10/2026): a semana fechada da loja,
// como foi gerada na segunda-feira de manhã. Abre pelo cabeçalho dos Resultados e pelo link do e-mail
// (`?marca` e `?semana`, a segunda-feira da semana). A conta é do servidor; a tela só mostra.

type Carga =
  | { tipo: 'carregando' }
  | { tipo: 'ok'; dados: WeeklyReviewResponse; marca: string; semana: string | null }
  | { tipo: 'erro'; problema: Problema };

/** A semana da URL só vale no formato de data; o resto é ignorado (abre a revisão mais recente). */
const semanaValida = (s: string | null): string | null => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);

export function RevisaoTela() {
  const { pode } = useSessao();
  const params = useSearchParams();
  const podeVer = pode('vendas.ver');
  const titulo = useRef<HTMLHeadingElement>(null);
  const [marcas, setMarcas] = useState<BrandResponse[] | null>(null);
  const [erroMarcas, setErroMarcas] = useState<Problema | null>(null);
  const [marca, setMarca] = useState<string | null>(null);
  const [carga, setCarga] = useState<Carga>({ tipo: 'carregando' });
  const [tentativa, setTentativa] = useState(0);
  const seq = useRef(0);
  const marcaPedida = params.get('marca');
  const semana = semanaValida(params.get('semana'));

  const carregarMarcas = useCallback(async () => {
    setErroMarcas(null);
    const r = await chamar(() => api.GET('/v1/brands'));
    if (!r.ok) return setErroMarcas(r.problema);
    const ativas = r.data.items.filter((b) => !b.archived_at);
    setMarcas(ativas);
    // A marca do link, se é desta empresa; senão, a primeira (como na tela Resultados).
    setMarca((m) => (m && ativas.some((b) => b.id === m) ? m : (ativas.find((b) => b.id === marcaPedida)?.id ?? ativas[0]?.id ?? null)));
  }, [marcaPedida]);

  useEffect(() => {
    if (podeVer) disparar(carregarMarcas());
  }, [podeVer, carregarMarcas]);

  useEffect(() => {
    if (!marca) return;
    const id = ++seq.current;
    setCarga({ tipo: 'carregando' });
    const query = { brand_id: marca, ...(semana ? { week: semana } : {}) };
    disparar(
      chamar(() => api.GET('/v1/results/weekly-review', { params: { query } })).then((r) => {
        // Só a resposta mais nova vale (trocar de marca no meio de uma leitura não mistura revisões).
        if (id !== seq.current) return;
        setCarga(r.ok ? { tipo: 'ok', dados: r.data, marca, semana } : { tipo: 'erro', problema: r.problema });
      }),
    );
  }, [marca, semana, tentativa]);

  if (!podeVer) {
    return (
      <Estado icone="lock" titulo="Esta tela é de quem acompanha as vendas">
        O seu nível nesta empresa não mostra os resultados de vendas. Se precisar, peça ao dono da conta.
      </Estado>
    );
  }

  const dados = carga.tipo === 'ok' ? carga.dados : null;
  const revisao = dados?.review ?? null;
  const maisRecente = (
    <div className="vazio-acoes">
      <Link className="btn btn--primary" href="/resultados/revisao">
        Ver a revisão mais recente
      </Link>
    </div>
  );

  let corpo;
  if (erroMarcas) {
    corpo = <Erro problema={erroMarcas} aoTentar={() => disparar(carregarMarcas())} />;
  } else if (marcas && !marcas.length) {
    corpo = (
      <div className="card">
        <Estado icone="info" titulo="Nenhuma marca ativa nesta empresa">
          A revisão é por marca: quando a empresa tiver uma marca ativa, a revisão dela aparece aqui.
        </Estado>
      </div>
    );
  } else if (carga.tipo === 'erro') {
    // A semana pedida não é uma segunda-feira: tentar de novo daria o mesmo; o que resolve é abrir a mais recente.
    corpo =
      carga.problema.code === 'semana-invalida' ? (
        <div className="card">
          <Estado icone="calendar" titulo="Essa semana não existe" acao={maisRecente}>
            {mensagemDe(carga.problema)}
          </Estado>
        </div>
      ) : (
        <Erro problema={carga.problema} aoTentar={() => setTentativa((t) => t + 1)} />
      );
  } else if (!dados) {
    corpo = <RevisaoCarregando />;
  } else if (!revisao) {
    corpo = (
      <div className="card">
        {carga.tipo === 'ok' && carga.semana ? (
          <Estado icone="calendar" titulo="Não há revisão dessa semana" acao={maisRecente}>
            A revisão sai uma vez por semana, na segunda-feira, e só para as semanas com as vendas conectadas.
          </Estado>
        ) : (
          <Estado
            icone="calendar"
            titulo={`A primeira revisão sai na ${diaEscrito(dados.next_review_on)}`}
            acao={
              <div className="vazio-acoes">
                <Link className="btn" href="/resultados">
                  Ver os Resultados de 7 dias
                </Link>
              </div>
            }
          >
            Ela junta a semana que fecha no domingo: o que vendeu, o que cada campanha trouxe no caixa, o que mudou e o que precisa de decisão.
          </Estado>
        )}
      </div>
    );
  } else {
    corpo = <RevisaoConteudo revisao={revisao} podeVerContas={pode('contas.ver')} pode={pode} />;
  }

  return (
    <section aria-labelledby="h-revisao">
      <div className="view-cab anima" style={{ ['--i' as string]: 0 }}>
        <div>
          <h1 id="h-revisao" ref={titulo} tabIndex={-1}>
            Revisão da semana
          </h1>
          <p>{introDaRevisao(revisao?.email ?? null)}</p>
        </div>
        <div className="res-controles">
          {marcas && marcas.length > 1 && (
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
          )}
          {revisao && <span className="lite-chip">{semanaEscrita(revisao.week)}</span>}
        </div>
      </div>
      {corpo}
    </section>
  );
}

function Erro({ problema, aoTentar }: { problema: Problema; aoTentar: () => void }) {
  return (
    <div className="card">
      <Estado
        icone="alert-circle"
        perigo
        titulo="Não foi possível carregar a revisão"
        acao={
          <div className="vazio-acoes">
            <button className="btn btn--primary" type="button" onClick={aoTentar}>
              <Icone nome="refresh" />
              Tentar de novo
            </button>
          </div>
        }
      >
        {mensagemDe(problema)} Nada foi perdido.
      </Estado>
    </div>
  );
}

function RevisaoCarregando() {
  return (
    <div className="rev-sem" aria-busy="true">
      <p className="sr-only">Carregando a revisão…</p>
      {[0, 1, 2].map((i) => (
        <div className="card res-esqueleto" aria-hidden="true" key={i}>
          <span className="esqueleto esqueleto--curto" />
          <span className="esqueleto esqueleto--medio" />
          <span className="esqueleto" />
        </div>
      ))}
    </div>
  );
}
