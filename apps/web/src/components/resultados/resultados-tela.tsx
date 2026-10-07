'use client';

import type { ActionTargetsResponse, BrandResponse, ClosedLoopResponse } from '@liame/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { liaLigada } from '@/components/explicar/pedir';
import { botaoPedirAVista, type PedirNaLista } from '@/components/pedir/botao-pedir';
import { type CampanhaDoPedido, GavetaPedir } from '@/components/pedir/gaveta-pedir';
import { pedirPorCampanha } from '@/components/pedir/textos';
import { Estado } from '@/components/ui/estado';
import { Icone } from '@/components/ui/icone';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { useSessao } from '@/lib/sessao';
import type { ConsultaDePedidos } from './cartao-pedidos';
import { type ExplicarResultados, ResultadosConteudo } from './resultados-conteudo';
import { FUSO_PADRAO, fusoValido, intervaloDo, localDe, type Loja, lojasDoRegem, montarTela, nadaConectado, PERIODOS, type Periodo, rotuloDoPeriodo } from './textos';

// "Resultados" (mockups/prototipo-resultados.html, P1 aprovado em 29/09/2026): o ROAS que cada plataforma
// informa, com a janela dela, ao lado do confirmado no caixa do Regem (`GET /v1/results/closed-loop`,
// permissão `vendas.ver`). A conta é do servidor; a tela escolhe o período, a marca e a loja, e mostra.
// Para quem acompanha as campanhas, a lista delas ganha o "Pedir mudança" (protótipo P9): onde dá para pedir vem
// de `GET /v1/actions/targets`, e o botão abre a gaveta do pedido.

type Carga =
  | { tipo: 'carregando' }
  | { tipo: 'ok'; dados: ClosedLoopResponse; periodo: Periodo; marca: string; loja: string | null }
  | { tipo: 'erro'; problema: Problema };

export function ResultadosTela() {
  const { pode } = useSessao();
  const podeVer = pode('vendas.ver');
  const podeVerContas = pode('contas.ver');
  const podeVerCampanhas = pode('campanhas.ver');
  const podePedir = pode('campanhas.operar');
  const titulo = useRef<HTMLHeadingElement>(null);
  const [marcas, setMarcas] = useState<BrandResponse[] | null>(null);
  const [erroMarcas, setErroMarcas] = useState<Problema | null>(null);
  const [marca, setMarca] = useState<string | null>(null);
  const [lojas, setLojas] = useState<Loja[]>([]);
  const [loja, setLoja] = useState<string | null>(null);
  const [periodo, setPeriodo] = useState<Periodo>('7');
  const [carga, setCarga] = useState<Carga>({ tipo: 'carregando' });
  const [buscando, setBuscando] = useState(false);
  const [tentativa, setTentativa] = useState(0);
  const [anuncio, setAnuncio] = useState('');
  const [lia, setLia] = useState<{ marca: string; ligada: boolean } | null>(null);
  /** Onde dá para pedir uma mudança, pela marca; relido depois de cada pedido criado. */
  const [alvos, setAlvos] = useState<{ marca: string; dados: ActionTargetsResponse } | null>(null);
  const [versaoDosAlvos, setVersaoDosAlvos] = useState(0);
  /** A campanha com a gaveta "Pedir uma mudança" aberta. */
  const [pedindo, setPedindo] = useState<CampanhaDoPedido | null>(null);
  // Fuso da loja: corta o dia dos pedidos (a API diz qual é; até a primeira resposta, o padrão dela).
  const fuso = useRef(FUSO_PADRAO);
  // Só a resposta mais nova vale (trocar de período no meio de uma leitura não mistura números).
  const seq = useRef(0);
  const aAnunciar = useRef<string | null>(null);

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

  // A LIA responde para esta marca? Decide o botão "Explicar": o da LIA ou o neutro (resumo do sistema).
  useEffect(() => {
    if (!marca || !podeVer) return;
    let vivo = true;
    disparar(
      liaLigada(marca).then((ligada) => {
        if (vivo) setLia({ marca, ligada });
      }),
    );
    return () => {
      vivo = false;
    };
  }, [marca, podeVer]);

  // As campanhas da marca em que dá para pedir uma mudança (e os pedidos em aberto de cada uma). Se a leitura
  // falhar, a lista de campanhas segue sem o botão: a tela é de resultado, e o pedido é um extra dela.
  useEffect(() => {
    if (!marca || !podeVerCampanhas) return;
    let vivo = true;
    disparar(
      chamar(() => api.GET('/v1/actions/targets', { params: { query: { brand_id: marca } } })).then((r) => {
        if (vivo && r.ok) setAlvos({ marca, dados: r.data });
      }),
    );
    return () => {
      vivo = false;
    };
  }, [marca, podeVerCampanhas, versaoDosAlvos]);

  // Lojas do Regem da marca, para escolher uma (só quem vê as contas; sem isso, todas as lojas).
  useEffect(() => {
    if (!marca || !podeVerContas) return;
    let vivo = true;
    disparar(
      chamar(() => api.GET('/v1/connections', { params: { query: { brand_id: marca } } })).then((r) => {
        if (vivo && r.ok) setLojas(lojasDoRegem(r.data.items));
      }),
    );
    return () => {
      vivo = false;
    };
  }, [marca, podeVerContas]);

  useEffect(() => {
    if (!marca) return;
    const id = ++seq.current;
    setBuscando(true);
    const agora = new Date();
    const { from, to } = intervaloDo(periodo, fuso.current, agora);
    const query = { brand_id: marca, from, to, ...(loja ? { unit_id: loja } : {}) };
    disparar(
      chamar(() => api.GET('/v1/results/closed-loop', { params: { query } })).then((r) => {
        if (id !== seq.current) return;
        if (r.ok) {
          // A loja está em outro fuso: se o dia muda, pede de novo com as datas certas.
          const tz = fusoValido(r.data.period.timezone);
          if (tz !== fuso.current) {
            fuso.current = tz;
            const certo = intervaloDo(periodo, tz, agora);
            if (certo.from !== from || certo.to !== to) return setTentativa((t) => t + 1);
          }
        }
        setBuscando(false);
        setCarga(r.ok ? { tipo: 'ok', dados: r.data, periodo, marca, loja } : { tipo: 'erro', problema: r.problema });
        if (aAnunciar.current) {
          setAnuncio(r.ok ? aAnunciar.current : 'Não deu para carregar os resultados.');
          aAnunciar.current = null;
        }
      }),
    );
  }, [marca, loja, periodo, tentativa]);

  const nomeDaMarca = marcas?.find((m) => m.id === marca)?.name ?? null;
  const dados = carga.tipo === 'ok' ? carga : null;
  const lojaEscolhida = dados?.loja ? (lojas.find((l) => l.id === dados.loja) ?? null) : null;
  const tela = useMemo(
    () => (dados ? montarTela(dados.dados, dados.periodo, new Date(dados.dados.generated_at), localDe(dados.dados, lojaEscolhida, nomeDaMarca)) : null),
    [dados, lojaEscolhida, nomeDaMarca],
  );
  // Só os alvos da marca que está na tela (trocar de marca não mostra o botão da anterior).
  const alvosDaMarca = alvos && dados && alvos.marca === dados.marca ? alvos.dados : null;
  const pedir = useMemo<PedirNaLista | null>(
    () => (alvosDaMarca ? { porCampanha: pedirPorCampanha(alvosDaMarca), podePedir, aberta: pedindo?.id ?? null, aoPedir: setPedindo } : null),
    [alvosDaMarca, podePedir, pedindo],
  );

  if (!podeVer) {
    return (
      <Estado icone="lock" titulo="Esta tela é de quem acompanha as vendas">
        O seu nível nesta empresa não mostra os resultados de vendas. Se precisar, peça ao dono da conta.
      </Estado>
    );
  }

  function mudarPeriodo(p: Periodo) {
    if (p === periodo) return;
    aAnunciar.current = `Período: ${rotuloDoPeriodo(p)}`;
    setPeriodo(p);
  }

  // "Explicar" (A3 · I4): só com o que explicar. Em "Hoje" o gasto do dia ainda não chegou; sem o Regem
  // ou sem pedido com origem não há resultado confirmado. O botão espera saber se a LIA responde.
  const confirmado = dados?.dados.totals.confirmed;
  const explicar: ExplicarResultados | null =
    dados && tela && lia && lia.marca === dados.marca && !tela.base.hoje && !tela.base.semRegem && confirmado && confirmado.orders > 0 && confirmado.roas !== null
      ? {
          pedido: { de: 'resultados', brand_id: dados.marca, from: dados.dados.period.from, to: dados.dados.period.to, ...(dados.loja ? { unit_id: dados.loja } : {}) },
          lia: lia.ligada,
          semOrigemAlta: Number(dados.dados.totals.without_origin.share_pct ?? 0) > 30,
        }
      : null;

  const regem = dados ? dados.dados.sources.filter((s) => s.provider === 'regem') : [];
  const lojaDoPedido = lojaEscolhida?.nome ?? (regem.length === 1 ? regem[0]!.name : null);
  const consulta: ConsultaDePedidos | null =
    dados && tela && !tela.base.semRegem
      ? { brand_id: dados.marca, from: dados.dados.period.from, to: dados.dados.period.to, ...(dados.loja ? { unit_id: dados.loja } : {}) }
      : null;

  let corpo;
  if (erroMarcas) {
    corpo = <Erro problema={erroMarcas} aoTentar={() => disparar(carregarMarcas())} />;
  } else if (marcas && !marcas.length) {
    corpo = (
      <div className="card">
        <Estado icone="info" titulo="Nenhuma marca ativa nesta empresa">
          Os resultados são por marca: quando a empresa tiver uma marca ativa, os números dela aparecem aqui.
        </Estado>
      </div>
    );
  } else if (carga.tipo === 'erro') {
    corpo = <Erro problema={carga.problema} aoTentar={() => setTentativa((t) => t + 1)} ocupado={buscando} />;
  } else if (!dados || !tela) {
    corpo = <ResultadosCarregando />;
  } else if (nadaConectado(dados.dados)) {
    corpo = (
      <div className={buscando ? 'card recarregando' : 'card'} aria-busy={buscando}>
        <Estado
          icone="plug"
          titulo="Conecte as contas para ver os resultados"
          acao={
            podeVerContas ? (
              <div className="vazio-acoes">
                <Link className="btn btn--primary" href="/contas">
                  Abrir Contas conectadas
                </Link>
              </div>
            ) : undefined
          }
        >
          Os resultados comparam o que a mídia custou (Meta e Google) com o que virou pedido no caixa da loja (Regem).
        </Estado>
      </div>
    );
  } else {
    corpo = (
      <div className={buscando ? 'res-corpo recarregando' : 'res-corpo'} aria-busy={buscando}>
        <ResultadosConteudo
          tela={tela}
          modelo={dados.dados.model}
          consulta={consulta}
          loja={lojaDoPedido}
          podeVerContas={podeVerContas}
          reserva={titulo}
          explicar={explicar}
          pedir={pedir}
        />
      </div>
    );
  }

  return (
    <section aria-labelledby="h-res">
      <div className="view-cab anima" style={{ ['--i' as string]: 0 }}>
        <div>
          <h1 id="h-res" ref={titulo} tabIndex={-1}>
            Resultados
          </h1>
          <p>O que a mídia virou de verdade: pedidos, receita e margem confirmados no caixa do Regem, ao lado do que cada plataforma informa.</p>
        </div>
        <div className="res-controles">
          {/* A revisão da semana abre por aqui; sem o Regem não há o que revisar (protótipo P4). */}
          {dados && tela && !tela.base.semRegem && (
            <Link className="btn btn--sm" href={`/resultados/revisao?marca=${dados.marca}`}>
              <Icone nome="file" pequeno />
              Revisão da semana
            </Link>
          )}
          {marcas && marcas.length > 1 && (
            <label className="res-campo">
              <span>Marca</span>
              <select
                className="input"
                value={marca ?? ''}
                onChange={(e) => {
                  setMarca(e.target.value);
                  setLoja(null);
                  setLojas([]);
                }}
              >
                {marcas.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {lojas.length > 1 && (
            <label className="res-campo">
              <span>Loja</span>
              <select className="input" value={loja ?? ''} onChange={(e) => setLoja(e.target.value || null)}>
                <option value="">Todas as lojas</option>
                {lojas.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.nome}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="seg" role="group" aria-label="Período">
            {PERIODOS.map((p) => (
              <button key={p.id} type="button" aria-pressed={periodo === p.id} onClick={() => mudarPeriodo(p.id)}>
                {p.botao}
              </button>
            ))}
          </div>
        </div>
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {anuncio}
      </p>
      {corpo}
      {pedindo && (
        <GavetaPedir
          key={pedindo.id}
          campanha={pedindo}
          podeDefinirLimites={pode('orcamento.gerenciar')}
          podeVerContas={podeVerContas}
          reserva={titulo}
          voltarPara={() => botaoPedirAVista(pedindo.id)}
          aoFechar={() => setPedindo(null)}
          aoCriar={() => setVersaoDosAlvos((v) => v + 1)}
        />
      )}
    </section>
  );
}

function Erro({ problema, aoTentar, ocupado = false }: { problema: Problema; aoTentar: () => void; ocupado?: boolean }) {
  return (
    <div className="card">
      <Estado
        icone="alert-circle"
        perigo
        titulo="Não foi possível carregar os resultados"
        acao={
          <div className="vazio-acoes">
            <button className="btn btn--primary" type="button" onClick={aoTentar} disabled={ocupado} aria-busy={ocupado}>
              <Icone nome="refresh" />
              Tentar de novo
            </button>
          </div>
        }
      >
        {mensagemDe(problema)} Nada foi perdido: os números continuam guardados.
      </Estado>
    </div>
  );
}

function ResultadosCarregando() {
  const cartao = (linhas: number, i: number) => (
    <div className="card res-esqueleto" aria-hidden="true" key={i}>
      <span className="esqueleto esqueleto--curto" />
      <span className="esqueleto esqueleto--alto" />
      {Array.from({ length: linhas }, (_, j) => (
        <span className="esqueleto esqueleto--medio" key={j} />
      ))}
    </div>
  );
  return (
    <div className="res-grid" aria-busy="true">
      <p className="sr-only">Carregando os resultados…</p>
      {cartao(2, 0)}
      {cartao(1, 1)}
      <div className="card res-esqueleto" aria-hidden="true">
        <span className="esqueleto esqueleto--curto" />
        <span className="esqueleto esqueleto--bloco" />
      </div>
    </div>
  );
}
