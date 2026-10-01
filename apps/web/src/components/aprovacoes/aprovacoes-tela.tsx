'use client';

import type { ActionResponse } from '@liame/contracts';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAvisar } from '@/components/ui/avisos';
import { Estado } from '@/components/ui/estado';
import { Icone } from '@/components/ui/icone';
import { useAgora } from '@/lib/agora';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import { useContadorAprovacoes } from '@/lib/contador-aprovacoes';
import { disparar } from '@/lib/disparar';
import { iniciais } from '@/lib/formato';
import { useModo } from '@/lib/modo';
import { useSessao } from '@/lib/sessao';
import { type Decisao, DetalhePedido } from './detalhe-pedido';
import { agrupar, apresentar, avisoDepoisDeAprovar, erroDaDecisao, etiquetaDoDecidido, type Grupo, grupoDe, pedidoDaUrl, prazoDe, riscoDe, ROTULO_GRUPO, ROTULO_RISCO } from './textos';

// "Aprovações" (mockups/prototipo-app.html, vista "aprovacoes"): à esquerda, os pedidos que esperam alguém,
// o que a política fez sozinha e o que foi decidido hoje; à direita, o pedido aberto. Aprovar pede o código do
// app autenticador e vale só para o plano mostrado; recusar pede um motivo (`GET /v1/actions`,
// `POST /v1/actions/{id}/approve` e `/reject`; decidir exige `acoes.aprovar`).

type Carga = { tipo: 'carregando' } | { tipo: 'ok'; itens: ActionResponse[] } | { tipo: 'erro'; problema: Problema };

const GRUPOS: Grupo[] = ['pendente', 'auto', 'feito'];
/** A fila anda sozinha: outra pessoa pode decidir, o worker executa, o prazo vence. */
const ATUALIZAR_MS = 30_000;

export function AprovacoesTela() {
  const { me, pode } = useSessao();
  // O link do e-mail ("uma ação espera a sua aprovação") e a faixa da aba Cupons abrem a tela já no pedido.
  const inicial = pedidoDaUrl(useSearchParams().get('pedido'));
  const avisar = useAvisar();
  const pro = useModo().modo === 'pro';
  const definirContador = useContadorAprovacoes().definir;
  const podeVer = pode('campanhas.ver');
  const podeDecidir = pode('acoes.aprovar');
  const temApp = me.mfa !== 'not_configured';
  const tituloDoDetalhe = useRef<HTMLHeadingElement>(null);
  const campoCodigo = useRef<HTMLInputElement>(null);
  const lista = useRef<HTMLDivElement>(null);
  const [carga, setCarga] = useState<Carga>({ tipo: 'carregando' });
  /** O pedido do endereço (`/aprovacoes?pedido={id}`) que não veio na lista dos mais recentes. */
  const [avulso, setAvulso] = useState<ActionResponse | null>(null);
  const [sel, setSel] = useState<string | null>(inicial ?? null);
  /** No celular a tela é uma coluna só: a lista, ou o pedido aberto. */
  const [noDetalhe, setNoDetalhe] = useState(Boolean(inicial));
  const [tentativa, setTentativa] = useState(0);
  const agora = useAgora(60_000, carga);
  const seq = useRef(0);

  const carregar = useCallback(async () => {
    const id = ++seq.current;
    const r = await chamar(() => api.GET('/v1/actions'));
    if (id !== seq.current) return;
    if (!r.ok) return setCarga((c) => (c.tipo === 'ok' ? c : { tipo: 'erro', problema: r.problema }));
    setCarga({ tipo: 'ok', itens: r.data.items });
    definirContador(r.data.items.filter((a) => a.status === 'aguardando_aprovacao').length);
    if (inicial && !r.data.items.some((a) => a.id === inicial)) {
      const um = await chamar(() => api.GET('/v1/actions/{id}', { params: { path: { id: inicial } } }));
      if (id === seq.current) setAvulso(um.ok ? um.data : null);
    }
    // `definirContador` é estável (o `setState` do provedor); `inicial` vem da rota.
  }, [inicial, definirContador]);

  useEffect(() => {
    if (!podeVer) return;
    disparar(carregar());
    const t = setInterval(() => disparar(carregar()), ATUALIZAR_MS);
    return () => clearInterval(t);
  }, [podeVer, carregar, tentativa]);

  const itens = carga.tipo === 'ok' ? carga.itens : [];
  const grupos = agrupar(itens, agora);
  const ordem = GRUPOS.flatMap((g) => grupos[g]);
  const aberta = ordem.find((a) => a.id === sel) ?? (avulso && avulso.id === sel ? avulso : null) ?? grupos.pendente[0] ?? null;
  const grupoDaAberta = aberta ? grupoDe(aberta, agora) : null;

  const abrir = useCallback((id: string, focar: boolean) => {
    setSel(id);
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
        const i = ordem.findIndex((a) => a.id === aberta?.id);
        const novo = ordem[Math.max(0, Math.min(ordem.length - 1, i + (k === 'j' ? 1 : -1)))];
        if (!novo || novo.id === aberta?.id) return;
        e.preventDefault();
        setSel(novo.id);
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

  /** Depois de decidir: a lista volta a ler, a fila anda para o próximo pedido e o foco vai para o título dele. */
  async function depoisDeDecidir(decidida: ActionResponse) {
    const proximo = grupos.pendente.find((a) => a.id !== decidida.id);
    setSel(proximo?.id ?? decidida.id);
    await carregar();
    requestAnimationFrame(() => tituloDoDetalhe.current?.focus({ preventScroll: true }));
  }

  function recusaDoServidor(problema: Problema): Decisao {
    const erro = erroDaDecisao(problema);
    if (erro.recarregar) setTentativa((n) => n + 1);
    return { ok: false, texto: problema.errors?.length ? mensagemDe(problema) : erro.texto, noCodigo: erro.noCodigo };
  }

  async function aprovar(acao: ActionResponse, codigo: string): Promise<Decisao> {
    const r = await chamar(() => api.POST('/v1/actions/{id}/approve', { params: { path: { id: acao.id } }, body: { plan_hash: acao.plan_hash, code: codigo } }));
    if (!r.ok) return recusaDoServidor(r.problema);
    avisar(avisoDepoisDeAprovar(apresentar(acao), r.data));
    await depoisDeDecidir(acao);
    return { ok: true };
  }

  async function recusar(acao: ActionResponse, motivo: string): Promise<Decisao> {
    const r = await chamar(() => api.POST('/v1/actions/{id}/reject', { params: { path: { id: acao.id } }, body: { plan_hash: acao.plan_hash, reason: motivo } }));
    if (!r.ok) return recusaDoServidor(r.problema);
    avisar('Recusado. Quem pediu vê o motivo, e nada foi executado.');
    await depoisDeDecidir(acao);
    return { ok: true };
  }

  const item = (a: ActionResponse, g: Grupo) => {
    const p = apresentar(a);
    const risco = riscoDe(a);
    return (
      <li key={a.id}>
        <button className="ap-item" type="button" aria-current={a.id === aberta?.id ? 'true' : undefined} onClick={() => abrir(a.id, true)}>
          <span className="ap-av" aria-hidden="true">
            {iniciais(a.requested_by.name)}
          </span>
          <span>
            <span className="ap-titulo">{p.titulo}</span>
            <span className="ap-meta">
              {g === 'pendente' ? (
                <>
                  {p.impacto && <span className="dinheiro">{p.impacto}</span>}
                  <span className={`risco risco--${risco}`}>{ROTULO_RISCO[risco]}</span>
                  <span>{prazoDe(a, agora)}</span>
                </>
              ) : (
                <>
                  <span>{a.requested_by.name}</span>
                  <span>{etiquetaDoDecidido(a)}</span>
                </>
              )}
            </span>
          </span>
        </button>
      </li>
    );
  };

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
                    <span>{g === 'pendente' && !podeDecidir ? 'Esperando aprovação' : ROTULO_GRUPO[g]}</span>
                    <span>{doGrupo.length}</span>
                  </p>
                  {doGrupo.length ? <ul>{doGrupo.map((a) => item(a, g))}</ul> : <p className="ap-vazio-mini">{podeDecidir ? 'Nada esperando você agora.' : 'Nenhum pedido esperando aprovação.'}</p>}
                </div>
              );
            })}
          </div>
          <article className="card inbox-det" aria-labelledby="ap-det-titulo">
            {aberta ? (
              <DetalhePedido
                acao={aberta}
                grupo={grupoDaAberta}
                agora={agora}
                pro={pro}
                podeDecidir={podeDecidir}
                temApp={temApp}
                titulo={tituloDoDetalhe}
                campoCodigo={campoCodigo}
                aoVoltar={() => {
                  setNoDetalhe(false);
                  // O foco volta ao pedido que estava aberto (ou ao primeiro da lista).
                  requestAnimationFrame(() => (lista.current?.querySelector<HTMLElement>('.ap-item[aria-current="true"]') ?? lista.current?.querySelector<HTMLElement>('.ap-item'))?.focus());
                }}
                aoAprovar={aprovar}
                aoRecusar={recusar}
              />
            ) : (
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
                  <p>{podeDecidir ? 'Nada espera o seu ok agora. Quando alguém pedir uma ação que precisa de aprovação, ela aparece aqui.' : 'Nenhum pedido espera aprovação agora.'}</p>
                  <div className="vazio-acoes">
                    <Link className="btn" href="/atencao">
                      Voltar para Atenção
                    </Link>
                  </div>
                </div>
              </>
            )}
          </article>
        </div>
      )}
    </section>
  );
}
