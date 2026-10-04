'use client';

import type { AutonomyItem, AutonomyResponse, BrandResponse, TeamResponse, TeamShadowResponse } from '@liame/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAvisar } from '@/components/ui/avisos';
import { Estado } from '@/components/ui/estado';
import { Icone } from '@/components/ui/icone';
import { useAgora } from '@/lib/agora';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { useModo } from '@/lib/modo';
import { useSessao } from '@/lib/sessao';
import type { Historico } from './bloco-historico';
import { EquipeConteudo } from './equipe-conteudo';
import { acaoDa, type ChaveDoMembro, ehMembro, FICHAS, plataformaDe, PROXIMAS_FASES } from './textos';

// "Sua equipe" (mockups/prototipo-equipe.html, P7 aprovado em 03/10/2026). Quem vê é quem acompanha campanhas e
// vendas; desligar e ligar um funcionário pede `agentes.gerenciar`; parar e retomar a equipe é a parada da empresa
// (`parada.acionar`); a promoção de Sombra para Sugerir é de quem gerencia as políticas. Os números e a situação
// vêm de `/v1/team`; a sombra, de `/v1/team/shadow`; a prontidão, de `/v1/autonomy`; e "O que fez", de
// `/v1/team/members/:key/activity`, pedido quando o funcionário é escolhido.

type Carga =
  | { tipo: 'carregando' }
  | { tipo: 'ok'; equipe: TeamResponse; autonomia: AutonomyResponse | null; sombra: TeamShadowResponse | null; marca: string }
  | { tipo: 'erro'; problema: Problema };

/** O motivo gravado na parada da empresa acionada por esta tela (a parada pede um). */
const MOTIVO_DA_PARADA = 'Equipe parada pela tela Sua equipe.';

export function EquipeTela() {
  const { pode } = useSessao();
  const { modo, definir } = useModo();
  const avisar = useAvisar();
  const podeVer = pode('campanhas.ver') && pode('vendas.ver');
  const titulo = useRef<HTMLHeadingElement>(null);
  const [marcas, setMarcas] = useState<BrandResponse[] | null>(null);
  const [erroMarcas, setErroMarcas] = useState<Problema | null>(null);
  const [marca, setMarca] = useState<string | null>(null);
  const [carga, setCarga] = useState<Carga>({ tipo: 'carregando' });
  const [tentativa, setTentativa] = useState(0);
  const [historicos, setHistoricos] = useState<Record<string, Historico>>({});
  const [escolhido, setEscolhido] = useState<string>('lia');
  const [mostraDetalhe, setMostraDetalhe] = useState(false);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [parando, setParando] = useState(false);
  const [desligando, setDesligando] = useState<string | null>(null);
  const [recusando, setRecusando] = useState<string | null>(null);
  const [anuncio, setAnuncio] = useState('');
  /** O elemento que recebe o foco depois da próxima pintura (pelo id). */
  const focar = useRef<string | null>(null);
  const seq = useRef(0);
  const agora = useAgora(60_000, carga.tipo === 'ok' ? carga.equipe.generated_at : null);

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
    setHistoricos({});
    setParando(false);
    setDesligando(null);
    setRecusando(null);
    const query = { brand_id: marca };
    disparar(
      Promise.all([
        chamar(() => api.GET('/v1/team', { params: { query } })),
        // A prontidão e a lista da sombra são do detalhe do Gestor de tráfego: se uma delas falhar, a equipe abre do
        // mesmo jeito e o bloco diz que não carregou.
        chamar(() => api.GET('/v1/autonomy', { params: { query } })),
        chamar(() => api.GET('/v1/team/shadow', { params: { query } })),
      ]).then(([e, a, s]) => {
        // Só a resposta mais nova vale (trocar de marca no meio de uma leitura não mistura as equipes).
        if (id !== seq.current) return;
        setCarga(e.ok ? { tipo: 'ok', equipe: e.data, autonomia: a.ok ? a.data : null, sombra: s.ok ? s.data : null, marca } : { tipo: 'erro', problema: e.problema });
      }),
    );
  }, [marca, tentativa]);

  const carregarHistorico = useCallback(async (chave: ChaveDoMembro, brandId: string) => {
    const id = seq.current;
    setHistoricos((h) => ({ ...h, [chave]: { tipo: 'carregando' } }));
    const r = await chamar(() => api.GET('/v1/team/members/{key}/activity', { params: { path: { key: chave }, query: { brand_id: brandId, limit: 20 } } }));
    if (id !== seq.current) return;
    setHistoricos((h) => ({ ...h, [chave]: r.ok ? { tipo: 'ok', dados: r.data } : { tipo: 'erro' } }));
  }, []);

  // "O que fez" é pedido quando o funcionário é escolhido, uma vez por marca (as ações desta tela pedem de novo).
  const marcaCarregada = carga.tipo === 'ok' ? carga.marca : null;
  const temHistorico = historicos[escolhido] !== undefined;
  useEffect(() => {
    if (!marcaCarregada || !ehMembro(escolhido) || temHistorico) return;
    disparar(carregarHistorico(escolhido, marcaCarregada));
  }, [marcaCarregada, escolhido, temHistorico, carregarHistorico]);

  // O foco depois de uma ação vai para o que mudou (o botão que desfaz, ou o título do detalhe).
  useEffect(() => {
    const alvo = focar.current;
    if (!alvo) return;
    const el = alvo === 'titulo' ? titulo.current : document.getElementById(alvo);
    if (!el) return;
    focar.current = null;
    el.focus({ preventScroll: alvo !== 'titulo' });
  });

  if (!podeVer) {
    return (
      <Estado icone="lock" titulo="Sua equipe é de quem acompanha as campanhas e as vendas">
        O seu nível nesta empresa não mostra os funcionários de IA. Se precisar, peça ao dono da conta.
      </Estado>
    );
  }

  function tentarDeNovo() {
    focar.current = 'titulo';
    if (erroMarcas) disparar(carregarMarcas());
    else setTentativa((t) => t + 1);
  }

  if (erroMarcas || carga.tipo === 'erro') {
    const problema = erroMarcas ?? (carga.tipo === 'erro' ? carga.problema : null);
    return (
      <section aria-labelledby="h-equipe">
        <h1 className="sr-only" id="h-equipe" ref={titulo} tabIndex={-1}>
          Sua equipe
        </h1>
        <div className="card">
          <Estado
            icone="alert-circle"
            perigo
            titulo="Não foi possível carregar a equipe"
            acao={
              <div className="vazio-acoes">
                <button className="btn btn--primary" type="button" onClick={tentarDeNovo}>
                  <Icone nome="refresh" />
                  Tentar de novo
                </button>
              </div>
            }
          >
            {problema ? mensagemDe(problema) : 'Tente de novo em instantes.'} Nada foi perdido, e nenhum funcionário parou por isso.
          </Estado>
        </div>
      </section>
    );
  }
  if (marcas && !marcas.length) {
    return (
      <div className="card">
        <Estado icone="info" titulo="Nenhuma marca ativa nesta empresa">
          A equipe trabalha por marca: quando a empresa tiver uma marca ativa, os funcionários aparecem aqui.
        </Estado>
      </div>
    );
  }
  if (carga.tipo !== 'ok') return <EquipeCarregando />;

  const { equipe, autonomia, sombra } = carga;
  const brandId = carga.marca;
  const query = { brand_id: brandId };
  const nomeDaMarca = marcas?.find((m) => m.id === brandId)?.name ?? 'sua marca';

  /** A equipe de agora (a situação muda com a parada e com desligar ou ligar). */
  async function recarregarEquipe(): Promise<boolean> {
    const id = seq.current;
    const r = await chamar(() => api.GET('/v1/team', { params: { query } }));
    if (id !== seq.current) return false;
    if (r.ok) setCarga((c) => (c.tipo === 'ok' ? { ...c, equipe: r.data } : c));
    return r.ok;
  }

  /** A prontidão de agora, e o histórico do Gestor de tráfego pedido de novo (a decisão entra nele). */
  async function recarregarAutonomia() {
    const id = seq.current;
    const r = await chamar(() => api.GET('/v1/autonomy', { params: { query } }));
    if (id !== seq.current) return;
    if (r.ok) setCarga((c) => (c.tipo === 'ok' ? { ...c, autonomia: r.data } : c));
    disparar(carregarHistorico('trafego', brandId));
  }

  const falhou = (problema: Problema) => avisar(mensagemDe(problema), { tipo: 'perigo' });

  async function parar() {
    setOcupado('parar');
    const r = await chamar(() => api.POST('/v1/kill-switches', { body: { level: 'tenant', reason: MOTIVO_DA_PARADA } }));
    if (r.ok) {
      setParando(false);
      focar.current = 'eqp-bt-retomar';
      await recarregarEquipe();
      avisar('Equipe parada. Nenhum funcionário de IA trabalha até você retomar.', { tipo: 'perigo' });
      setAnuncio('Equipe parada.');
    } else falhou(r.problema);
    setOcupado(null);
  }

  async function retomar() {
    const parada = equipe.stop;
    if (!parada) return;
    setOcupado('retomar');
    const r = await chamar(() => api.DELETE('/v1/kill-switches/{id}', { params: { path: { id: parada.id } } }));
    if (r.ok) {
      focar.current = 'eqp-bt-parar';
      await recarregarEquipe();
      avisar('A equipe voltou ao trabalho.');
      setAnuncio('A equipe voltou ao trabalho.');
    } else falhou(r.problema);
    setOcupado(null);
  }

  async function desligar(chave: ChaveDoMembro, motivo: string) {
    setOcupado(`desligar:${chave}`);
    const r = await chamar(() => api.POST('/v1/team/members/{key}/pause', { params: { path: { key: chave } }, body: { brand_id: brandId, ...(motivo ? { reason: motivo } : {}) } }));
    if (r.ok) {
      setDesligando(null);
      focar.current = 'eqp-bt-ligar';
      setCarga((c) => (c.tipo === 'ok' ? { ...c, equipe: r.data } : c));
      disparar(carregarHistorico(chave, brandId));
      avisar(`${FICHAS[chave].nome}: desligado. Dá para ligar de novo quando quiser.`);
      setAnuncio(`${FICHAS[chave].nome} desligado.`);
    } else falhou(r.problema);
    setOcupado(null);
  }

  async function ligar(chave: ChaveDoMembro) {
    setOcupado(`ligar:${chave}`);
    const r = await chamar(() => api.POST('/v1/team/members/{key}/resume', { params: { path: { key: chave } }, body: { brand_id: brandId } }));
    if (r.ok) {
      focar.current = 'eqp-bt-desligar';
      setCarga((c) => (c.tipo === 'ok' ? { ...c, equipe: r.data } : c));
      disparar(carregarHistorico(chave, brandId));
      avisar(`${FICHAS[chave].nome}: ligado de novo.`);
      setAnuncio(`${FICHAS[chave].nome} ligado de novo.`);
    } else falhou(r.problema);
    setOcupado(null);
  }

  async function aprovar(a: AutonomyItem) {
    const id = a.proposal?.id;
    if (!id) return;
    setOcupado(`aprovar:${id}`);
    const r = await chamar(() => api.POST('/v1/autonomy/proposals/{id}/approve', { params: { path: { id } } }));
    if (r.ok) {
      focar.current = `eqp-bt-voltar-${a.connected_account_id}:${a.tool}`;
      await recarregarAutonomia();
      avisar(`Promoção aprovada. As recomendações de ${acaoDa(a.tool, null)} na conta ${a.account_name} (${plataformaDe(a.provider)}) passam a aparecer na Atenção.`);
      setAnuncio('Promoção aprovada.');
    } else falhou(r.problema);
    setOcupado(null);
  }

  async function recusar(a: AutonomyItem) {
    const id = a.proposal?.id;
    if (!id) return;
    setOcupado(`recusar:${id}`);
    const r = await chamar(() => api.POST('/v1/autonomy/proposals/{id}/reject', { params: { path: { id } }, body: {} }));
    if (r.ok) {
      setRecusando(null);
      focar.current = 'eqp-det-t';
      await recarregarAutonomia();
      avisar('Promoção recusada. Ele segue em sombra.');
      setAnuncio('Promoção recusada.');
    } else falhou(r.problema);
    setOcupado(null);
  }

  async function voltarParaSombra(a: AutonomyItem) {
    const tool = a.tool as 'orcamento_reduzir' | 'campanha_pausar' | 'orcamento_aumentar';
    setOcupado(`voltar:${a.connected_account_id}:${a.tool}`);
    const r = await chamar(() => api.POST('/v1/autonomy/undo', { body: { connected_account_id: a.connected_account_id, tool } }));
    if (r.ok) {
      focar.current = 'eqp-det-t';
      await recarregarAutonomia();
      avisar('De volta para sombra. Nada mais aparece na Atenção por ele nessa ação.');
      setAnuncio('De volta para sombra.');
    } else falhou(r.problema);
    setOcupado(null);
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

  return (
    <section aria-labelledby="h-equipe">
      <EquipeConteudo
        t={equipe}
        autonomia={autonomia}
        sombra={sombra}
        historicos={historicos}
        escolhido={escolhido}
        mostraDetalhe={mostraDetalhe}
        modo={modo}
        agora={agora}
        nomeDaMarca={nomeDaMarca}
        seletor={seletor}
        tituloRef={titulo}
        topo={{
          ocupado,
          parando,
          aoPedirParada: (pedir) => {
            setParando(pedir);
            if (!pedir) focar.current = 'eqp-bt-parar';
          },
          aoParar: () => disparar(parar()),
          aoRetomar: () => disparar(retomar()),
        }}
        membro={{
          ocupado,
          desligando,
          aoPedirDesligar: (chave) => {
            setDesligando(chave);
            if (!chave) focar.current = 'eqp-bt-desligar';
          },
          aoDesligar: (chave, motivo) => disparar(desligar(chave, motivo)),
          aoLigar: (chave) => disparar(ligar(chave)),
          aoIrParaPro: () => definir('pro'),
          aoRecarregarHistorico: (chave) => disparar(carregarHistorico(chave, brandId)),
        }}
        prontidao={{
          ocupado,
          recusando,
          aoAprovar: (a) => disparar(aprovar(a)),
          aoPedirRecusa: (id) => {
            if (!id && recusando) focar.current = `eqp-bt-recusar-${recusando}`;
            setRecusando(id);
          },
          aoRecusar: (a) => disparar(recusar(a)),
          aoVoltarParaSombra: (a) => disparar(voltarParaSombra(a)),
        }}
        aoEscolher={(chave) => {
          setEscolhido(chave);
          setMostraDetalhe(true);
          setDesligando(null);
          setRecusando(null);
          focar.current = 'eqp-det-t';
          setAnuncio(ehMembro(chave) ? FICHAS[chave].nome : (PROXIMAS_FASES.find((f) => f.chave === chave)?.nome ?? ''));
        }}
        aoVoltar={() => {
          setMostraDetalhe(false);
          focar.current = `eqp-item-${escolhido}`;
        }}
      />
      <p className="sr-only" role="status" aria-live="polite">
        {anuncio}
      </p>
    </section>
  );
}

function EquipeCarregando() {
  return (
    <section aria-labelledby="h-equipe" aria-busy="true">
      <h1 className="sr-only" id="h-equipe" tabIndex={-1}>
        Sua equipe
      </h1>
      <p className="sr-only">Carregando a equipe…</p>
      <div className="eqp-grade" aria-hidden="true">
        <div className="card">
          <span className="esqueleto" />
          <span className="esqueleto" />
          <span className="esqueleto esqueleto--medio" />
        </div>
        <div className="card">
          <span className="esqueleto esqueleto--curto" />
          <span className="esqueleto" />
          <span className="esqueleto esqueleto--bloco" />
        </div>
      </div>
    </section>
  );
}
