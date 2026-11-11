'use client';

import type { BrandResponse, DirectAttendanceResponse, DirectAutoReplyResponse, DirectConversationsResponse, DirectSettingsResponse } from '@liame/contracts';
import Link from 'next/link';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useAvisar } from '@/components/ui/avisos';
import { ConfirmaNaLinha } from '@/components/ui/confirma-na-linha';
import { Estado } from '@/components/ui/estado';
import { Faixa } from '@/components/ui/faixa';
import { Icone } from '@/components/ui/icone';
import { useAgora } from '@/lib/agora';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { useContadorDirect } from '@/lib/contador-direct';
import { horaDe } from '@/lib/formato';
import { useSessao } from '@/lib/sessao';
import { GavetaDoAutomaticoDoDirect, LinhaDoAutomaticoDoDirect } from './automatico';
import { type Confirmacao, DialogoDeConfirmar, type ResultadoDaConfirmacao } from './confirmar';
import { ConversaDoDirect } from './conversa';
import {
  avisoDaLeitura,
  avisoDoMessenger,
  CANAIS_DO_DIRECT,
  type CanalDoDirect,
  doisCanais,
  estadoDoDirect,
  FILTROS_DO_DIRECT,
  type FiltroDoDirect,
  iniciaisDe,
  lidoDoDirect,
  nomeDaCaixa,
  ofereceMessenger,
  previaDaConversa,
  quemEscreveu,
  seloDaSituacao,
  situacaoDaPagina,
  textoDoAtendimento,
  tipoDaConversa,
  vazioDoDirect,
} from './textos';

// A tela Direct (mockups/prototipo-direct.html, P39 aprovado em 11/11/2026; A6, Z12, parte 3): as conversas do Direct
// do Instagram da marca, para quem usa o Liame sem o Regem. A lista e a conversa lado a lado (no estreito, uma de cada
// vez), as situações que filtram, a busca, a janela da Meta de cada conversa e a resposta com o atendimento aberto. Os
// estados vêm do ajuste da marca: a função não liberada, a marca sem Instagram, o Regem atendendo esta conta, ligar,
// a primeira leitura e as faixas da leitura. A sugestão do Social media (parte 4) e o automático (parte 5) vêm depois.

/** O Liame lê o Direct a cada minuto: a tela lê de novo no mesmo ritmo. */
const LER_DE_NOVO_MS = 60_000;

type Carga<T> = { tipo: 'carregando' } | { tipo: 'ok'; dados: T } | { tipo: 'erro'; problema: Problema };

export function DirectTela() {
  const { pode } = useSessao();
  const podeVer = pode('campanhas.ver');
  const podeVerContas = pode('contas.ver');
  const avisar = useAvisar();
  const titulo = useRef<HTMLHeadingElement>(null);
  const [marcas, setMarcas] = useState<BrandResponse[] | null>(null);
  const [erroMarcas, setErroMarcas] = useState<Problema | null>(null);
  const [marca, setMarca] = useState<string | null>(null);
  const [ajuste, setAjuste] = useState<Carga<DirectSettingsResponse>>({ tipo: 'carregando' });
  const [atendimento, setAtendimento] = useState<DirectAttendanceResponse | null>(null);
  const [lista, setLista] = useState<Carga<DirectConversationsResponse>>({ tipo: 'carregando' });
  const [filtro, setFiltro] = useState<FiltroDoDirect>('espera');
  // O canal (A6, Z14): os dois, só o Instagram ou só o Messenger; só com os dois canais na caixa.
  const [canal, setCanal] = useState<CanalDoDirect>('todos');
  const [busca, setBusca] = useState('');
  const [buscando, setBuscando] = useState('');
  const [aberta, setAberta] = useState<string | null>(null);
  const [comConversa, setComConversa] = useState(false);
  const [tentativa, setTentativa] = useState(0);
  const [pedido, setPedido] = useState<'turno' | 'ligar' | 'messenger' | null>(null);
  // Quem espera o atendimento aberto (a resposta que a pessoa mandou): responde sim ao abrir, não ao fechar o diálogo.
  const esperaAtendimento = useRef<((ok: boolean) => void) | null>(null);
  const [focarConversa, setFocarConversa] = useState(false);
  const [desligando, setDesligando] = useState<'nao' | 'confirmar' | 'enviando'>('nao');
  const [automatico, setAutomatico] = useState<DirectAutoReplyResponse | null>(null);
  const [gavetaDoAutomatico, setGavetaDoAutomatico] = useState(false);
  const [semOutro, setSemOutro] = useState(false);
  const [erroLigar, setErroLigar] = useState<string | null>(null);
  // Ligar e desligar o Messenger da Página (A6, Z14; D-A6-121): separado do Direct.
  const [semOutroNoMessenger, setSemOutroNoMessenger] = useState(false);
  const [erroMessenger, setErroMessenger] = useState<string | null>(null);
  const [desligandoMessenger, setDesligandoMessenger] = useState<'nao' | 'confirmar' | 'enviando'>('nao');
  const agora = useAgora(60_000, lista.tipo === 'ok' ? lista.dados : null);
  const seqLista = useRef(0);
  const caixa = useRef<HTMLDivElement>(null);
  const { recarregar: recarregarMenu } = useContadorDirect();
  const esperamAntes = useRef<number | null>(null);

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

  // O atendimento é da pessoa (vale para todas as marcas da empresa).
  useEffect(() => {
    if (!podeVer) return;
    disparar(
      chamar(() => api.GET('/v1/direct/attendance')).then((r) => {
        if (r.ok) setAtendimento(r.data);
      }),
    );
  }, [podeVer]);

  // O ajuste da marca, ao trocar de marca e no ritmo da leitura (a primeira leitura e a conferência do Regem mudam).
  useEffect(() => {
    if (!marca) return;
    let vivo = true;
    disparar(
      chamar(() => api.GET('/v1/direct/settings', { params: { query: { brand_id: marca } } })).then((r) => {
        if (!vivo) return;
        setAjuste((a) => (r.ok ? { tipo: 'ok', dados: r.data } : a.tipo === 'ok' && a.dados.brand_id === marca ? a : { tipo: 'erro', problema: r.problema }));
      }),
    );
    return () => {
      vivo = false;
    };
  }, [marca, tentativa]);

  // O atendimento automático da marca (parte 5b): a linha no topo da caixa e a gaveta, só com a função liberada.
  useEffect(() => {
    if (!marca) return;
    let vivo = true;
    setAutomatico(null);
    disparar(
      chamar(() => api.GET('/v1/direct/auto-reply', { params: { query: { brand_id: marca } } })).then((r) => {
        // Sem resposta, a linha não aparece: nada muda na caixa, e a equipe responde como sempre.
        if (vivo && r.ok) setAutomatico(r.data);
      }),
    );
    return () => {
      vivo = false;
    };
  }, [marca]);

  useEffect(() => {
    const t = setTimeout(() => setBuscando(busca.trim()), 350);
    return () => clearTimeout(t);
  }, [busca]);

  useEffect(() => {
    const t = setInterval(() => setTentativa((n) => n + 1), LER_DE_NOVO_MS);
    return () => clearInterval(t);
  }, []);

  const estado = ajuste.tipo === 'ok' && ajuste.dados.brand_id === marca ? estadoDoDirect(ajuste.dados) : null;
  const doMessenger = ajuste.tipo === 'ok' && ajuste.dados.brand_id === marca ? ajuste.dados.messenger : null;
  const dois = doisCanais(doMessenger);
  const canalPedido = dois && canal !== 'todos' ? canal : null;

  useEffect(() => {
    if (!marca || estado !== 'caixa') return;
    const id = ++seqLista.current;
    setLista((l) => (l.tipo === 'ok' && l.dados.brand_id === marca ? l : { tipo: 'carregando' }));
    const query = { brand_id: marca, status: filtro, ...(buscando ? { q: buscando } : {}), ...(canalPedido ? { channel: canalPedido } : {}) };
    disparar(
      chamar(() => api.GET('/v1/direct/conversations', { params: { query } })).then((r) => {
        if (id !== seqLista.current) return;
        setLista(r.ok ? { tipo: 'ok', dados: r.data } : { tipo: 'erro', problema: r.problema });
        // O contador do menu lê de novo quando "Esperam resposta" muda entre duas leituras da tela.
        if (!r.ok) return;
        if (esperamAntes.current !== null && esperamAntes.current !== r.data.counts.espera) recarregarMenu();
        esperamAntes.current = r.data.counts.espera;
      }),
    );
  }, [marca, estado, filtro, buscando, canalPedido, tentativa, recarregarMenu]);

  // A primeira conversa da lista fica aberta no largo (no estreito, a lista fica sozinha até a pessoa escolher). A
  // conversa aberta não troca sozinha: respondida, ela sai de "Esperam resposta", e continua aberta até a pessoa escolher outra.
  useEffect(() => {
    if (lista.tipo !== 'ok') return;
    setAberta((a) => a ?? lista.dados.items[0]?.id ?? null);
  }, [lista]);

  const lerDeNovo = useCallback(() => setTentativa((n) => n + 1), []);

  /** O atendimento aberto, ou a confirmação dele agora (a promessa responde quando o diálogo fecha). */
  const garantirAtendimento = useCallback(async (): Promise<boolean> => {
    if (atendimento?.open && atendimento.until && new Date(atendimento.until).getTime() > Date.now()) return true;
    return new Promise<boolean>((resolver) => {
      esperaAtendimento.current = resolver;
      setPedido('turno');
    });
  }, [atendimento]);

  const atendimentoVenceu = useCallback(() => setAtendimento((a) => (a ? { ...a, open: false, until: null } : a)), []);

  async function abrirAtendimento(c: Confirmacao): Promise<ResultadoDaConfirmacao> {
    const r = await chamar(() => api.POST('/v1/direct/attendance', { body: c }));
    if (!r.ok) return { ok: false, problema: r.problema };
    setAtendimento(r.data);
    avisar(`Atendimento aberto até ${r.data.until ? horaDe(r.data.until) : 'daqui a 8 horas'}.`);
    esperaAtendimento.current?.(true);
    esperaAtendimento.current = null;
    return { ok: true };
  }

  async function fecharAtendimento() {
    const r = await chamar(() => api.DELETE('/v1/direct/attendance'));
    if (!r.ok) return avisar(mensagemDe(r.problema), { tipo: 'perigo' });
    setAtendimento(r.data);
    avisar('Atendimento fechado. A próxima resposta pede a sua confirmação.');
  }

  async function ligar(c: Confirmacao): Promise<ResultadoDaConfirmacao> {
    if (!marca) return { ok: true };
    const r = await chamar(() => api.PUT('/v1/direct/settings', { body: { brand_id: marca, enabled: true, no_other_app: true, ...c } }));
    if (!r.ok) return { ok: false, problema: r.problema };
    setAjuste({ tipo: 'ok', dados: r.data });
    avisar('Direct ligado. A primeira leitura começa em até 1 minuto.');
    return { ok: true };
  }

  async function desligar() {
    if (!marca || ajuste.tipo !== 'ok') return;
    setDesligando('enviando');
    const r = await chamar(() => api.PUT('/v1/direct/settings', { body: { brand_id: marca, enabled: false, no_other_app: ajuste.dados.no_other_app } }));
    setDesligando('nao');
    if (!r.ok) return avisar(mensagemDe(r.problema), { tipo: 'perigo' });
    setAjuste({ tipo: 'ok', dados: r.data });
    avisar('Direct desligado nesta marca. O Liame para de ler e ninguém responde por aqui.');
  }

  async function ligarMessenger(c: Confirmacao): Promise<ResultadoDaConfirmacao> {
    if (!marca) return { ok: true };
    const r = await chamar(() => api.PUT('/v1/direct/messenger', { body: { brand_id: marca, enabled: true, no_other_app: true, ...c } }));
    if (!r.ok) return { ok: false, problema: r.problema };
    setAjuste({ tipo: 'ok', dados: r.data });
    recarregarMenu();
    avisar('Messenger ligado. A primeira leitura começa em até 1 minuto.');
    return { ok: true };
  }

  async function desligarMessenger() {
    if (!marca || ajuste.tipo !== 'ok') return;
    setDesligandoMessenger('enviando');
    const r = await chamar(() => api.PUT('/v1/direct/messenger', { body: { brand_id: marca, enabled: false, no_other_app: ajuste.dados.messenger.no_other_app } }));
    setDesligandoMessenger('nao');
    if (!r.ok) return avisar(mensagemDe(r.problema), { tipo: 'perigo' });
    setAjuste({ tipo: 'ok', dados: r.data });
    setCanal('todos');
    recarregarMenu();
    avisar('Messenger desligado nesta marca. O Direct segue aqui.');
  }

  if (!podeVer) {
    return (
      <Estado icone="lock" titulo="Esta tela é de quem acompanha as campanhas">
        O seu nível nesta empresa não mostra o Direct. Se precisar, peça ao dono da conta.
      </Estado>
    );
  }

  const marcaNome = marcas?.find((m) => m.id === marca)?.name ?? 'marca';
  const problema = erroMarcas ?? (ajuste.tipo === 'erro' ? ajuste.problema : null);
  const s = ajuste.tipo === 'ok' && ajuste.dados.brand_id === marca ? ajuste.dados : null;
  const conta = s?.account?.username ? `@${s.account.username}` : 'Instagram da marca';
  const pagina = s?.messenger.page?.name ?? 'Página da marca';
  const nome = nomeDaCaixa(s?.messenger ?? null);
  const podeResponder = Boolean(atendimento?.can_reply);
  const contasLink = podeVerContas ? (
    <Link className="btn btn--sm" href="/contas">
      Contas conectadas
    </Link>
  ) : undefined;

  let corpo;
  if (problema) {
    corpo = (
      <div className="card">
        <Estado
          icone="alert-circle"
          perigo
          titulo="Não foi possível carregar o Direct"
          acao={
            <div className="vazio-acoes">
              <button
                className="btn btn--primary"
                type="button"
                onClick={() => {
                  disparar(carregarMarcas());
                  lerDeNovo();
                }}
              >
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
          O Direct é lido por marca: quando a empresa tiver uma marca ativa, as conversas aparecem aqui.
        </Estado>
      </div>
    );
  } else if (!s || !estado) {
    corpo = (
      <div aria-busy="true">
        <p className="sr-only">Carregando o Direct…</p>
        <div className="card res-esqueleto" aria-hidden="true">
          <span className="esqueleto esqueleto--medio" />
          <span className="esqueleto esqueleto--medio" />
        </div>
      </div>
    );
  } else if (estado === 'desligada') {
    corpo = (
      <div className="card">
        <Estado icone="lock" titulo="O Direct ainda não está liberado para a sua empresa">
          Quando a distribuição do Liame liberar, esta tela mostra as mensagens que as pessoas mandam para o Instagram da marca, e a equipe responde por aqui.
        </Estado>
      </div>
    );
  } else if (estado === 'sem_instagram') {
    corpo = (
      <div className="card">
        <Estado
          icone="instagram"
          titulo="A marca ainda não tem um Instagram conectado"
          acao={
            podeVerContas ? (
              <div className="vazio-acoes">
                <Link className="btn btn--primary" href="/contas">
                  Conectar o Instagram
                </Link>
              </div>
            ) : undefined
          }
        >
          Conecte a conta do Instagram da marca em Contas conectadas para ler e responder o Direct por aqui.
        </Estado>
      </div>
    );
  } else if (estado === 'regem') {
    corpo = (
      <div className="dir">
        <Faixa
          tipo="acao"
          icone={<Icone nome="plug" />}
          titulo="O Direct desta conta é atendido no Regem"
          texto={`A Central de atendimento do Regem responde o Direct do ${conta}. Para ninguém receber duas respostas, o Liame não lê, não guarda e não responde o Direct desta conta.`}
          acao={
            <button className="btn btn--sm" type="button" onClick={lerDeNovo}>
              Conferir de novo
            </button>
          }
        />
        <div className="card dir-notas">
          {s.regem_checked_at && <Nota icone="check" texto={`Conferido com o Regem pela ligação da loja às ${horaDe(s.regem_checked_at)}. O Liame confere de novo a cada 15 minutos.`} />}
          <Nota icone="info" texto="Para atender o Direct por aqui, desligue o Direct do Instagram no Regem. Na conferência seguinte, esta tela oferece ligar o Direct no Liame." />
          <Nota icone="message" texto="Os comentários continuam em Comentários, pelo Liame: o Regem atende só as mensagens." />
        </div>
      </div>
    );
  } else if (estado === 'ligar') {
    corpo = (
      <div className="card">
        <div className="card-cab">
          <div>
            <h2 className="card-tit">Ligar o Direct no Liame</h2>
            <p className="card-sub">As mensagens do {conta} chegam aqui, e alguém da equipe responde.</p>
          </div>
        </div>
        <ol className="dir-ligar">
          <Passo n={1} titulo="A permissão de mensagens na Meta">
            O Liame lê o Direct pela autorização da Meta da marca. Se a permissão de mensagens faltar, a primeira leitura avisa aqui e diz como resolver (conectar a Meta de novo).
          </Passo>
          <Passo n={2} titulo="Ninguém mais responde este Direct" ok={s.regem === 'livre' || s.regem === 'sem_regem'}>
            {s.regem === 'livre'
              ? 'Conferido com o Regem: a Central de atendimento do Regem não atende o Direct desta conta. Se ela passar a atender, o Direct do Liame desliga sozinho nesta conta.'
              : s.regem === 'nao_conferido'
                ? 'A sua empresa usa o Regem, e a autorização dele ainda não deixa conferir quem atende este Direct. Ligado, o Liame só lê depois de conferir: conecte o Regem de novo em Contas conectadas.'
                : s.regem === 'sem_regem'
                  ? 'A sua empresa não usa o Regem.'
                  : 'O Liame confere com o Regem na primeira leitura.'}
            <label className="check">
              <input type="checkbox" id="dir-sem-outro" checked={semOutro} disabled={!s.can_enable} onChange={(e) => setSemOutro(e.target.checked)} />
              <span>Nenhum outro programa responde o Direct do {conta} (um robô ou outro atendimento ligado à conta).</span>
            </label>
          </Passo>
          <Passo n={3} titulo="Quem responde">
            O Dono, os Administradores e quem aprova. Cada um abre o atendimento com a sua confirmação, uma vez a cada 8 horas.
          </Passo>
          <Passo n={4} titulo="O que fica guardado, e como fica no Instagram">
            O texto das mensagens, por 90 dias; fotos, vídeos, áudios e stories ficam só no Instagram. Ler pelo Liame não marca a mensagem como lida no Instagram.
          </Passo>
        </ol>
        {erroLigar && (
          <p className="campo-erro" role="alert">
            {erroLigar}
          </p>
        )}
        <div className="dir-ligar-acoes">
          {s.can_enable ? (
            <button
              className="btn btn--primary"
              type="button"
              id="dir-ligar"
              aria-haspopup="dialog"
              onClick={() => {
                if (!semOutro) return setErroLigar('Para ligar, confirme que nenhum outro programa responde este Direct.');
                setErroLigar(null);
                setPedido('ligar');
              }}
            >
              Ligar o Direct no Liame
            </button>
          ) : (
            <p className="nota">
              <Icone nome="lock" />
              <span>Ligar o Direct é do Dono ou de um Administrador.</span>
            </p>
          )}
        </div>
      </div>
    );
  } else {
    const aviso = avisoDaLeitura(s, conta, agora);
    const avisoMessenger = avisoDoMessenger(s.messenger, pagina);
    const dados = lista.tipo === 'ok' && lista.dados.brand_id === marca ? lista.dados : null;
    const vazio = vazioDoDirect(filtro, buscando);
    corpo = (
      <div className="dir">
        {aviso && <Faixa tipo={aviso.tipo} icone={<Icone nome="alert" />} titulo={aviso.titulo} texto={aviso.texto} acao={aviso.contas ? contasLink : undefined} />}
        {avisoMessenger && (
          <Faixa
            tipo={avisoMessenger.tipo}
            icone={<Icone nome={avisoMessenger.tipo === 'acao' ? 'plug' : 'alert'} />}
            titulo={avisoMessenger.titulo}
            texto={avisoMessenger.texto}
            acao={
              avisoMessenger.contas ? (
                contasLink
              ) : (
                <button className="btn btn--sm" type="button" onClick={lerDeNovo}>
                  Conferir de novo
                </button>
              )
            }
          />
        )}
        {s.can_enable && ofereceMessenger(s.messenger) && (
          <div className="card" id="dir-messenger">
            <div className="card-cab">
              <div>
                <h2 className="card-tit">Ligar o Messenger no Liame</h2>
                <p className="card-sub">As mensagens do Messenger da {pagina} chegam aqui, junto do Direct, e a mesma equipe responde.</p>
              </div>
            </div>
            <ol className="dir-ligar">
              <Passo n={1} titulo="A permissão de mensagens da Página">
                O Liame lê e responde o Messenger pela autorização da Meta da marca. Se a permissão de mensagens da Página faltar, a primeira leitura avisa aqui e diz como resolver
                (conectar a Meta de novo).
              </Passo>
              <Passo n={2} titulo="Ninguém mais responde este Messenger">
                Ligado, o Liame confere com o Regem: se a Central de atendimento do Regem atender o Messenger desta Página, o Messenger do Liame para sozinho, e o Direct segue como
                está.
                <label className="check">
                  <input type="checkbox" id="dir-sem-outro-messenger" checked={semOutroNoMessenger} onChange={(e) => setSemOutroNoMessenger(e.target.checked)} />
                  <span>Nenhum outro programa responde o Messenger da {pagina} (um robô ou outro atendimento ligado à Página).</span>
                </label>
              </Passo>
              <Passo n={3} titulo="Quem responde, e o atendimento automático">
                As mesmas pessoas do Direct, com o mesmo atendimento aberto (8 horas). O atendimento automático, se estiver ligado, vale também para o Messenger, com os mesmos
                tipos e limites.
              </Passo>
              <Passo n={4} titulo="O que fica guardado">
                O texto das mensagens e o nome que a pessoa usa no Facebook, por 90 dias; fotos, vídeos e áudios ficam só no Messenger. A janela é a mesma do Direct: 24 horas
                depois da última mensagem da pessoa.
              </Passo>
            </ol>
            {erroMessenger && (
              <p className="campo-erro" role="alert">
                {erroMessenger}
              </p>
            )}
            <div className="dir-ligar-acoes">
              <button
                className="btn btn--primary"
                type="button"
                id="dir-ligar-messenger"
                aria-haspopup="dialog"
                onClick={() => {
                  if (!semOutroNoMessenger) return setErroMessenger('Para ligar, confirme que nenhum outro programa responde este Messenger.');
                  setErroMessenger(null);
                  setPedido('messenger');
                }}
              >
                Ligar o Messenger no Liame
              </button>
            </div>
          </div>
        )}
        <div className="dir-conta">
          <p className="dir-conta-txt">
            <span className="dir-conta-item">
              <Icone nome="instagram" />
              <b>{conta}</b>
            </span>
            {s.messenger.enabled && (
              <span className="dir-conta-item">
                <Icone nome="facebook" />
                <b>{pagina}</b>
                {situacaoDaPagina(s.messenger)}
              </span>
            )}
            <span className="dir-conta-item">
              <Icone nome="clock" />
              {lidoDoDirect(s.read_at, agora)}
            </span>
          </p>
          <div className="dir-conta-acoes">
            {podeResponder && (
              <>
                <span className={`dir-turno${atendimento?.open ? '' : ' dir-turno--fechado'}`} id="dir-turno">
                  <Icone nome={atendimento?.open ? 'check' : 'lock'} pequeno />
                  {textoDoAtendimento(atendimento?.open ? (atendimento.until ?? null) : null, agora)}
                </span>
                {atendimento?.open && (
                  <button className="btn btn--sm btn--ghost" type="button" onClick={() => disparar(fecharAtendimento())}>
                    Fechar o atendimento
                  </button>
                )}
              </>
            )}
            {s.can_disable && desligando === 'nao' && (
              <button className="btn btn--sm btn--ghost" type="button" id="dir-desligar" onClick={() => setDesligando('confirmar')}>
                <Icone nome="power" pequeno />
                Desligar o Direct
              </button>
            )}
            {s.can_disable && s.messenger.enabled && desligandoMessenger === 'nao' && (
              <button className="btn btn--sm btn--ghost" type="button" id="dir-desligar-messenger" onClick={() => setDesligandoMessenger('confirmar')}>
                <Icone nome="power" pequeno />
                Desligar o Messenger
              </button>
            )}
          </div>
          {desligando !== 'nao' && (
            <div className="dir-conta-confirma">
              <ConfirmaNaLinha
                texto="Desligado, o Liame para de ler o Direct desta marca e ninguém responde por aqui. As conversas guardadas ficam até sair pelo prazo de 90 dias."
                rotulo="Desligar o Direct"
                rotuloOcupado="Desligando…"
                ocupado={desligando === 'enviando'}
                aoConfirmar={() => disparar(desligar())}
                aoCancelar={() => setDesligando('nao')}
              />
            </div>
          )}
          {desligandoMessenger !== 'nao' && (
            <div className="dir-conta-confirma">
              <ConfirmaNaLinha
                texto="Desligado, o Liame para de ler o Messenger desta Página e ninguém responde por aqui. O Direct segue como está, e as conversas guardadas ficam até sair pelo prazo de 90 dias."
                rotulo="Desligar o Messenger"
                rotuloOcupado="Desligando…"
                ocupado={desligandoMessenger === 'enviando'}
                aoConfirmar={() => disparar(desligarMessenger())}
                aoCancelar={() => setDesligandoMessenger('nao')}
              />
            </div>
          )}
        </div>
        {automatico?.available && automatico.brand_id === marca && <LinhaDoAutomaticoDoDirect r={automatico} aoAbrir={() => setGavetaDoAutomatico(true)} />}
        {estado === 'primeira' ? (
          <div className="card">
            <Estado icone="refresh" titulo="Lendo as conversas pela primeira vez">
              O Liame traz as conversas mais recentes do {conta}. Leva até 2 minutos; a tela atualiza sozinha.
            </Estado>
          </div>
        ) : (
          <>
            <div className="dir-barra">
              <div className="dir-filtros" role="group" aria-label="Situação das conversas">
                {FILTROS_DO_DIRECT.map(([id, rotulo]) => (
                  <button key={id} className="chip" type="button" id={`dir-filtro-${id}`} aria-pressed={filtro === id} onClick={() => setFiltro(id)}>
                    {rotulo}
                    {dados && <span className="num">{dados.counts[id]}</span>}
                  </button>
                ))}
              </div>
              {dois && (
                <div className="dir-filtros" role="group" aria-label="Canal">
                  {CANAIS_DO_DIRECT.map(([id, rotulo]) => (
                    <button key={id} className="chip" type="button" id={`dir-canal-${id}`} aria-pressed={canal === id} onClick={() => setCanal(id)}>
                      {id !== 'todos' && <Icone nome={id === 'messenger' ? 'facebook' : 'instagram'} pequeno />}
                      {rotulo}
                    </button>
                  ))}
                </div>
              )}
              <div className="dir-busca">
                <Icone nome="search" />
                <label className="sr-only" htmlFor="dir-busca">
                  Buscar nas conversas
                </label>
                <input className="input" id="dir-busca" type="search" placeholder={dois ? 'Buscar pelo @, nome ou mensagem' : 'Buscar pelo @ ou pela mensagem'} value={busca} autoComplete="off" onChange={(e) => setBusca(e.target.value)} />
              </div>
            </div>
            <div className={`dir-caixa${comConversa ? ' com-conversa' : ''}`} ref={caixa}>
              <div className="dir-dupla">
                <div className="dir-lado-lista">
                  {lista.tipo === 'erro' ? (
                    <Estado
                      icone="alert-circle"
                      perigo
                      compacto
                      titulo="Não deu para carregar as conversas"
                      acao={
                        <div className="vazio-acoes">
                          <button className="btn btn--sm" type="button" onClick={lerDeNovo}>
                            Tentar de novo
                          </button>
                        </div>
                      }
                    >
                      {mensagemDe(lista.problema)}
                    </Estado>
                  ) : !dados ? (
                    <p className="campo-dica dir-carregando" aria-busy="true">
                      Carregando as conversas…
                    </p>
                  ) : dados.items.length === 0 ? (
                    <Estado icone={buscando ? 'search' : 'check-circle'} titulo={vazio.titulo} compacto>
                      {vazio.texto}
                    </Estado>
                  ) : (
                    <ul className="dir-lista" aria-label="Conversas">
                      {dados.items.map((c) => {
                        const selo = seloDaSituacao(c, agora);
                        const tipo = tipoDaConversa(c.kind);
                        return (
                          <li key={c.id}>
                            <button
                              className={`dir-linha${c.unread ? ' nao-lida' : ''}`}
                              type="button"
                              data-dir-abrir={c.id}
                              aria-current={aberta === c.id}
                              onClick={() => {
                                setAberta(c.id);
                                setComConversa(true);
                                // No estreito, a conversa toma o lugar da lista: o foco vai para o nome de quem escreveu.
                                setFocarConversa((caixa.current?.clientWidth ?? 0) <= 720);
                              }}
                            >
                              {c.unread && <span className="dir-nao-lida" aria-hidden="true" />}
                              <span className="dir-av" aria-hidden="true">
                                {iniciaisDe(c.username, c.name)}
                              </span>
                              <span className="dir-linha-corpo">
                                <span className="dir-linha-cab">
                                  {/* O ícone do canal mora dentro do nome: o nome longo quebra com ele, sem deixar o ícone sozinho na linha. */}
                                  <span className="dir-nome">
                                    {dois && (
                                      <span className="dir-canal" aria-hidden="true">
                                        <Icone nome={c.channel === 'messenger' ? 'facebook' : 'instagram'} pequeno />
                                      </span>
                                    )}
                                    {quemEscreveu(c.username, c.name)}
                                  </span>
                                  <span className="dir-hora">{horaOuDia(c.last_message_at, agora)}</span>
                                </span>
                                <span className="dir-previa">{previaDaConversa(c)}</span>
                                {(selo || tipo) && (
                                  <span className="dir-selos">
                                    {tipo && <span className={`st ${tipo.classe}`}>{tipo.rotulo}</span>}
                                    {selo && <span className={`st ${selo.classe}`}>{selo.texto}</span>}
                                  </span>
                                )}
                                {dois && <span className="sr-only">, pelo {c.channel === 'messenger' ? 'Messenger' : 'Instagram'}</span>}
                                {c.unread && <span className="sr-only">, não lida</span>}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
                <section className="dir-lado-conversa" aria-labelledby="dir-conv-t">
                  {aberta && marca ? (
                    <ConversaDoDirect
                      key={aberta}
                      marca={marca}
                      marcaNome={marcaNome}
                      id={aberta}
                      leitura={tentativa}
                      focar={focarConversa}
                      agora={agora}
                      podeResponder={podeResponder}
                      garantirAtendimento={garantirAtendimento}
                      atendimentoVenceu={atendimentoVenceu}
                      aoMudar={lerDeNovo}
                      aoVoltar={() => {
                        setComConversa(false);
                        const b = caixa.current?.querySelector<HTMLElement>(`[data-dir-abrir="${CSS.escape(aberta)}"]`);
                        setTimeout(() => b?.focus(), 0);
                      }}
                      avisar={avisar}
                    />
                  ) : (
                    <div className="dir-conv-vazia">
                      <Estado icone="message" titulo="Escolha uma conversa" compacto>
                        A conversa aparece aqui, com a resposta.
                      </Estado>
                    </div>
                  )}
                </section>
              </div>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <section aria-labelledby="h-direct">
      <div className="view-cab anima" style={{ ['--i' as string]: 0 }}>
        <div>
          <h1 id="h-direct" ref={titulo} tabIndex={-1}>
            {nome}
          </h1>
          <p>
            {nome === 'Direct e Messenger'
              ? 'As mensagens que as pessoas mandam para o Instagram e para a Página da sua marca, para a equipe responder por aqui.'
              : 'As mensagens que as pessoas mandam para o Instagram da sua marca, para a equipe responder por aqui.'}
          </p>
        </div>
      </div>
      {marcas && marcas.length > 1 && (
        <div className="av-filtros">
          <label className="res-campo">
            <span>Marca</span>
            <select
              className="input"
              id="dir-marca"
              value={marca ?? ''}
              onChange={(e) => {
                setMarca(e.target.value);
                setAberta(null);
                setCanal('todos');
                setComConversa(false);
              }}
            >
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
      {pedido === 'turno' && (
        <DialogoDeConfirmar
          titulo="Abrir o atendimento"
          rotulo="Abrir e mandar"
          reserva={titulo}
          aoConfirmar={abrirAtendimento}
          aoFechar={() => {
            // Fechar sem confirmar desiste da resposta (o texto fica na conversa).
            esperaAtendimento.current?.(false);
            esperaAtendimento.current = null;
            setPedido(null);
          }}
        >
          <p>Com o atendimento aberto, as suas respostas no Direct saem sem pedir a confirmação de novo por 8 horas, ou até você fechar. Cada mensagem fica na auditoria com o seu nome.</p>
        </DialogoDeConfirmar>
      )}
      {pedido === 'ligar' && (
        <DialogoDeConfirmar titulo="Ligar o Direct no Liame" rotulo="Ligar o Direct" reserva={titulo} aoConfirmar={ligar} aoFechar={() => setPedido(null)}>
          <p>As mensagens do {conta} passam a chegar aqui. Ligar fica na auditoria, com o seu nome.</p>
        </DialogoDeConfirmar>
      )}
      {pedido === 'messenger' && (
        <DialogoDeConfirmar titulo="Ligar o Messenger no Liame" rotulo="Ligar o Messenger" reserva={titulo} aoConfirmar={ligarMessenger} aoFechar={() => setPedido(null)}>
          <p>As mensagens do Messenger da {pagina} passam a chegar aqui, junto do Direct. Ligar fica na auditoria, com o seu nome.</p>
        </DialogoDeConfirmar>
      )}
      {gavetaDoAutomatico && automatico && (
        <GavetaDoAutomaticoDoDirect
          r={automatico}
          reserva={titulo}
          aoSalvar={(novo, aviso) => {
            setAutomatico(novo);
            avisar(aviso);
          }}
          aoFechar={() => setGavetaDoAutomatico(false)}
        />
      )}
    </section>
  );
}

/** "14:05" hoje; "ontem"; "dom."; "10/11". */
function horaOuDia(iso: string, agora: Date): string {
  const d = new Date(iso);
  const dias = Math.round((new Date(agora.getFullYear(), agora.getMonth(), agora.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86_400_000);
  if (dias <= 0) return horaDe(iso);
  if (dias === 1) return 'ontem';
  if (dias < 7) return d.toLocaleDateString('pt-BR', { weekday: 'short' });
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

function Nota({ icone, texto }: { icone: 'check' | 'info' | 'message'; texto: string }) {
  return (
    <p className="nota">
      <Icone nome={icone} />
      <span>{texto}</span>
    </p>
  );
}

function Passo({ n, titulo, ok = false, children }: { n: number; titulo: string; ok?: boolean; children: ReactNode }) {
  return (
    <li className={`dir-passo${ok ? ' dir-passo--ok' : ''}`}>
      <span className="dir-passo-n" aria-hidden="true">
        {n}
      </span>
      <div className="dir-passo-corpo">
        <b>{titulo}</b>
        <div>{children}</div>
      </div>
    </li>
  );
}
