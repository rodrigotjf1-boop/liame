'use client';

import type { BrandResponse, ReviewsResponse } from '@liame/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Estado } from '@/components/ui/estado';
import { Icone } from '@/components/ui/icone';
import { useAgora } from '@/lib/agora';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { useSessao } from '@/lib/sessao';
import { AvaliacoesConteudo } from './avaliacoes-conteudo';
import { type Autores, telaDasAvaliacoes } from './textos';

// "Avaliações" (mockups/prototipo-avaliacoes.html, P17 aprovado em 09/10/2026; Z1 da A6): o que as pessoas escreveram
// sobre a empresa no Google. A lista e o resumo vêm do que o Liame guardou (`GET /v1/reviews`, de quem acompanha as
// campanhas); o nome de quem avaliou é lido do Google na hora (`GET /v1/reviews/authors`), só para esta tela, e a
// lista aparece sem esperar por ele. Esta tela só lê: responder pelo Liame, com aprovação, é da Z2.

type Carga = { tipo: 'carregando' } | { tipo: 'ok'; dados: ReviewsResponse } | { tipo: 'erro'; problema: Problema };

export function AvaliacoesTela() {
  const { pode } = useSessao();
  const podeVer = pode('campanhas.ver');
  const podeVerContas = pode('contas.ver');
  const titulo = useRef<HTMLHeadingElement>(null);
  const [marcas, setMarcas] = useState<BrandResponse[] | null>(null);
  const [erroMarcas, setErroMarcas] = useState<Problema | null>(null);
  const [marca, setMarca] = useState<string | null>(null);
  const [carga, setCarga] = useState<Carga>({ tipo: 'carregando' });
  const [autores, setAutores] = useState<Autores>(null);
  const [tentativa, setTentativa] = useState(0);
  /** Depois de "Tentar de novo", o foco volta ao título quando a leitura chega. */
  const focarTitulo = useRef(false);
  // Só a resposta mais nova vale (trocar de marca no meio de uma leitura não mistura as avaliações).
  const seq = useRef(0);
  const agora = useAgora(60_000, carga.tipo === 'ok' ? carga.dados.generated_at : null);

  const carregarMarcas = useCallback(async () => {
    setErroMarcas(null);
    const r = await chamar(() => api.GET('/v1/brands'));
    if (!r.ok) return setErroMarcas(r.problema);
    const ativas = r.data.items.filter((b) => !b.archived_at);
    setMarcas(ativas);
    setMarca((m) => (m && ativas.some((b) => b.id === m) ? m : (ativas[0]?.id ?? null)));
  }, []);

  useEffect(() => {
    if (podeVer) disparar(carregarMarcas());
  }, [podeVer, carregarMarcas]);

  useEffect(() => {
    if (!marca) return;
    const id = ++seq.current;
    setCarga({ tipo: 'carregando' });
    setAutores(null);
    disparar(
      chamar(() => api.GET('/v1/reviews', { params: { query: { brand_id: marca } } })).then(async (r) => {
        if (id !== seq.current) return;
        setCarga(r.ok ? { tipo: 'ok', dados: r.data } : { tipo: 'erro', problema: r.problema });
        // Os nomes só fazem falta com avaliação na tela; sem eles, a lista aparece do mesmo jeito.
        if (!r.ok || r.data.state !== 'pronta' || !r.data.reviews.length) return;
        const nomes = await chamar(() => api.GET('/v1/reviews/authors', { params: { query: { brand_id: marca } } }));
        if (id === seq.current) setAutores(nomes.ok ? nomes.data : 'falhou');
      }),
    );
  }, [marca, tentativa]);

  useEffect(() => {
    if (!focarTitulo.current || carga.tipo === 'carregando') return;
    focarTitulo.current = false;
    titulo.current?.focus({ preventScroll: true });
  }, [carga]);

  const tela = useMemo(() => (carga.tipo === 'ok' ? telaDasAvaliacoes(carga.dados, agora, autores) : null), [carga, agora, autores]);

  if (!podeVer) {
    return (
      <Estado icone="lock" titulo="Esta tela é de quem acompanha as campanhas">
        O seu nível nesta empresa não mostra as avaliações. Se precisar, peça ao dono da conta.
      </Estado>
    );
  }

  // A marca pode ter sido arquivada no meio do caminho: a nova tentativa relê as marcas antes das avaliações.
  function tentarDeNovo() {
    focarTitulo.current = true;
    disparar(carregarMarcas());
    setTentativa((t) => t + 1);
  }

  const problema = erroMarcas ?? (carga.tipo === 'erro' ? carga.problema : null);
  let corpo;
  if (problema) {
    corpo = (
      <div className="card">
        <Estado
          icone="alert-circle"
          perigo
          titulo="Não foi possível carregar as avaliações"
          acao={
            <div className="vazio-acoes">
              <button className="btn btn--primary" type="button" onClick={tentarDeNovo}>
                <Icone nome="refresh" pequeno />
                Tentar de novo
              </button>
            </div>
          }
        >
          {mensagemDe(problema)} Nada foi perdido.
        </Estado>
      </div>
    );
  } else if (marcas && !marcas.length) {
    corpo = (
      <div className="card">
        <Estado icone="info" titulo="Nenhuma marca ativa nesta empresa">
          As avaliações são lidas por marca: quando a empresa tiver uma marca ativa, elas aparecem aqui.
        </Estado>
      </div>
    );
  } else if (carga.tipo !== 'ok' || !tela) {
    corpo = <AvaliacoesCarregando />;
  } else {
    corpo = <AvaliacoesConteudo tela={tela} podeVerContas={podeVerContas} />;
  }

  const lido = tela && (tela.tipo === 'lista' || tela.tipo === 'vazia') ? tela.lido : null;

  return (
    <section aria-labelledby="h-avaliacoes">
      <div className="view-cab anima" style={{ ['--i' as string]: 0 }}>
        <div>
          <h1 id="h-avaliacoes" ref={titulo} tabIndex={-1}>
            Avaliações
          </h1>
          <p>O que as pessoas escreveram sobre a sua empresa no Google, com a nota e a situação da resposta de cada avaliação.</p>
        </div>
        {lido && (
          <span className="lite-chip" id="av-lido">
            {lido}
          </span>
        )}
      </div>
      {marcas && marcas.length > 1 && (
        <div className="av-filtros">
          <label className="res-campo">
            <span>Marca</span>
            <select className="input" id="av-marca" value={marca ?? ''} onChange={(e) => setMarca(e.target.value)}>
              {marcas.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {corpo}
    </section>
  );
}

function AvaliacoesCarregando() {
  return (
    <div className="av" aria-busy="true">
      <p className="sr-only">Carregando as avaliações…</p>
      <div className="card res-esqueleto" aria-hidden="true">
        <span className="esqueleto esqueleto--curto" />
        <span className="esqueleto esqueleto--alto" />
      </div>
      <div className="card res-esqueleto" aria-hidden="true">
        <span className="esqueleto esqueleto--medio" />
        <span className="esqueleto esqueleto--medio" />
        <span className="esqueleto esqueleto--medio" />
      </div>
    </div>
  );
}
