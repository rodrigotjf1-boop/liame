'use client';

import type { BrandResponse, ConversationListResponse, ConversationMessage, ConversationStep, ConversationSummary } from '@liame/contracts';
import { type FormEvent, type KeyboardEvent as TeclaDoReact, useCallback, useEffect, useRef, useState } from 'react';
import { IconeLia } from '@/components/marca/logo';
import { useAvisar } from '@/components/ui/avisos';
import { Icone } from '@/components/ui/icone';
import { useAgora } from '@/lib/agora';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import { useContadorAprovacoes } from '@/lib/contador-aprovacoes';
import { disparar } from '@/lib/disparar';
import { quandoComHora } from '@/lib/formato';
import { useModo } from '@/lib/modo';
import { useSessao } from '@/lib/sessao';
import { uuidv7 } from '@/lib/uuid';
import { ContatoDoAtendimento } from './cartoes';
import { ID_DO_PAINEL, useConversa } from './contexto';
import { mandarMensagem } from './fluxo';
import { type Item, MensagemDaLia, MensagemDaPessoa, MensagemDoSistema } from './mensagem';
import { contaDaMensagem, diaDaMensagem, faixaDa, MENSAGEM_MAXIMA, notaDeDadoPessoal, saudacaoDa, SUGESTOES } from './textos';

// O painel da Conversa com a LIA (mockups/prototipo-conversa.html, P5 aprovado em 03/10/2026): ao lado da tela a
// partir de 1280 px, por cima dela nas menores (com o resto inerte) e em tela cheia no celular. Fica montado
// enquanto a pessoa navega: a resposta continua chegando com o painel fechado, e o botão do topo marca a novidade.
// A conversa é de quem a abriu (só ela vê as dela) e fica 30 dias. A LIA lê pelos mesmos serviços das telas, com a
// permissão de quem pergunta; a resposta só aparece depois de conferida pelo código.

type Lista = { tipo: 'vazia' } | { tipo: 'carregando' } | { tipo: 'ok'; dados: ConversationListResponse } | { tipo: 'erro'; problema: Problema };

const AVISO_VAZIO = { retry_at: null, budget_window: null, stale_sources: [], contact: null };

/** A mensagem guardada, do jeito que a lista mostra. */
function itemDa(m: ConversationMessage): Item {
  if (m.role === 'pessoa') return { de: 'eu', id: m.id, em: m.created_at, texto: m.text ?? '', nota: notaDeDadoPessoal(m.removed_personal_data) };
  if (m.role === 'lia') return { de: 'lia', id: m.id, em: m.created_at, fase: m.status === 'parada' ? 'parada' : 'pronta', m };
  return { de: 'sistema', id: m.id, em: m.created_at, m };
}

/** A resposta que a pessoa parou antes de chegar: fica marcada na tela (o servidor guarda a dele do mesmo jeito). */
function paradaLocal(id: string, em: string): Item {
  const m: ConversationMessage = {
    id,
    role: 'lia',
    created_at: em,
    status: 'parada',
    text: null,
    removed_personal_data: null,
    blocks: [],
    numbers: [],
    read: [],
    cards: [],
    economy: false,
    usage_id: null,
    notice: null,
    contact: null,
    retry_at: null,
    budget_window: null,
    stale_sources: [],
  };
  return { de: 'lia', id, em, fase: 'parada', m };
}

function toque(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
}

export function PainelDaLia({ modal }: { modal: boolean }) {
  const { me, pode } = useSessao();
  const conversa = useConversa();
  const { modo } = useModo();
  const avisar = useAvisar();
  const aprovacoes = useContadorAprovacoes();
  const [marcas, setMarcas] = useState<BrandResponse[] | null>(null);
  const [marca, setMarca] = useState<string | null>(null);
  const [lista, setLista] = useState<Lista>({ tipo: 'vazia' });
  const [vista, setVista] = useState<'conversa' | 'historico'>('conversa');
  const [atual, setAtual] = useState<ConversationSummary | null>(null);
  const [itens, setItens] = useState<Item[]>([]);
  const [abrindo, setAbrindo] = useState(false);
  const [ocupada, setOcupada] = useState(false);
  const [texto, setTexto] = useState('');
  const [cancelando, setCancelando] = useState<string | null>(null);
  const [contatoAberto, setContatoAberto] = useState(false);
  const [anuncio, setAnuncio] = useState('');
  const mensagens = useRef<HTMLOListElement>(null);
  const campo = useRef<HTMLTextAreaElement>(null);
  const titulo = useRef<HTMLHeadingElement>(null);
  const tituloDoHistorico = useRef<HTMLHeadingElement>(null);
  const botaoDoHistorico = useRef<HTMLButtonElement>(null);
  const parar = useRef<AbortController | null>(null);
  const aberta = useRef(conversa.aberta);
  const rolarAte = useRef<string | null>(null);
  /** Para onde o foco vai depois que a conversa (ou a lista) termina de ser desenhada. */
  const focoPendente = useRef<'conversa' | 'historico' | null>(null);
  const ultimaPergunta = useRef('');
  const seq = useRef(0);
  const agora = useAgora(60_000, itens.length);
  aberta.current = conversa.aberta;

  const nomeDaMarca = marcas?.find((m) => m.id === marca)?.name ?? 'sua marca';
  const dados = lista.tipo === 'ok' ? lista.dados : null;
  const desligada = dados !== null && !dados.lia;
  const mensagensDoServidor = itens.flatMap((i) => (i.de === 'lia' && (i.fase === 'pronta' || i.fase === 'parada') ? [i.m] : i.de === 'sistema' && 'id' in i.m ? [i.m as ConversationMessage] : []));
  const faixa = faixaDa(atual, mensagensDoServidor, agora);
  const bloqueada = Boolean(faixa?.bloqueia);
  const comecou = itens.some((i) => i.de === 'eu');

  const novaConversa = useCallback(
    (marcaAtual: BrandResponse | undefined) => {
      parar.current?.abort();
      setAtual(null);
      setVista('conversa');
      setContatoAberto(false);
      setTexto('');
      setItens([{ de: 'lia', id: `saudacao-${++seq.current}`, em: new Date().toISOString(), fase: 'saudacao', paragrafos: saudacaoDa(me.user.name, marcaAtual?.name ?? 'sua marca') }]);
    },
    [me.user.name],
  );

  const carregarLista = useCallback(async (brandId: string): Promise<ConversationListResponse | null> => {
    const r = await chamar(() => api.GET('/v1/conversations', { params: { query: { brand_id: brandId } } }));
    if (!r.ok) {
      setLista({ tipo: 'erro', problema: r.problema });
      return null;
    }
    setLista({ tipo: 'ok', dados: r.data });
    return r.data;
  }, []);

  const carregar = useCallback(async () => {
    setLista({ tipo: 'carregando' });
    const m = await chamar(() => api.GET('/v1/brands'));
    if (!m.ok) return setLista({ tipo: 'erro', problema: m.problema });
    const ativas = m.data.items.filter((b) => !b.archived_at);
    setMarcas(ativas);
    const primeira = ativas[0];
    if (!primeira) return setLista({ tipo: 'erro', problema: { status: 404, code: 'sem-marca', title: 'Nenhuma marca ativa', detail: 'A conversa é por marca: quando a empresa tiver uma marca ativa, a LIA aparece aqui.' } });
    setMarca(primeira.id);
    if (await carregarLista(primeira.id)) novaConversa(primeira);
  }, [carregarLista, novaConversa]);

  // A primeira abertura carrega as marcas e as conversas; fechado, o painel não pede nada.
  useEffect(() => {
    if (conversa.aberta && lista.tipo === 'vazia') disparar(carregar());
  }, [conversa.aberta, lista.tipo, carregar]);

  // Ao abrir, o foco entra no painel: no campo (com teclado) ou no título (no toque, para o teclado não subir sozinho).
  const prontoParaFoco = lista.tipo !== 'vazia' && lista.tipo !== 'carregando';
  useEffect(() => {
    if (!conversa.aberta) return;
    // Depois dos efeitos do shell (a gaveta do menu, ao fechar, devolve o foco ao botão dela): o painel fica com o foco.
    const t = setTimeout(() => {
      const alvo = vista === 'conversa' && !desligada && !bloqueada && prontoParaFoco && !toque() ? campo.current : titulo.current;
      alvo?.focus({ preventScroll: true });
    }, 0);
    return () => clearTimeout(t);
    // Só na abertura (e quando a conversa termina de carregar): digitar ou trocar de vista não mexe no foco.
  }, [conversa.aberta, prontoParaFoco]);

  /** O foco na conversa: o campo (com teclado) ou o título (no toque, ou quando o campo não está na tela). */
  const focarNaConversa = () => ((toque() ? null : campo.current) ?? titulo.current)?.focus({ preventScroll: true });

  // O foco pedido enquanto a conversa abria: só depois do desenho o campo (ou o título da lista) existe.
  useEffect(() => {
    const para = focoPendente.current;
    if (!para || abrindo) return;
    focoPendente.current = null;
    if (para === 'historico') tituloDoHistorico.current?.focus({ preventScroll: true });
    else focarNaConversa();
  }, [abrindo, itens, vista]);

  // Depois de cada mensagem nova, a lista rola até a última pergunta da pessoa (a resposta fica logo abaixo).
  useEffect(() => {
    const id = rolarAte.current;
    if (!id) return;
    rolarAte.current = null;
    const el = document.getElementById(`msg-${id}`);
    const caixa = mensagens.current;
    if (el && caixa) caixa.scrollTop = Math.max(0, el.offsetTop - 12);
  }, [itens]);

  // Quando a lista aparece (o painel abriu, ou a vista voltou de Suas conversas), ela começa na última pergunta.
  useEffect(() => {
    const caixa = mensagens.current;
    if (!conversa.aberta || vista !== 'conversa' || !caixa) return;
    const ultima = [...itens].reverse().find((i) => i.de === 'eu');
    const el = ultima ? document.getElementById(`msg-${ultima.id}`) : null;
    caixa.scrollTop = el ? Math.max(0, el.offsetTop - 12) : 0;
    // Só quando a lista aparece: mensagem nova é com o efeito de cima.
  }, [conversa.aberta, vista]);

  const trocar = (id: string, novo: Item) => setItens((atuais) => atuais.map((i) => (i.id === id ? novo : i)));

  async function enviar(bruto: string) {
    const t = bruto.trim();
    if (!t || ocupada || bloqueada || desligada || !marca || vista !== 'conversa') return;
    const messageId = uuidv7();
    const idDaResposta = `r-${messageId}`;
    const em = new Date().toISOString();
    ultimaPergunta.current = t;
    rolarAte.current = messageId;
    setTexto('');
    setContatoAberto(false);
    setItens((atuais) => [...atuais, { de: 'eu', id: messageId, em, texto: t, nota: null }, { de: 'lia', id: idDaResposta, em, fase: 'respondendo', passos: [] }]);
    setOcupada(true);
    setAnuncio('A LIA está respondendo…');
    const controle = new AbortController();
    parar.current = controle;
    let chegou = false;
    let comCartao = false;
    // O que entra no lugar de "respondendo" (a resposta, o aviso ou a interrompida): a pergunta sobe para o alto
    // da lista e a resposta fica logo abaixo dela.
    const entregar = (item: Item) => {
      rolarAte.current = messageId;
      trocar(idDaResposta, item);
    };
    const foraDoAr = (): Item => ({ de: 'sistema', id: idDaResposta, em: new Date().toISOString(), m: { notice: 'fora_do_ar', ...AVISO_VAZIO } });
    const fim = await mandarMensagem(
      { message_id: messageId, brand_id: marca, ...(atual ? { conversation_id: atual.id } : {}), text: t },
      (e) => {
        if (e.type === 'inicio') {
          if (e.conversation) setAtual(e.conversation);
          // A mensagem como foi guardada: sem o dado pessoal, com o aviso de quantos saíram.
          if (e.message) trocar(messageId, { de: 'eu', id: messageId, em: e.message.created_at, texto: e.message.text ?? t, nota: notaDeDadoPessoal(e.message.removed_personal_data) });
        } else if (e.type === 'passo' && e.step) {
          const passo: ConversationStep = e.step;
          setItens((atuais) =>
            atuais.map((i) => {
              if (i.id !== idDaResposta || i.de !== 'lia' || i.fase !== 'respondendo') return i;
              const tem = i.passos.some((p) => p.id === passo.id);
              return { ...i, passos: tem ? i.passos.map((p) => (p.id === passo.id ? passo : p)) : [...i.passos, passo] };
            }),
          );
        } else if (e.type === 'mensagem' && e.message) {
          chegou = true;
          comCartao = e.message.cards.some((c) => c.kind === 'proposta_cupom');
          entregar(itemDa(e.message));
        } else if (e.type === 'fim' && e.conversation) {
          setAtual(e.conversation);
        } else if (e.type === 'erro') {
          chegou = true;
          entregar(foraDoAr());
        }
      },
      controle.signal,
    );
    if (parar.current === controle) parar.current = null;
    setOcupada(false);
    if (fim.tipo === 'parada') {
      if (!chegou) entregar(paradaLocal(idDaResposta, em));
      setAnuncio('Resposta interrompida.');
    } else if (fim.tipo === 'erro') {
      const codigo = fim.problema.code;
      if (codigo === 'mensagem-repetida' || codigo === 'conversa-cheia') {
        // O servidor já tem esta mensagem (ou a conversa encheu em outra aba): a tela mostra o que está guardado.
        if (atual) disparar(abrirConversa(atual.id, false));
      } else if (fim.problema.status === 0 || fim.problema.status >= 500 || chegou) {
        if (!chegou) entregar(foraDoAr());
      } else {
        // Recusa antes de começar (a conversa ocupada, o limite de pedidos…): a mensagem volta para o campo.
        setItens((atuais) => atuais.filter((i) => i.id !== messageId && i.id !== idDaResposta));
        setTexto(t);
        avisar(codigo === 'conversa-ocupada' ? 'A LIA ainda está respondendo nesta conversa. Espere um instante.' : mensagemDe(fim.problema), { tipo: 'perigo' });
      }
      setAnuncio('A LIA não respondeu agora.');
    } else {
      if (!chegou) entregar(foraDoAr());
      setAnuncio(chegou ? 'Resposta da LIA pronta.' : 'A LIA não respondeu agora.');
      if (!aberta.current) conversa.marcarNova(true);
      // A proposta de cupom entra na fila de quem aprova.
      if (comCartao) aprovacoes.recarregar();
    }
    // A lista de conversas acompanha (a conversa nova entra nela), sem atrapalhar a tela.
    disparar(carregarLista(marca));
  }

  async function abrirConversa(id: string, focar = true) {
    parar.current?.abort();
    // O item clicado sai da tela enquanto a conversa abre: o foco espera no título do painel.
    if (focar) titulo.current?.focus({ preventScroll: true });
    setAbrindo(true);
    setVista('conversa');
    setContatoAberto(false);
    const r = await chamar(() => api.GET('/v1/conversations/{id}', { params: { path: { id } } }));
    if (!r.ok) {
      avisar(mensagemDe(r.problema), { tipo: 'perigo' });
      if (focar) focoPendente.current = 'historico';
      setVista('historico');
      setAbrindo(false);
      return;
    }
    if (focar) focoPendente.current = 'conversa';
    setAbrindo(false);
    setAtual(r.data.conversation);
    setItens(r.data.messages.map(itemDa));
    const ultimaDaPessoa = [...r.data.messages].reverse().find((m) => m.role === 'pessoa');
    ultimaPergunta.current = ultimaDaPessoa?.text ?? '';
    rolarAte.current = ultimaDaPessoa?.id ?? null;
    setAnuncio(`Conversa aberta: ${r.data.conversation.title}`);
  }

  function tentarDeNovo() {
    if (ocupada || bloqueada) return;
    // Sai o aviso (ou a resposta interrompida) junto com a pergunta que ficou sem resposta, e a pergunta volta a ser enviada.
    const indice = itens.map((i) => i.de).lastIndexOf('eu');
    if (indice < 0) return;
    const pergunta = itens[indice]!;
    const t = ultimaPergunta.current || (pergunta.de === 'eu' ? pergunta.texto : '');
    setItens((atuais) => atuais.slice(0, indice));
    disparar(enviar(t));
    focarNaConversa();
  }

  function falarComUmaPessoa() {
    if (desligada) {
      setContatoAberto(true);
      return;
    }
    if (vista !== 'conversa') setVista('conversa');
    parar.current?.abort();
    const id = `pessoa-${++seq.current}`;
    rolarAte.current = id;
    setItens((atuais) => [...atuais, { de: 'sistema', id, em: new Date().toISOString(), m: { notice: 'pessoa', ...AVISO_VAZIO, contact: dados?.contact ?? null }, focar: true }]);
    setAnuncio('Como falar com uma pessoa da Liame.');
  }

  async function cancelarDemanda(id: string) {
    setCancelando(`demanda:${id}`);
    const r = await chamar(() => api.POST('/v1/demands/{id}/cancel', { params: { path: { id } } }));
    setCancelando(null);
    if (!r.ok) return avisar(mensagemDe(r.problema), { tipo: 'perigo' });
    setItens((atuais) =>
      atuais.map((i) => (i.de === 'lia' && (i.fase === 'pronta' || i.fase === 'parada') ? { ...i, m: { ...i.m, cards: i.m.cards.map((c) => (c.demand?.id === id ? { ...c, demand: r.data } : c)) } } : i)),
    );
    avisar('Demanda cancelada. Nada foi feito.');
    setAnuncio('Demanda cancelada.');
    focarNaConversa();
  }

  async function cancelarProposta(acaoId: string) {
    setCancelando(`proposta:${acaoId}`);
    const r = await chamar(() => api.POST('/v1/coupons/regem/{id}/cancel', { params: { path: { id: acaoId } } }));
    setCancelando(null);
    if (!r.ok) return avisar(mensagemDe(r.problema), { tipo: 'perigo' });
    setItens((atuais) =>
      atuais.map((i) =>
        i.de === 'lia' && (i.fase === 'pronta' || i.fase === 'parada')
          ? { ...i, m: { ...i.m, cards: i.m.cards.map((c) => (c.coupon?.request.action_id === acaoId ? { ...c, coupon: { ...c.coupon, request: { ...c.coupon.request, status: 'cancelada' } } } : c)) } }
          : i,
      ),
    );
    aprovacoes.recarregar();
    avisar('Pedido de cupom cancelado. Nada foi criado no Regem.');
    setAnuncio('Pedido de cupom cancelado.');
    focarNaConversa();
  }

  // A pergunta que outra tela mandou (o Resumo, Sua equipe): vai quando o painel está pronto para conversar.
  const pedido = conversa.pedido;
  const pronta = dados !== null && !desligada && !abrindo && !ocupada;
  useEffect(() => {
    if (!pedido || !conversa.aberta || !dados) return;
    if (desligada) return conversa.consumirPedido();
    if (!pronta) return;
    conversa.consumirPedido();
    if (vista !== 'conversa') setVista('conversa');
    disparar(enviar(pedido.texto));
    // A pergunta é enviada uma vez, quando o painel fica pronto.
  }, [pedido, conversa.aberta, pronta, desligada]);

  function aoEnviar(evento: FormEvent) {
    evento.preventDefault();
    disparar(enviar(texto));
  }
  function aoTeclar(evento: TeclaDoReact<HTMLTextAreaElement>) {
    if (evento.key === 'Enter' && !evento.shiftKey && !evento.nativeEvent.isComposing) {
      evento.preventDefault();
      disparar(enviar(texto));
    }
  }

  // O campo cresce com o texto, até um teto (depois rola por dentro).
  useEffect(() => {
    const c = campo.current;
    if (!c) return;
    c.style.height = 'auto';
    c.style.height = `${Math.min(c.scrollHeight + 2, 132)}px`;
  }, [texto]);

  const cartoes = { euId: me.user.id, agora, pode, ocupado: cancelando, aoCancelarDemanda: (id: string) => disparar(cancelarDemanda(id)), aoCancelarProposta: (id: string) => disparar(cancelarProposta(id)) };
  const conta = contaDaMensagem(texto.length);
  const carregando = lista.tipo === 'vazia' || lista.tipo === 'carregando' || abrindo;
  const semHistorico = carregando || lista.tipo === 'erro' || desligada;
  const [ponto, situacao] = desligada
    ? ['ponto ponto--off', 'desligada nesta empresa']
    : lista.tipo === 'erro'
      ? ['ponto ponto--atraso', 'sem conexão agora']
      : carregando
        ? ['ponto ponto--off', 'carregando…']
        : ocupada
          ? ['ponto', 'respondendo…']
          : ['ponto', `lê os números da ${nomeDaMarca}`];

  let corpo;
  if (carregando) {
    corpo = (
      <div className="lia-vista">
        <div className="lia-esq" aria-busy="true">
          <p className="sr-only">Carregando a conversa…</p>
          <div aria-hidden="true">
            <span className="esqueleto esqueleto--curto" />
            <span className="esqueleto" />
            <span className="esqueleto esqueleto--medio" />
          </div>
          <div className="esq-eu" aria-hidden="true">
            <span className="esqueleto esqueleto--medio" />
          </div>
          <div aria-hidden="true">
            <span className="esqueleto esqueleto--curto" />
            <span className="esqueleto" />
            <span className="esqueleto esqueleto--medio" />
          </div>
        </div>
      </div>
    );
  } else if (lista.tipo === 'erro') {
    corpo = (
      <div className="lia-vista">
        <div className="vazio" role="alert">
          <span className="vazio-ic vazio-ic--perigo" aria-hidden="true">
            <Icone nome="alert-circle" />
          </span>
          <h3>Não foi possível carregar a conversa</h3>
          <p>{mensagemDe(lista.problema)} Nada foi perdido.</p>
          <div className="vazio-acoes">
            <button
              className="btn btn--primary"
              type="button"
              onClick={() => {
                titulo.current?.focus({ preventScroll: true });
                disparar(carregar());
              }}
            >
              <Icone nome="refresh" />
              Tentar de novo
            </button>
          </div>
        </div>
      </div>
    );
  } else if (desligada && dados) {
    corpo = (
      <div className="lia-vista">
        <div className="vazio">
          <span className="vazio-ic" aria-hidden="true">
            <Icone nome="info" />
          </span>
          <h3>A LIA está desligada nesta empresa</h3>
          <p>As telas, os avisos, o Explicar e a revisão da semana seguem funcionando, com os resumos montados pelo sistema, por regra.</p>
          <p>Quem liga a LIA é a Liame, a pedido do dono da empresa.</p>
          <div className="vazio-acoes">
            <button className="btn" type="button" onClick={falarComUmaPessoa} aria-expanded={contatoAberto}>
              Falar com uma pessoa
            </button>
          </div>
        </div>
        {contatoAberto && (
          <div className="artefato artefato--sistema">
            <p className="artefato-tit">
              <Icone nome="users" />
              <span>Falar com uma pessoa da Liame</span>
            </p>
            <div className="msg-corpo">
              <p>A LIA é uma assistente de IA e não passa a conversa para ninguém. Para falar com o atendimento da Liame, escreva para:</p>
            </div>
            <ContatoDoAtendimento contato={dados.contact} focarAoAparecer />
          </div>
        )}
      </div>
    );
  } else if (vista === 'historico' && dados) {
    corpo = (
      <div className="lia-vista">
        <div className="hist">
          <div className="hist-cab">
            <div>
              <h3 ref={tituloDoHistorico} tabIndex={-1}>
                Suas conversas
              </h3>
              <p>
                Na {nomeDaMarca}, nos últimos {dados.retention_days} dias.
              </p>
            </div>
            <button
              className="btn btn--sm"
              type="button"
              onClick={() => {
                novaConversa(marcas?.find((m) => m.id === marca));
                setAnuncio('Nova conversa.');
                // A lista sai da tela: o foco vai para a conversa nova, depois do desenho.
                setTimeout(focarNaConversa, 0);
              }}
            >
              <Icone nome="plus" pequeno />
              Nova conversa
            </button>
          </div>
          {marcas && marcas.length > 1 && (
            <label className="res-campo">
              <span>Marca</span>
              <select
                className="input"
                value={marca ?? ''}
                onChange={(e) => {
                  const nova = marcas.find((m) => m.id === e.target.value);
                  if (!nova) return;
                  // A lista sai enquanto a outra marca carrega: o foco espera no título do painel e depois vai para a conversa nova.
                  titulo.current?.focus({ preventScroll: true });
                  setMarca(nova.id);
                  setLista({ tipo: 'carregando' });
                  disparar(
                    carregarLista(nova.id).then((ok) => {
                      if (!ok) return;
                      focoPendente.current = 'conversa';
                      novaConversa(nova);
                    }),
                  );
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
          {dados.items.length ? (
            <ul className="hist-lista">
              {dados.items.map((h) => (
                <li key={h.id}>
                  <button className="hist-item" type="button" aria-current={h.id === atual?.id ? 'true' : undefined} onClick={() => disparar(abrirConversa(h.id))}>
                    <b>{h.title}</b>
                    <span className="hist-meta">
                      <span>{quandoComHora(h.last_message_at, agora)}</span>
                      {h.has_demand && <span className="st st--info">Demanda aberta</span>}
                      {h.id === atual?.id && <span>· aberta agora</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="vazio">
              <span className="vazio-ic" aria-hidden="true">
                <Icone nome="message" />
              </span>
              <h3>Nenhuma conversa ainda</h3>
              <p>Quando você conversar com a LIA, as conversas dos últimos {dados.retention_days} dias aparecem aqui.</p>
            </div>
          )}
          <p className="explica-nota">
            Só você vê as suas conversas. Elas ficam guardadas por {dados.retention_days} dias; as demandas e as propostas que saíram delas seguem registradas depois disso.
          </p>
        </div>
      </div>
    );
  } else {
    let dia = '';
    corpo = (
      <ol className="lia-msgs" ref={mensagens} aria-label="Mensagens da conversa">
        {itens.map((item, n) => {
          const doDia = diaDaMensagem(item.em, agora);
          const separador = doDia !== dia ? <li className="msg-dia" key={`dia-${item.id}`}>{doDia}</li> : null;
          dia = doDia;
          const ultima = n === itens.length - 1;
          const mensagem =
            item.de === 'eu' ? (
              <MensagemDaPessoa key={item.id} item={item} />
            ) : item.de === 'lia' ? (
              <MensagemDaLia key={item.id} item={item} modo={modo} pode={pode} cartoes={cartoes} ultima={ultima} aoPerguntarDeNovo={tentarDeNovo} />
            ) : (
              <MensagemDoSistema key={item.id} item={item} podeVerContas={pode('contas.ver')} ultima={ultima} contato={dados?.contact ?? null} aoTentarDeNovo={tentarDeNovo} />
            );
          return separador ? [separador, mensagem] : mensagem;
        })}
      </ol>
    );
  }

  const conversando = !carregando && lista.tipo === 'ok' && !desligada && vista === 'conversa';

  return (
    <aside
      className="lia"
      id={ID_DO_PAINEL}
      aria-labelledby="lia-t"
      hidden={!conversa.aberta}
      {...(modal ? { role: 'dialog', 'aria-modal': true } : {})}
      // Com o painel por cima, a ação que leva a outra tela fecha o painel antes (a tela deixa de estar inerte).
      onClickCapture={(e) => {
        if (modal && e.target instanceof Element && e.target.closest('a[href^="/"]')) conversa.fechar({ devolverFoco: false });
      }}
    >
      <header className="lia-cab">
        <IconeLia />
        <div className="lia-id">
          <h2 className="lia-nome" id="lia-t" ref={titulo} tabIndex={-1}>
            LIA{' '}
            <span className="st st--ia">
              <Icone nome="sparkles" />
              Assistente de IA
            </span>
          </h2>
          <p className="lia-status">
            <span className={ponto} aria-hidden="true" />
            <span>{situacao}</span>
          </p>
        </div>
        {!semHistorico && (
          <>
            <button
              ref={botaoDoHistorico}
              className="btn btn--icon btn--sm btn--ghost"
              type="button"
              aria-pressed={vista === 'historico'}
              aria-label="Suas conversas"
              title="Suas conversas"
              onClick={() => {
                const para = vista === 'historico' ? 'conversa' : 'historico';
                setVista(para);
                setAnuncio(para === 'historico' ? 'Suas conversas.' : 'De volta à conversa.');
                // O título da lista só existe depois do desenho.
                setTimeout(() => (para === 'historico' ? tituloDoHistorico.current : botaoDoHistorico.current)?.focus({ preventScroll: true }), 0);
              }}
            >
              <Icone nome="history" />
            </button>
            <button
              className="btn btn--icon btn--sm btn--ghost"
              type="button"
              aria-label="Nova conversa"
              title="Nova conversa"
              onClick={() => {
                novaConversa(marcas?.find((m) => m.id === marca));
                setAnuncio('Nova conversa.');
                setTimeout(focarNaConversa, 0);
              }}
            >
              <Icone nome="plus" />
            </button>
          </>
        )}
        <button className="btn btn--icon btn--sm btn--ghost" type="button" aria-label="Fechar a conversa" title="Fechar (Esc)" onClick={() => conversa.fechar()}>
          <Icone nome="x" />
        </button>
      </header>
      <div className="lia-corpo">{corpo}</div>
      {conversando && (
        <div className="lia-pe">
          {faixa && (
            <div className={faixa.neutro ? 'lia-faixa lia-faixa--neutro' : 'lia-faixa'} role="status">
              <Icone nome={faixa.neutro ? 'info' : 'clock'} />
              <div className="lia-faixa-txt">
                <b>{faixa.titulo}</b>
                <span>{faixa.texto}</span>
                {faixa.novaConversa && (
                  <button
                    className="btn btn--sm"
                    type="button"
                    onClick={() => {
                      novaConversa(marcas?.find((m) => m.id === marca));
                      setAnuncio('Nova conversa.');
                      // A faixa sai com o botão: o foco vai para o campo, que volta.
                      setTimeout(focarNaConversa, 0);
                    }}
                  >
                    Nova conversa
                  </button>
                )}
              </div>
            </div>
          )}
          {!bloqueada && !ocupada && !comecou && (
            <div className="lia-sug" role="group" aria-label="Sugestões de pergunta">
              {SUGESTOES[modo].map((s) => (
                <button className="chip-sug" type="button" key={s} onClick={() => disparar(enviar(s))}>
                  {s}
                </button>
              ))}
            </div>
          )}
          {!bloqueada && (
            <form className="lia-form" noValidate onSubmit={aoEnviar}>
              <label className="sr-only" htmlFor="lia-input">
                Mensagem para a LIA
              </label>
              <textarea
                ref={campo}
                className="area lia-input"
                id="lia-input"
                rows={1}
                maxLength={MENSAGEM_MAXIMA}
                placeholder="Pergunte ou peça algo à LIA…"
                autoComplete="off"
                enterKeyHint="send"
                value={texto}
                onChange={(e) => setTexto(e.target.value)}
                onKeyDown={aoTeclar}
              />
              {ocupada ? (
                <button className="btn btn--icon" type="button" aria-label="Parar a resposta" title="Parar a resposta" onClick={() => parar.current?.abort()}>
                  <Icone nome="stop" />
                </button>
              ) : (
                <button className="btn btn--primary btn--icon" type="submit" aria-label="Enviar" title="Enviar (Enter)">
                  <Icone nome="send" />
                </button>
              )}
            </form>
          )}
          {conta && (
            <p className="lia-conta" role="status">
              {conta}
            </p>
          )}
          <p className="lia-dica">
            A LIA é uma assistente de IA: lê os números do sistema e propõe; quem decide é você. Não escreva nome, telefone nem outro dado de cliente.{' '}
            <button className="link-bt" type="button" onClick={falarComUmaPessoa}>
              Falar com uma pessoa
            </button>
          </p>
        </div>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {anuncio}
      </p>
    </aside>
  );
}
