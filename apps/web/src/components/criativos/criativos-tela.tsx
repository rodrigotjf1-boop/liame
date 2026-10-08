'use client';

import type { AdPieceOptionsResponse, AdPieceRequestResponse, AdPieceResponse, BrandResponse, CreateAdPieceRequest } from '@liame/contracts';
import { useSearchParams } from 'next/navigation';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useAvisar } from '@/components/ui/avisos';
import { Estado } from '@/components/ui/estado';
import { Icone } from '@/components/ui/icone';
import { useAgora } from '@/lib/agora';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { useModo } from '@/lib/modo';
import { useSessao } from '@/lib/sessao';
import { CriativosLista } from './lista';
import { PecaAberta } from './peca';
import { DialogoPedirPeca } from './pedir-peca';
import { avisoDaVersaoNova, avisoDoPedidoPronto, erroDaPeca, motivoDeNaoPedir, SUBTITULO } from './textos';

// "Criativos" (mockups/prototipo-criativos.html, P10 aprovado em 05/10/2026), na entrega do TEXTO: as peças que o
// Criativo escreve a pedido de quem opera campanhas, a conferência de cada uma e a decisão (aprovar, editar, pedir
// outra, recusar). Quem vê é quem acompanha as campanhas; pedir e decidir é de quem opera (`campanhas.operar`).
// Aprovar guarda a peça na biblioteca, sem o código do app: nada sai do Liame por aqui.

type Carga =
  | { tipo: 'carregando' }
  | { tipo: 'ok'; marca: string; opcoes: AdPieceOptionsResponse; pecas: AdPieceResponse[]; pedidos: AdPieceRequestResponse[] }
  | { tipo: 'erro'; problema: Problema };
type Detalhe = { id: string; estado: 'carregando' } | { id: string; estado: 'ok'; peca: AdPieceResponse } | { id: string; estado: 'erro'; problema: Problema };

/** Enquanto o Criativo escreve, a tela pergunta de novo neste intervalo. */
const ESPERA_MS = 4000;

export function CriativosTela() {
  const { pode } = useSessao();
  const { modo } = useModo();
  const avisar = useAvisar();
  const parametros = useSearchParams();
  const podeVer = pode('campanhas.ver');
  const podeOperar = pode('campanhas.operar');
  const titulo = useRef<HTMLHeadingElement>(null);
  const [marcas, setMarcas] = useState<BrandResponse[] | null>(null);
  const [erroMarcas, setErroMarcas] = useState<Problema | null>(null);
  const [marca, setMarca] = useState<string | null>(null);
  const [carga, setCarga] = useState<Carga>({ tipo: 'carregando' });
  const [tentativa, setTentativa] = useState(0);
  const [detalhe, setDetalhe] = useState<Detalhe | null>(null);
  const [filtro, setFiltro] = useState<'aprovadas' | 'recusadas'>('aprovadas');
  const [confirmandoLote, setConfirmandoLote] = useState(false);
  const [pedindo, setPedindo] = useState<{ anuncio: string | null } | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [anuncio, setAnuncio] = useState('');
  /** O elemento que recebe o foco depois do próximo desenho (pelo id), ou o título da tela. */
  const focar = useRef<string | null>(null);
  const seq = useRef(0);
  /** O que estava em andamento na leitura anterior: é assim que a tela percebe que ficou pronto. */
  const andando = useRef<{ pedido: string | null; refazendo: Map<string, number> }>({ pedido: null, refazendo: new Map() });
  const pecaDoEndereco = useRef(parametros.get('peca'));
  const agora = useAgora(60_000, carga);

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

  /** Lê a tela inteira da marca: o que dá para pedir, as peças e os pedidos. `quieto`: sem voltar ao esqueleto (a releitura depois de uma ação e a espera do Criativo). */
  const ler = useCallback(async (brandId: string, quieto: boolean) => {
    const id = ++seq.current;
    if (!quieto) setCarga({ tipo: 'carregando' });
    const query = { brand_id: brandId };
    const [o, p, r] = await Promise.all([
      chamar(() => api.GET('/v1/ad-pieces/options', { params: { query } })),
      chamar(() => api.GET('/v1/ad-pieces', { params: { query } })),
      // Os pedidos só enfeitam a tela (de onde a peça veio, o pedido que não deu certo): sem eles, ela abre do mesmo jeito.
      chamar(() => api.GET('/v1/ad-pieces/requests', { params: { query } })),
    ]);
    if (id !== seq.current) return null;
    if (!o.ok || !p.ok) {
      // A releitura que falha não derruba a tela que já está aberta.
      if (!quieto) setCarga({ tipo: 'erro', problema: !o.ok ? o.problema : !p.ok ? p.problema : ({} as Problema) });
      return null;
    }
    const nova = { tipo: 'ok' as const, marca: brandId, opcoes: o.data, pecas: p.data.items, pedidos: r.ok ? r.data.items : [] };
    setCarga((antes) => (r.ok || antes.tipo !== 'ok' ? nova : { ...nova, pedidos: antes.pedidos }));
    return nova;
  }, []);

  useEffect(() => {
    if (!marca) return;
    setDetalhe(null);
    setConfirmandoLote(false);
    setPedindo(null);
    andando.current = { pedido: null, refazendo: new Map() };
    disparar(ler(marca, false));
  }, [marca, tentativa, ler]);

  const abrirPeca = useCallback(async (id: string, opcoes: { focar?: boolean } = {}) => {
    setDetalhe({ id, estado: 'carregando' });
    if (opcoes.focar !== false) focar.current = 'pc-titulo';
    const r = await chamar(() => api.GET('/v1/ad-pieces/{id}', { params: { path: { id } } }));
    // O título de "abrindo" dá lugar ao da peça: o foco que estava nele (ou que ficou solto) passa para o novo.
    if (opcoes.focar !== false) {
      const comFoco = document.activeElement;
      if (!comFoco || comFoco === document.body || comFoco.id === 'pc-titulo') focar.current = 'pc-titulo';
    }
    setDetalhe((d) => (d?.id === id ? (r.ok ? { id, estado: 'ok', peca: r.data } : { id, estado: 'erro', problema: r.problema }) : d));
  }, []);

  // A peça do endereço (`/criativos?peca=…`) abre assim que a lista chega.
  useEffect(() => {
    if (carga.tipo !== 'ok' || !pecaDoEndereco.current) return;
    const id = pecaDoEndereco.current;
    pecaDoEndereco.current = null;
    disparar(abrirPeca(id));
  }, [carga.tipo, abrirPeca]);

  // Enquanto o Criativo escreve (um pedido novo ou uma versão nova), a tela lê de novo de tempos em tempos e avisa
  // quando fica pronto. A pessoa pode estar com a peça aberta: ela é lida de novo só se foi a que mudou.
  const marcaCarregada = carga.tipo === 'ok' ? carga.marca : null;
  const pedidoAndando = carga.tipo === 'ok' ? (carga.opcoes.in_progress?.id ?? null) : null;
  const refazendo = carga.tipo === 'ok' ? carga.pecas.filter((p) => p.redoing).map((p) => `${p.id}:${p.current.version}`).join(',') : '';
  useEffect(() => {
    if (carga.tipo !== 'ok') return;
    const antes = andando.current;
    // O que estava andando e parou: avisa.
    if (antes.pedido && antes.pedido !== pedidoAndando) {
      const feitas = carga.pecas.filter((p) => p.request_id === antes.pedido);
      if (feitas.length) {
        const aviso = avisoDoPedidoPronto(feitas);
        avisar(aviso);
        setAnuncio(aviso);
        if (!detalhe) focar.current = 'dec-t';
      }
    }
    for (const [id, versao] of antes.refazendo) {
      const p = carga.pecas.find((x) => x.id === id);
      if (!p || p.redoing) continue;
      if (p.current.version > versao) {
        const aviso = avisoDaVersaoNova(p, false);
        avisar(aviso.texto, { tipo: aviso.tipo });
        setAnuncio(aviso.texto);
      } else {
        avisar(`A versão nova de “${p.current.title}” não ficou pronta: a peça segue na versão ${p.current.version}.`, { tipo: 'perigo' });
      }
      if (detalhe?.id === id) disparar(abrirPeca(id, { focar: true }));
    }
    andando.current = { pedido: pedidoAndando, refazendo: new Map(carga.pecas.filter((p) => p.redoing).map((p) => [p.id, p.current.version])) };
    if (!pedidoAndando && !refazendo) return;
    const t = setTimeout(() => {
      if (marcaCarregada) disparar(ler(marcaCarregada, true));
    }, ESPERA_MS);
    return () => clearTimeout(t);
    // Só o que anda dispara a espera: as outras mudanças da tela não recomeçam a contagem.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pedidoAndando, refazendo, marcaCarregada, carga]);

  // O foco depois de uma ação vai para o que mudou.
  useEffect(() => {
    const alvo = focar.current;
    if (!alvo) return;
    const el = alvo === 'titulo' ? titulo.current : document.getElementById(alvo);
    if (!el) return;
    focar.current = null;
    el.focus({ preventScroll: alvo !== 'titulo' && alvo !== 'pc-titulo' });
  });

  if (!podeVer) {
    return (
      <Estado icone="lock" titulo="Esta tela é de quem acompanha as campanhas">
        O seu nível nesta empresa não mostra as peças de anúncio. Se precisar, peça ao dono da conta.
      </Estado>
    );
  }

  function tentarDeNovo() {
    focar.current = 'titulo';
    if (erroMarcas) disparar(carregarMarcas());
    else setTentativa((t) => t + 1);
  }

  const cabecalho = (acao: ReactNode = null, seletor: ReactNode = null) => (
    <div className="view-cab anima" style={{ ['--i' as string]: 0 }}>
      <div>
        <h1 id="h-criativos" ref={titulo} tabIndex={-1}>
          Criativos
        </h1>
        <p>{SUBTITULO}</p>
      </div>
      {(seletor || acao) && (
        <div className="res-filtros">
          {seletor}
          {acao}
        </div>
      )}
    </div>
  );

  if (erroMarcas || carga.tipo === 'erro') {
    const problema = erroMarcas ?? (carga.tipo === 'erro' ? carga.problema : null);
    return (
      <section aria-labelledby="h-criativos">
        {cabecalho()}
        <div className="card">
          <Estado
            icone="alert-circle"
            perigo
            titulo="Não foi possível carregar as peças"
            acao={
              <div className="vazio-acoes">
                <button className="btn btn--primary" type="button" onClick={tentarDeNovo}>
                  <Icone nome="refresh" />
                  Tentar de novo
                </button>
              </div>
            }
          >
            {problema?.code ? mensagemDe(problema) : 'Tente de novo em instantes.'} Nada foi perdido: as peças e as decisões continuam guardadas.
          </Estado>
        </div>
      </section>
    );
  }
  if (marcas && !marcas.length) {
    return (
      <section aria-labelledby="h-criativos">
        {cabecalho()}
        <div className="card">
          <Estado icone="info" titulo="Nenhuma marca ativa nesta empresa">
            As peças são feitas por marca: quando a empresa tiver uma marca ativa, elas aparecem aqui.
          </Estado>
        </div>
      </section>
    );
  }
  if (carga.tipo !== 'ok') {
    return (
      <section aria-labelledby="h-criativos" aria-busy="true">
        {cabecalho()}
        <p className="sr-only">Carregando as peças…</p>
        <div className="cri" aria-hidden="true">
          <div className="card">
            <span className="esqueleto esqueleto--curto" />
            <span className="esqueleto esqueleto--bloco" />
            <span className="esqueleto esqueleto--medio" />
          </div>
          <div className="card">
            <span className="esqueleto esqueleto--medio" />
            <span className="esqueleto" />
          </div>
        </div>
      </section>
    );
  }

  const { opcoes, pecas, pedidos } = carga;
  const brandId = carga.marca;
  const nomeDaMarca = marcas?.find((m) => m.id === brandId)?.name ?? 'sua marca';
  const reler = () => ler(brandId, true);
  const falhou = (problema: Problema) => avisar(mensagemDe(problema), { tipo: 'perigo' });

  /** A peça como o servidor devolveu depois de uma decisão: entra na lista e no detalhe aberto. */
  function guardar(p: AdPieceResponse) {
    setCarga((c) => (c.tipo === 'ok' ? { ...c, pecas: c.pecas.some((x) => x.id === p.id) ? c.pecas.map((x) => (x.id === p.id ? { ...x, ...p } : x)) : [p, ...c.pecas] } : c));
    setDetalhe((d) => (d?.id === p.id ? { id: p.id, estado: 'ok', peca: p } : d));
  }
  /** O servidor recusou: diz o porquê e, quando a peça mudou por baixo, lê de novo. */
  function recusa(problema: Problema, id: string): Problema {
    if (erroDaPeca(problema).recarregar) {
      disparar(reler());
      disparar(abrirPeca(id, { focar: false }));
    }
    return problema;
  }

  async function pedir(corpo: Omit<CreateAdPieceRequest, 'brand_id'>): Promise<Problema | null> {
    const r = await chamar(() => api.POST('/v1/ad-pieces/requests', { body: { ...corpo, brand_id: brandId } }));
    if (!r.ok) return r.problema;
    setPedindo(null);
    setDetalhe(null);
    focar.current = 'lote-t';
    await reler();
    avisar(`Pedido enviado. O Criativo faz ${corpo.variations === 1 ? '1 peça' : `${corpo.variations} peças`} e avisa quando ${corpo.variations === 1 ? 'estiver pronta' : 'estiverem prontas'}.`);
    setAnuncio('Pedido enviado. O Criativo está fazendo as peças.');
    return null;
  }

  async function aprovar(p: AdPieceResponse) {
    setOcupado(`aprovar:${p.id}`);
    const r = await chamar(() => api.POST('/v1/ad-pieces/{id}/approve', { params: { path: { id: p.id } }, body: { content_hash: p.current.content_hash } }));
    if (r.ok) {
      guardar(r.data);
      focar.current = 'pc-resultado';
      avisar('Aprovada. A peça está na biblioteca; nada foi para a Meta.');
      setAnuncio('Peça aprovada.');
    } else falhou(recusa(r.problema, p.id));
    setOcupado(null);
  }

  async function aprovarAsQuePassaram(lista: AdPieceResponse[]) {
    setOcupado('lote');
    const r = await chamar(() => api.POST('/v1/ad-pieces/approve', { body: { brand_id: brandId, items: lista.map((p) => ({ id: p.id, content_hash: p.current.content_hash })) } }));
    if (r.ok) {
      setConfirmandoLote(false);
      setFiltro('aprovadas');
      focar.current = 'bib-t';
      await reler();
      const ficaram = r.data.items.length - r.data.approved;
      avisar(
        `${r.data.approved === 1 ? '1 peça aprovada' : `${r.data.approved} peças aprovadas`}. ${r.data.approved === 1 ? 'Ela está' : 'Elas estão'} na biblioteca; nada foi para a Meta.${ficaram ? ` ${ficaram === 1 ? '1 não pôde ser aprovada' : `${ficaram} não puderam ser aprovadas`}: abra para ver o motivo.` : ''}`,
        { tipo: r.data.approved ? 'ok' : 'perigo' },
      );
    } else falhou(r.problema);
    setOcupado(null);
  }

  async function recusar(p: AdPieceResponse, motivo: 'texto_nao_serve' | 'nao_parece_a_marca' | 'nao_preciso_mais') {
    setOcupado(`recusar:${p.id}`);
    const r = await chamar(() => api.POST('/v1/ad-pieces/{id}/reject', { params: { path: { id: p.id } }, body: { content_hash: p.current.content_hash, reason: motivo } }));
    if (r.ok) {
      guardar(r.data);
      focar.current = 'pc-resultado';
      avisar('Recusada. O motivo fica guardado com a peça, e nada foi para a Meta.');
      setAnuncio('Peça recusada.');
    } else falhou(recusa(r.problema, p.id));
    setOcupado(null);
  }

  async function salvarEdicao(p: AdPieceResponse, texto: { title: string; body: string; button: 'pedir_agora' | 'ver_cardapio' | 'enviar_mensagem' }): Promise<Problema | null> {
    const r = await chamar(() => api.PUT('/v1/ad-pieces/{id}', { params: { path: { id: p.id } }, body: { base_version: p.current.version, ...texto } }));
    if (!r.ok) return recusa(r.problema, p.id);
    guardar(r.data);
    focar.current = 'pc-titulo';
    const aviso = avisoDaVersaoNova(r.data, true);
    avisar(aviso.texto, { tipo: aviso.tipo });
    return null;
  }

  async function pedirOutra(p: AdPieceResponse, instrucao: string): Promise<Problema | null> {
    const r = await chamar(() => api.POST('/v1/ad-pieces/{id}/redo', { params: { path: { id: p.id } }, body: { content_hash: p.current.content_hash, ...(instrucao ? { instruction: instrucao } : {}) } }));
    if (!r.ok) return recusa(r.problema, p.id);
    guardar(r.data);
    focar.current = 'pc-titulo';
    avisar(`Pedido enviado. O Criativo faz a versão ${p.current.version + 1}.`);
    setAnuncio(`O Criativo está fazendo a versão ${p.current.version + 1}.`);
    return null;
  }

  async function contestar(p: AdPieceResponse, comentario: string): Promise<Problema | null> {
    const r = await chamar(() => api.POST('/v1/ad-pieces/{id}/contest', { params: { path: { id: p.id } }, body: { content_hash: p.current.content_hash, comment: comentario } }));
    if (!r.ok) return recusa(r.problema, p.id);
    guardar(r.data);
    focar.current = 'pc-contestada';
    avisar('Motivo registrado. Ele fica guardado com esta conferência.');
    return null;
  }

  function abrirPedido(anuncioDeReferencia: string | null = null) {
    const motivo = motivoDeNaoPedir(opcoes);
    if (motivo) return avisar(motivo, { tipo: 'perigo' });
    setPedindo({ anuncio: anuncioDeReferencia });
  }

  const seletor =
    marcas && marcas.length > 1 ? (
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
    ) : null;
  const semNada = !pecas.length && !opcoes.in_progress;
  const botaoPedir = (rotulo: string) =>
    podeOperar ? (
      <button className="btn btn--primary" type="button" id="cri-bt-pedir" onClick={() => abrirPedido()} aria-haspopup="dialog" aria-disabled={opcoes.available ? undefined : 'true'} aria-describedby={opcoes.available ? undefined : 'cri-sem-pedir'}>
        <Icone nome="plus" />
        {rotulo}
      </button>
    ) : null;

  let corpo;
  if (detalhe) {
    const naLista = pecas.find((p) => p.id === detalhe.id) ?? null;
    corpo = (
      <PecaAberta
        detalhe={detalhe}
        naLista={naLista}
        irmas={naLista ? pecas.filter((p) => p.request_id === naLista.request_id && p.status === naLista.status).map((p) => p.id) : []}
        pedido={naLista ? (pedidos.find((r) => r.id === naLista.request_id) ?? null) : null}
        opcoes={opcoes}
        nomeDaMarca={nomeDaMarca}
        pro={modo === 'pro'}
        pode={podeOperar}
        agora={agora}
        ocupado={ocupado}
        aoVoltar={() => {
          focar.current = `cri-peca-${detalhe.id}`;
          setDetalhe(null);
        }}
        aoAbrir={(id) => disparar(abrirPeca(id))}
        aoTentarDeNovo={() => disparar(abrirPeca(detalhe.id))}
        aoAprovar={(p) => disparar(aprovar(p))}
        aoRecusar={(p, motivo) => disparar(recusar(p, motivo))}
        aoSalvar={salvarEdicao}
        aoPedirOutra={pedirOutra}
        aoContestar={contestar}
        aoAvisar={(texto, tipo = 'perigo') => avisar(texto, { tipo })}
      />
    );
  } else {
    corpo = (
      <CriativosLista
        opcoes={opcoes}
        pecas={pecas}
        pedidos={pedidos}
        pode={podeOperar}
        pro={modo === 'pro'}
        agora={agora}
        filtro={filtro}
        confirmandoLote={confirmandoLote}
        ocupado={ocupado}
        botaoDoVazio={botaoPedir('Pedir a primeira peça')}
        aoFiltrar={setFiltro}
        aoAbrir={(id) => disparar(abrirPeca(id))}
        aoPedir={abrirPedido}
        aoPedirLote={(pedir) => {
          setConfirmandoLote(pedir);
          focar.current = pedir ? 'lote-confirma-t' : 'cri-bt-lote';
        }}
        aoAprovarLote={(lista) => disparar(aprovarAsQuePassaram(lista))}
      />
    );
  }

  return (
    <section aria-labelledby="h-criativos">
      {cabecalho(detalhe || semNada ? null : botaoPedir('Pedir uma peça'), seletor)}
      {corpo}
      {pedindo && (
        <DialogoPedirPeca
          opcoes={opcoes}
          anuncioInicial={pedindo.anuncio}
          reserva={titulo}
          aoFechar={() => setPedindo(null)}
          aoPedir={pedir}
        />
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {anuncio}
      </p>
    </section>
  );
}
