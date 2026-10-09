'use client';

import type { ActionResponse, BrandResponse, BudgetMonthResponse, PlanContent, PlanResponse, PlanSummary } from '@liame/contracts';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { GavetaPedir } from '@/components/pedir/gaveta-pedir';
import { destinoInicial } from '@/components/shell/inicio';
import { useAvisar } from '@/components/ui/avisos';
import { Estado } from '@/components/ui/estado';
import { Icone } from '@/components/ui/icone';
import { useAgora } from '@/lib/agora';
import { api, chamar, mensagemDe, type Problema, type Resultado } from '@/lib/api';
import { useContadorAprovacoes } from '@/lib/contador-aprovacoes';
import { disparar } from '@/lib/disparar';
import { iniciais } from '@/lib/formato';
import { useModo } from '@/lib/modo';
import { useSessao } from '@/lib/sessao';
import { type AcaoDeAnuncio, anuncioApresentado, ehPedidoDeAnuncio, erroAoDesfazer, etiquetaDoAnuncio, mesDoPedido, quemPediu, textosDoAnuncio } from './anuncio-textos';
import type { Decisao } from './barra-da-decisao';
import { marcasAtivas, planosDasMarcas } from './buscar-planos';
import { DetalheAnuncio, type Volta } from './detalhe-anuncio';
import { DetalheMensagem, type Feito } from './detalhe-mensagem';
import { type AcaoDeMensagem, ehPedidoDeMensagem, etiquetaDaMensagem, mensagemApresentada } from './mensagem-textos';
import { DetalhePedido } from './detalhe-pedido';
import { DetalhePlano } from './detalhe-plano';
import { chaveDaAcao, chaveDoPlano, type ItemDaLista, montarLista, pendentesDe } from './lista';
import { dinheiroDoPlano, erroDoPlano, etiquetaDoPlano, type MotivoDaRecusa, riscoDoPlano } from './planos-textos';
import { apresentar, avisoDepoisDeAprovar, erroDaDecisao, etiquetaDoDecidido, type Grupo, grupoDe, pedidoDaUrl, prazoDe, riscoDe, ROTULO_GRUPO, ROTULO_RISCO } from './textos';

// "Aprovações" (mockups/prototipo-app.html, vista "aprovacoes"; os planos, mockups/prototipo-resumo.html, P8): à
// esquerda, o que espera alguém, o que a política fez sozinha e o que foi decidido hoje; à direita, o pedido aberto.
// Dois tipos de pedido na mesma fila: a ação que alguém pediu (`/v1/actions`; decidir exige `acoes.aprovar`) e o
// plano do Estrategista (`/v1/plans`, por marca; decidir exige `planos.decidir`). Aprovar pede o código do app
// autenticador e vale só para o que está na tela (o hash); recusar pede um motivo. O pedido de anúncio (mudar a verba,
// pausar e retomar na plataforma; mockups/prototipo-anuncios.html, P9) tem os textos e o detalhe dele: o porquê, o
// caminho da execução, desfazer (um pedido novo) e pedir de novo, pela mesma gaveta de Resultados.

type Carga =
  | { tipo: 'carregando' }
  | { tipo: 'ok'; acoes: ActionResponse[]; planos: PlanSummary[]; marcas: BrandResponse[]; planosFalharam: boolean }
  | { tipo: 'erro'; problema: Problema };
type PlanoAberto = { id: string; estado: 'carregando' } | { id: string; estado: 'ok'; dados: PlanResponse } | { id: string; estado: 'erro'; problema: Problema };

const GRUPOS: Grupo[] = ['pendente', 'auto', 'feito'];
/** A fila anda sozinha: outra pessoa pode decidir, o worker executa, o Estrategista manda a versão nova, o prazo vence. */
const ATUALIZAR_MS = 30_000;

export function AprovacoesTela() {
  const { me, pode } = useSessao();
  // O link do e-mail ("uma ação espera a sua aprovação"), a faixa da aba Cupons e o Resumo abrem a tela já no pedido.
  const parametros = useSearchParams();
  const acaoInicial = pedidoDaUrl(parametros.get('pedido'));
  const planoInicial = pedidoDaUrl(parametros.get('plano'));
  const inicial = acaoInicial ? chaveDaAcao(acaoInicial) : planoInicial ? chaveDoPlano(planoInicial) : null;
  const avisar = useAvisar();
  const { modo } = useModo();
  const pro = modo === 'pro';
  const definirContador = useContadorAprovacoes().definir;
  const podeVer = pode('campanhas.ver');
  const podeDecidir = pode('acoes.aprovar');
  const podeVerPlanos = pode('planos.ver') && pode('vendas.ver') && pode('marcas.ver');
  const podeDecidirPlanos = podeVerPlanos && pode('planos.decidir');
  const podeConferirTexto = pode('dossie.ver');
  const temApp = me.mfa !== 'not_configured';
  const tituloDoDetalhe = useRef<HTMLHeadingElement>(null);
  // O foco no título depois de decidir: pedido pelo estado, para ser atendido com o pedido novo já na tela (por
  // requestAnimationFrame, o quadro podia chegar antes da troca: o título antigo recebia o foco e sumia).
  const [focoNoTitulo, setFocoNoTitulo] = useState(0);
  useEffect(() => {
    if (focoNoTitulo) tituloDoDetalhe.current?.focus({ preventScroll: true });
  }, [focoNoTitulo]);
  const campoCodigo = useRef<HTMLInputElement>(null);
  const lista = useRef<HTMLDivElement>(null);
  const [carga, setCarga] = useState<Carga>({ tipo: 'carregando' });
  /** O pedido do endereço (`/aprovacoes?pedido={id}`) que não veio na lista dos mais recentes. */
  const [avulso, setAvulso] = useState<ActionResponse | null>(null);
  const [sel, setSel] = useState<string | null>(inicial);
  /** No celular a tela é uma coluna só: a lista, ou o pedido aberto. */
  const [noDetalhe, setNoDetalhe] = useState(Boolean(inicial));
  const [tentativa, setTentativa] = useState(0);
  /** O plano aberto, lido por inteiro (a lista só traz o resumo de cada um). */
  const [planoAberto, setPlanoAberto] = useState<PlanoAberto | null>(null);
  const [relerPlano, setRelerPlano] = useState(0);
  /** A verba do mês: diz quanto um pedido de anúncio pesa até o fim do mês e os limites que ele passou. */
  const [verba, setVerba] = useState<BudgetMonthResponse | null>(null);
  /** O pedido de anúncio cuja gaveta "Pedir uma mudança" está aberta (pedir de novo). */
  const [pedindo, setPedindo] = useState<AcaoDeAnuncio | null>(null);
  const agora = useAgora(60_000, carga);
  const seq = useRef(0);

  const carregar = useCallback(async () => {
    const id = ++seq.current;
    const lerPlanos = async (): Promise<Resultado<{ marcas: BrandResponse[]; planos: PlanSummary[] }>> => {
      const marcas = await marcasAtivas();
      if (!marcas.ok) return marcas;
      const planos = await planosDasMarcas(marcas.data);
      return planos.ok ? { ok: true, data: { marcas: marcas.data, planos: planos.data } } : planos;
    };
    const [acoes, planos] = await Promise.all([chamar(() => api.GET('/v1/actions')), podeVerPlanos ? lerPlanos() : null]);
    if (id !== seq.current) return;
    if (!acoes.ok) return setCarga((c) => (c.tipo === 'ok' ? c : { tipo: 'erro', problema: acoes.problema }));
    // Os planos que não vieram agora não derrubam a tela: ficam os da leitura anterior, com o aviso.
    setCarga((c) => {
      const anterior = c.tipo === 'ok' ? c : null;
      return {
        tipo: 'ok',
        acoes: acoes.data.items,
        planos: planos?.ok ? planos.data.planos : (anterior?.planos ?? []),
        marcas: planos?.ok ? planos.data.marcas : (anterior?.marcas ?? []),
        planosFalharam: Boolean(planos && !planos.ok),
      };
    });
    // O número do menu só muda com a leitura inteira (sem os planos, ficaria menor do que é).
    if (!planos || planos.ok) definirContador(pendentesDe(montarLista(acoes.data.items, planos?.ok ? planos.data.planos : [], new Date()), podeDecidir, podeDecidirPlanos));
    if (acaoInicial && !acoes.data.items.some((a) => a.id === acaoInicial)) {
      const um = await chamar(() => api.GET('/v1/actions/{id}', { params: { path: { id: acaoInicial } } }));
      if (id === seq.current) setAvulso(um.ok ? um.data : null);
    }
    // `definirContador` é estável (o `setState` do provedor); os iniciais vêm da rota.
  }, [acaoInicial, definirContador, podeVerPlanos, podeDecidir, podeDecidirPlanos]);

  useEffect(() => {
    if (!podeVer) return;
    disparar(carregar());
    const t = setInterval(() => disparar(carregar()), ATUALIZAR_MS);
    return () => clearInterval(t);
  }, [podeVer, carregar, tentativa]);

  const acoes = carga.tipo === 'ok' ? carga.acoes : [];
  // Com um pedido de anúncio na fila, a tela lê a verba do mês uma vez (sem ela, os textos saem sem a conta do mês).
  const temAnuncio = acoes.some(ehPedidoDeAnuncio) || Boolean(avulso && ehPedidoDeAnuncio(avulso));
  useEffect(() => {
    if (!temAnuncio) return;
    let vivo = true;
    disparar(
      chamar(() => api.GET('/v1/budget/month')).then((r) => {
        if (vivo && r.ok) setVerba(r.data);
      }),
    );
    return () => {
      vivo = false;
    };
  }, [temAnuncio, tentativa]);
  const mes = mesDoPedido(verba);
  /** O pedido em palavras, para a lista e os avisos: o de anúncio e o de mensagem têm os textos deles. */
  const emPalavras = (a: ActionResponse) => (ehPedidoDeAnuncio(a) ? anuncioApresentado(a, mes) : ehPedidoDeMensagem(a) ? mensagemApresentada(a) : apresentar(a));
  const planos = carga.tipo === 'ok' ? carga.planos : [];
  const marcas = carga.tipo === 'ok' ? carga.marcas : [];
  const grupos = montarLista(acoes, planos, agora);
  const ordem = GRUPOS.flatMap((g) => grupos[g]);
  // O que veio pelo endereço e não está na lista (decidido em outro dia): a ação avulsa ou o plano já lido por inteiro.
  const planoDoEndereco = planoInicial && planoAberto?.id === planoInicial && planoAberto.estado === 'ok' ? planoAberto.dados.plan : null;
  const foraDaLista: ItemDaLista | null =
    avulso && chaveDaAcao(avulso.id) === sel
      ? { chave: chaveDaAcao(avulso.id), tipo: 'acao', grupo: grupoDe(avulso, agora) ?? 'feito', acao: avulso, expira: avulso.expires_at, mexido: avulso.updated_at }
      : planoDoEndereco && chaveDoPlano(planoDoEndereco.id) === sel
        ? { chave: chaveDoPlano(planoDoEndereco.id), tipo: 'plano', grupo: 'feito', plano: planoDoEndereco, expira: planoDoEndereco.expires_at, mexido: planoDoEndereco.updated_at }
        : null;
  // O plano do endereço que não está na lista é lido antes de aparecer: enquanto isso, a fila não abre outro pedido no lugar dele.
  const planoForaDaLista = carga.tipo === 'ok' && planoInicial && sel === chaveDoPlano(planoInicial) && !ordem.some((i) => i.chave === sel) ? planoInicial : null;
  const aberta = ordem.find((i) => i.chave === sel) ?? foraDaLista ?? (planoForaDaLista ? null : grupos.pendente[0]) ?? null;

  // O plano aberto é lido por inteiro; de novo quando a lista mostra outra versão ou outra situação dele.
  const idDoPlano = planoForaDaLista ?? (aberta?.tipo === 'plano' ? aberta.plano.id : null);
  const marcaDoPlano = aberta?.tipo === 'plano' ? `${aberta.plano.content_hash}:${aberta.plano.status}` : '';
  useEffect(() => {
    if (!idDoPlano) return;
    let vivo = true;
    setPlanoAberto((d) => (d?.id === idDoPlano && d.estado === 'ok' ? d : { id: idDoPlano, estado: 'carregando' }));
    disparar(
      chamar(() => api.GET('/v1/plans/{id}', { params: { path: { id: idDoPlano } } })).then((r) => {
        if (vivo) setPlanoAberto(r.ok ? { id: idDoPlano, estado: 'ok', dados: r.data } : { id: idDoPlano, estado: 'erro', problema: r.problema });
      }),
    );
    return () => {
      vivo = false;
    };
  }, [idDoPlano, marcaDoPlano, relerPlano]);

  const abrir = useCallback((chave: string, focar: boolean) => {
    setSel(chave);
    setNoDetalhe(true);
    if (focar) requestAnimationFrame(() => tituloDoDetalhe.current?.focus({ preventScroll: true }));
  }, []);

  // Teclado (protótipo): J e K andam pela lista, A leva ao código do app. Fora de campo de texto e de diálogo.
  useEffect(() => {
    function tecla(e: KeyboardEvent) {
      const alvo = e.target instanceof HTMLElement ? e.target : null;
      if (e.metaKey || e.ctrlKey || e.altKey || alvo?.closest('input, textarea, select, dialog, [contenteditable]')) return;
      const k = e.key.toLowerCase();
      if (k === 'j' || k === 'k') {
        const i = ordem.findIndex((x) => x.chave === aberta?.chave);
        const novo = ordem[Math.max(0, Math.min(ordem.length - 1, i + (k === 'j' ? 1 : -1)))];
        if (!novo || novo.chave === aberta?.chave) return;
        e.preventDefault();
        setSel(novo.chave);
        requestAnimationFrame(() => lista.current?.querySelector<HTMLElement>('.ap-item[aria-current="true"]')?.focus());
      } else if (k === 'a' && campoCodigo.current) {
        e.preventDefault();
        campoCodigo.current.focus();
      }
    }
    document.addEventListener('keydown', tecla);
    return () => document.removeEventListener('keydown', tecla);
  });

  if (!podeVer) {
    return (
      <Estado icone="lock" titulo="Esta tela é de quem acompanha as campanhas">
        O seu nível nesta empresa não mostra os pedidos de aprovação. Se precisar, peça ao dono da conta.
      </Estado>
    );
  }

  const focarOTitulo = () => setFocoNoTitulo((n) => n + 1);

  /** Depois de decidir: a lista volta a ler, a fila anda para o próximo pedido e o foco vai para o título dele. */
  async function depoisDeDecidir(chaveDecidida: string, opcoes: { fica?: boolean } = {}) {
    const proximo = opcoes.fica ? null : grupos.pendente.find((i) => i.chave !== chaveDecidida);
    setSel(proximo?.chave ?? chaveDecidida);
    await carregar();
    focarOTitulo();
  }

  function recusaDoServidor(problema: Problema): Decisao {
    const erro = erroDaDecisao(problema);
    if (erro.recarregar) setTentativa((n) => n + 1);
    return { ok: false, texto: problema.errors?.length ? mensagemDe(problema) : erro.texto, noCodigo: erro.noCodigo };
  }

  async function aprovar(acao: ActionResponse, codigo: string): Promise<Decisao> {
    const r = await chamar(() => api.POST('/v1/actions/{id}/approve', { params: { path: { id: acao.id } }, body: { plan_hash: acao.plan_hash, code: codigo } }));
    if (!r.ok) return recusaDoServidor(r.problema);
    avisar(avisoDepoisDeAprovar(emPalavras(acao), r.data));
    await depoisDeDecidir(chaveDaAcao(acao.id));
    return { ok: true };
  }

  async function recusar(acao: ActionResponse, motivo: string): Promise<Decisao> {
    const r = await chamar(() => api.POST('/v1/actions/{id}/reject', { params: { path: { id: acao.id } }, body: { plan_hash: acao.plan_hash, reason: motivo } }));
    if (!r.ok) return recusaDoServidor(r.problema);
    avisar('Recusado. Quem pediu vê o motivo, e nada foi executado.');
    await depoisDeDecidir(chaveDaAcao(acao.id));
    return { ok: true };
  }

  // Desfazer um pedido de anúncio executado: nasce um pedido novo (a volta), que também espera a aprovação. A tela abre nele.
  async function desfazer(acao: AcaoDeAnuncio): Promise<Volta> {
    const r = await chamar(() => api.POST('/v1/actions/{id}/undo', { params: { path: { id: acao.id } } }));
    if (!r.ok) return { ok: false, ...erroAoDesfazer(r.problema, acao) };
    avisar('Pedido de volta criado. Ele espera a aprovação com o código do app.');
    // A volta só entra na lista com a leitura: a tela a escolhe depois de ler, sem abrir outro pedido da fila no meio.
    await carregar();
    setSel(chaveDaAcao(r.data.id));
    focarOTitulo();
    return { ok: true };
  }

  // ---- o pedido de mensagem (P15): conferir de novo o plano que mudou sozinho, e pausar o envio, que é direto.
  async function conferirMensagem(acao: AcaoDeMensagem): Promise<Feito> {
    const r = await chamar(() => api.POST('/v1/actions/{id}/recheck', { params: { path: { id: acao.id } } }));
    if (!r.ok) return { ok: false, texto: mensagemDe(r.problema) };
    if (r.data.plan_hash !== acao.plan_hash) avisar(r.data.blocked_reason ? 'O plano mudou no RegemCast, e ainda há um impedimento.' : 'Conferido: o plano de agora já pode ser aprovado.');
    await carregar();
    if (r.data.plan_hash !== acao.plan_hash) focarOTitulo();
    return { ok: true };
  }

  async function pausarMensagem(acao: AcaoDeMensagem): Promise<Feito> {
    const r = await chamar(() => api.POST('/v1/actions/{id}/undo', { params: { path: { id: acao.id } } }));
    if (!r.ok) return { ok: false, texto: mensagemDe(r.problema) };
    avisar(r.data.status === 'aguardando_aprovacao' ? 'Pausa pedida. Nesta empresa ela espera a aprovação de uma pessoa.' : 'Pausa pedida. O que já saiu não volta.');
    await carregar();
    focarOTitulo();
    return { ok: true };
  }

  // ---- os planos do Estrategista: a resposta de cada decisão já é o plano como ficou.
  function recusaDoPlano(problema: Problema): Decisao {
    const erro = erroDoPlano(problema);
    if (erro.recarregar) {
      setTentativa((n) => n + 1);
      setRelerPlano((n) => n + 1);
    }
    return { ok: false, texto: problema.errors?.length ? mensagemDe(problema) : erro.texto, noCodigo: erro.noCodigo };
  }

  async function aprovarPlano(plano: PlanSummary, codigo: string): Promise<Decisao> {
    const r = await chamar(() => api.POST('/v1/plans/{id}/approve', { params: { path: { id: plano.id } }, body: { plan_hash: plano.content_hash, code: codigo } }));
    if (!r.ok) return recusaDoPlano(r.problema);
    setPlanoAberto({ id: plano.id, estado: 'ok', dados: r.data });
    avisar(`Aprovado (versão ${r.data.plan.version}). Nada foi publicado: o que fazer está no plano.`);
    // No plano aprovado, o detalhe fica nele: é ali que está o que fazer.
    await depoisDeDecidir(chaveDoPlano(plano.id), { fica: true });
    return { ok: true };
  }

  async function recusarPlano(plano: PlanSummary, motivo: MotivoDaRecusa): Promise<Decisao> {
    const r = await chamar(() => api.POST('/v1/plans/{id}/reject', { params: { path: { id: plano.id } }, body: { plan_hash: plano.content_hash, reasons: [motivo] } }));
    if (!r.ok) return recusaDoPlano(r.problema);
    setPlanoAberto({ id: plano.id, estado: 'ok', dados: r.data });
    avisar('Recusado. O Estrategista vê o motivo, e nada foi executado.');
    await depoisDeDecidir(chaveDoPlano(plano.id));
    return { ok: true };
  }

  async function pedirNovaAnalise(plano: PlanSummary, pedido: string): Promise<Decisao> {
    const r = await chamar(() => api.POST('/v1/plans/{id}/reanalyze', { params: { path: { id: plano.id } }, body: { plan_hash: plano.content_hash, request: pedido } }));
    if (!r.ok) return recusaDoPlano(r.problema);
    setPlanoAberto({ id: plano.id, estado: 'ok', dados: r.data });
    avisar('Pedido enviado. O Estrategista refaz o plano e manda a versão nova para cá.');
    await depoisDeDecidir(chaveDoPlano(plano.id));
    return { ok: true };
  }

  async function editarPlano(plano: PlanSummary, novo: PlanContent): Promise<Decisao> {
    const r = await chamar(() => api.PUT('/v1/plans/{id}', { params: { path: { id: plano.id } }, body: { base_version: plano.version, content: novo } }));
    if (!r.ok) return recusaDoPlano(r.problema);
    setPlanoAberto({ id: plano.id, estado: 'ok', dados: r.data });
    avisar(`Versão ${r.data.plan.version} salva. A aprovação passa a valer só para ela.`);
    setSel(chaveDoPlano(plano.id));
    await carregar();
    // A versão nova espera a decisão: o foco vai para o código do app (ou para o título, sem o app).
    requestAnimationFrame(() => (campoCodigo.current ?? tituloDoDetalhe.current)?.focus({ preventScroll: true }));
    return { ok: true };
  }

  const nomeDaMarca = (id: string) => (marcas.length > 1 ? (marcas.find((m) => m.id === id)?.name ?? null) : null);

  const item = (i: ItemDaLista) => {
    const atual = i.chave === aberta?.chave ? 'true' : undefined;
    if (i.tipo === 'plano') {
      const risco = riscoDoPlano(i.plano.risk);
      const marca = nomeDaMarca(i.plano.brand_id);
      return (
        <li key={i.chave}>
          <button className="ap-item" type="button" aria-current={atual} onClick={() => abrir(i.chave, true)}>
            <span className="ap-av ap-av--func" aria-hidden="true">
              <Icone nome="compass" />
            </span>
            <span>
              <span className="ap-titulo">{i.plano.title}</span>
              <span className="ap-meta">
                {i.grupo === 'pendente' ? (
                  <>
                    <span className="dinheiro">{dinheiroDoPlano(i.plano.money_micros)}</span>
                    <span className={`risco risco--${risco}`}>{ROTULO_RISCO[risco]}</span>
                    <span>{prazoDe(i.plano, agora)}</span>
                  </>
                ) : (
                  <>
                    <span>Estrategista</span>
                    <span>{etiquetaDoPlano(i.plano.status)}</span>
                  </>
                )}
                {marca && <span>{marca}</span>}
              </span>
            </span>
          </button>
        </li>
      );
    }
    const a = i.acao;
    const p = emPalavras(a);
    // No pedido de anúncio, o risco segue a direção do dinheiro, e quem pediu pode ser um funcionário de IA.
    const anuncio = ehPedidoDeAnuncio(a) ? a : null;
    const mensagem = ehPedidoDeMensagem(a) ? a : null;
    const risco = anuncio ? textosDoAnuncio(anuncio, mes).risco : riscoDe(a);
    const quem = quemPediu(a);
    return (
      <li key={i.chave}>
        <button className="ap-item" type="button" aria-current={atual} onClick={() => abrir(i.chave, true)}>
          <span className={quem.funcionario ? 'ap-av ap-av--func' : 'ap-av'} aria-hidden="true">
            {quem.funcionario ? <Icone nome="megaphone" /> : iniciais(a.requested_by.name)}
          </span>
          <span>
            <span className="ap-titulo">{p.titulo}</span>
            <span className="ap-meta">
              {i.grupo === 'pendente' ? (
                <>
                  {p.impacto && <span className="dinheiro">{p.impacto}</span>}
                  <span className={`risco risco--${risco}`}>{ROTULO_RISCO[risco]}</span>
                  <span>{prazoDe(a, agora)}</span>
                </>
              ) : (
                <>
                  <span>{quem.nome}</span>
                  <span>{anuncio ? etiquetaDoAnuncio(anuncio) : mensagem ? etiquetaDaMensagem(mensagem) : etiquetaDoDecidido(a)}</span>
                </>
              )}
            </span>
          </span>
        </button>
      </li>
    );
  };

  const voltarParaALista = () => {
    setNoDetalhe(false);
    // O foco volta ao pedido que estava aberto (ou ao primeiro da lista).
    requestAnimationFrame(() => (lista.current?.querySelector<HTMLElement>('.ap-item[aria-current="true"]') ?? lista.current?.querySelector<HTMLElement>('.ap-item'))?.focus());
  };
  const botaoVoltar = (
    <button className="btn btn--ghost btn--sm voltar" type="button" onClick={voltarParaALista}>
      <Icone nome="chevron-left" />
      Voltar para a lista
    </button>
  );
  const inicio = destinoInicial(modo, pode, true);
  const nomeDoInicio = inicio === '/resumo' ? 'o Resumo' : inicio === '/atencao' ? 'Atenção' : null;
  const decide = podeDecidir || podeDecidirPlanos;

  let detalhe;
  if (aberta?.tipo === 'acao' && ehPedidoDeAnuncio(aberta.acao)) {
    const anuncio = aberta.acao;
    detalhe = (
      <DetalheAnuncio
        acao={anuncio}
        grupo={grupoDe(anuncio, agora)}
        agora={agora}
        pro={pro}
        podeDecidir={podeDecidir}
        podeOperar={pode('campanhas.operar')}
        temApp={temApp}
        mes={mes}
        pedindo={pedindo?.id === anuncio.id}
        titulo={tituloDoDetalhe}
        campoCodigo={campoCodigo}
        aoVoltar={voltarParaALista}
        aoAprovar={aprovar}
        aoRecusar={recusar}
        aoDesfazer={desfazer}
        aoPedirDeNovo={setPedindo}
        aoAbrir={(id) => abrir(chaveDaAcao(id), true)}
      />
    );
  } else if (aberta?.tipo === 'acao' && ehPedidoDeMensagem(aberta.acao)) {
    const mensagem = aberta.acao;
    // Quem pausou este envio: o pedido de pausa que a lista traz (a volta dele).
    const daPausa = mensagem.undone_by ? acoes.find((x) => x.id === mensagem.undone_by?.id) : undefined;
    detalhe = (
      <DetalheMensagem
        acao={mensagem}
        grupo={grupoDe(mensagem, agora)}
        agora={agora}
        pro={pro}
        podeDecidir={podeDecidir}
        podeOperar={pode('campanhas.operar')}
        temApp={temApp}
        pausa={daPausa && daPausa.status === 'executada' ? { quem: daPausa.requested_by.name, quando: daPausa.updated_at } : null}
        titulo={tituloDoDetalhe}
        campoCodigo={campoCodigo}
        aoVoltar={voltarParaALista}
        aoAprovar={aprovar}
        aoRecusar={recusar}
        aoConferir={conferirMensagem}
        aoPausar={pausarMensagem}
      />
    );
  } else if (aberta?.tipo === 'acao') {
    detalhe = (
      <DetalhePedido
        acao={aberta.acao}
        grupo={grupoDe(aberta.acao, agora)}
        agora={agora}
        pro={pro}
        podeDecidir={podeDecidir}
        temApp={temApp}
        titulo={tituloDoDetalhe}
        campoCodigo={campoCodigo}
        aoVoltar={voltarParaALista}
        aoAprovar={aprovar}
        aoRecusar={recusar}
      />
    );
  } else if (idDoPlano) {
    const plano = aberta?.tipo === 'plano' ? aberta.plano : null;
    const lido = planoAberto?.id === idDoPlano ? planoAberto : null;
    if (lido?.estado === 'ok') {
      const resumo = lido.dados.plan;
      detalhe = (
        <DetalhePlano
          key={`${resumo.id}:${resumo.content_hash}:${resumo.status}`}
          r={lido.dados}
          agora={agora}
          pro={pro}
          euId={me.user.id}
          podeDecidir={podeDecidirPlanos}
          temApp={temApp}
          podeConferirTexto={podeConferirTexto}
          titulo={tituloDoDetalhe}
          campoCodigo={campoCodigo}
          aoVoltar={voltarParaALista}
          aoAprovar={(codigo) => aprovarPlano(resumo, codigo)}
          aoRecusar={(motivo) => recusarPlano(resumo, motivo)}
          aoEditar={(novo) => editarPlano(resumo, novo)}
          aoPedirNovaAnalise={(pedido) => pedirNovaAnalise(resumo, pedido)}
          aoAvisar={avisar}
        />
      );
    } else {
      detalhe = (
        <>
          {botaoVoltar}
          <div className="det-cab">
            <span>
              <b>Estrategista</b> propôs
            </span>
          </div>
          <h2 className="det-titulo" id="ap-det-titulo" ref={tituloDoDetalhe} tabIndex={-1}>
            {plano?.title ?? 'Plano do Estrategista'}
          </h2>
          {lido?.estado === 'erro' ? (
            <div className="plano-espera" role="alert">
              <p className="nota">
                <Icone nome="alert-circle" />
                <span>Não foi possível abrir o plano. {mensagemDe(lido.problema)}</span>
              </p>
              <div className="vazio-acoes">
                <button className="btn btn--sm" type="button" onClick={() => setRelerPlano((n) => n + 1)}>
                  <Icone nome="refresh" pequeno />
                  Tentar de novo
                </button>
              </div>
            </div>
          ) : (
            <div className="plano-espera" aria-busy="true">
              <p className="sr-only">Abrindo o plano…</p>
              <span className="esqueleto esqueleto--curto" aria-hidden="true" />
              <span className="esqueleto" aria-hidden="true" />
              <span className="esqueleto esqueleto--medio" aria-hidden="true" />
            </div>
          )}
        </>
      );
    }
  } else {
    detalhe = (
      <>
        <button className="btn btn--ghost btn--sm voltar" type="button" onClick={() => setNoDetalhe(false)}>
          <Icone nome="chevron-left" />
          Voltar para a lista
        </button>
        <div className="vazio">
          <span className="vazio-ic vazio-ic--ok" aria-hidden="true">
            <Icone nome="check" />
          </span>
          <h2 id="ap-det-titulo" ref={tituloDoDetalhe} tabIndex={-1}>
            Tudo em dia
          </h2>
          <p>{decide ? 'Nada espera o seu ok agora. Quando alguém pedir uma ação que precisa de aprovação, ou o Estrategista mandar um plano, aparece aqui.' : 'Nenhum pedido espera aprovação agora.'}</p>
          {nomeDoInicio && (
            <div className="vazio-acoes">
              <Link className="btn" href={inicio}>
                Voltar para {nomeDoInicio}
              </Link>
            </div>
          )}
        </div>
      </>
    );
  }

  return (
    <section aria-labelledby="h-aprov">
      <div className="view-cab anima" style={{ ['--i' as string]: 0 }}>
        <div>
          <h1 id="h-aprov">Aprovações</h1>
          <p>O que a equipe quer fazer e precisa do seu ok. Nada vai ao ar sem aprovação ou fora dos limites que você definiu.</p>
        </div>
        <p className="dica-teclas" aria-hidden="true">
          <kbd className="kbd">J</kbd>
          <kbd className="kbd">K</kbd> navegar · <kbd className="kbd">A</kbd> aprovar
        </p>
      </div>

      {carga.tipo === 'erro' ? (
        <div className="card">
          <Estado
            icone="alert-circle"
            perigo
            titulo="Não foi possível carregar os pedidos"
            acao={
              <div className="vazio-acoes">
                <button className="btn btn--primary" type="button" onClick={() => setTentativa((n) => n + 1)}>
                  <Icone nome="refresh" />
                  Tentar de novo
                </button>
              </div>
            }
          >
            {mensagemDe(carga.problema)} Nada é executado enquanto ninguém aprova.
          </Estado>
        </div>
      ) : carga.tipo === 'carregando' ? (
        <div className="inbox" aria-hidden="true">
          <div className="card inbox-lista res-esqueleto">
            <span className="esqueleto esqueleto--curto" />
            <span className="esqueleto" />
            <span className="esqueleto" />
          </div>
          <div className="card inbox-det res-esqueleto">
            <span className="esqueleto esqueleto--curto" />
            <span className="esqueleto" />
            <span className="esqueleto" />
          </div>
        </div>
      ) : (
        <div className={`inbox anima${noDetalhe ? ' mostra-detalhe' : ''}`} style={{ ['--i' as string]: 1 }}>
          <div className="card inbox-lista" ref={lista} role="region" aria-label="Pedidos">
            {GRUPOS.map((g) => {
              const doGrupo = grupos[g];
              if (!doGrupo.length && g !== 'pendente') return null;
              return (
                <div className="ap-grupo" key={g}>
                  <p className="ap-grupo-rot rotulo-marca">
                    <span>{g === 'pendente' && !decide ? 'Esperando aprovação' : ROTULO_GRUPO[g]}</span>
                    <span>{doGrupo.length}</span>
                  </p>
                  {doGrupo.length ? <ul>{doGrupo.map(item)}</ul> : <p className="ap-vazio-mini">{decide ? 'Nada esperando você agora.' : 'Nenhum pedido esperando aprovação.'}</p>}
                </div>
              );
            })}
            {carga.planosFalharam && (
              <p className="ap-vazio-mini" role="status">
                Os planos do Estrategista não carregaram agora. A tela tenta de novo sozinha.
              </p>
            )}
          </div>
          <article className="card inbox-det" aria-labelledby="ap-det-titulo">
            {detalhe}
          </article>
        </div>
      )}

      {pedindo?.target.campaign && (
        <GavetaPedir
          key={pedindo.id}
          campanha={{ id: pedindo.target.campaign.id, nome: pedindo.target.campaign.name, provider: pedindo.provider }}
          inicial={pedindo.target.kind === 'campanha' ? {} : { alvo: pedindo.resource_id }}
          podeDefinirLimites={pode('orcamento.gerenciar')}
          podeVerContas={pode('contas.ver')}
          reserva={tituloDoDetalhe}
          voltarPara={() => document.querySelector<HTMLElement>('[data-pedir-de-novo]')}
          aoFechar={() => setPedindo(null)}
          aoCriar={() => disparar(carregar())}
        />
      )}
    </section>
  );
}
