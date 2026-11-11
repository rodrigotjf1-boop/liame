'use client';

import type { ActionResponse, AdPieceResponse, BrandPhoto, NewCampaignResponse } from '@liame/contracts';
import { type RefObject, useCallback, useEffect, useId, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { PreviaDoAnuncio } from '@/components/criativos/gaveta-campanha-nova';
import { ehVideo, idDaCampanhaNova, kmEscrito, linkDoGerenciador, OBJETIVOS, passosDaCriacao, situacaoDaCampanha } from '@/components/criativos/campanha-nova-textos';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import type { Prova } from '@/lib/chave-de-acesso';
import { disparar } from '@/lib/disparar';
import { reaisDeMicros } from '@/lib/formato';
import { BarraDaDecisao, type Decisao } from './barra-da-decisao';
import { cabecalhoDe, type Grupo, MOTIVOS_DA_RECUSA, politicaDe, prazoDe, resultadoDe } from './textos';

// O pedido da campanha nova em Aprovações (A4, X5, parte 5; P42 aprovado em 11/11/2026; D-A4-44 e D-A4-45): criar
// pausada (a prévia do anúncio, quem assina, o raio e a verba), a criação passo a passo, criada e pausada (o que existe
// na Meta e "Pedir para ativar"), não criada (o motivo da Meta) e ativar (os limites; a volta é pausar).

type Props = {
  acao: ActionResponse;
  grupo: Grupo | null;
  agora: Date;
  podeDecidir: boolean;
  podeOperar: boolean;
  temApp: boolean;
  temChave?: boolean;
  /** As fotos das marcas dos pedidos (a mídia da campanha), quando quem vê pode ver as Fotos. */
  fotos: Map<string, BrandPhoto>;
  titulo: RefObject<HTMLHeadingElement | null>;
  campoCodigo: RefObject<HTMLInputElement | null>;
  aoVoltar: () => void;
  aoAprovar: (acao: ActionResponse, prova: Prova) => Promise<Decisao>;
  aoRecusar: (acao: ActionResponse, motivo: string) => Promise<Decisao>;
  /** Pede para ativar a campanha criada e pausada: devolve o problema, ou nulo quando o pedido foi criado. */
  aoPedirAtivar: (campanha: string) => Promise<Problema | null>;
};

type Lida = { estado: 'lendo' } | { estado: 'ok'; c: NewCampaignResponse; peca: AdPieceResponse | null } | { estado: 'erro'; problema: Problema };

const MOTIVOS = MOTIVOS_DA_RECUSA.map((m) => ({ valor: m, rotulo: m }));
/** Enquanto a campanha está sendo criada, a tela pergunta de novo neste intervalo. */
const ESPERA_MS = 10_000;

export function DetalheCampanhaNova({ acao, grupo, agora, podeDecidir, podeOperar, temApp, temChave = false, fotos, titulo, campoCodigo, aoVoltar, aoAprovar, aoRecusar, aoPedirAtivar }: Props) {
  const ids = useId();
  const id = idDaCampanhaNova(acao.resource_id);
  const [lida, setLida] = useState<Lida>({ estado: 'lendo' });
  const [aba, setAba] = useState<'instagram' | 'facebook'>('instagram');
  const [ativando, setAtivando] = useState(false);
  const [erroAtivar, setErroAtivar] = useState<string | null>(null);
  const cab = cabecalhoDe(acao, agora);
  const criar = acao.tool === 'campanha_criar';
  const ativar = acao.tool === 'campanha_nova_ativar';

  const ler = useCallback(async () => {
    if (!id) return;
    const r = await chamar(() => api.GET('/v1/new-campaigns/{id}', { params: { path: { id } } }));
    if (!r.ok) return setLida({ estado: 'erro', problema: r.problema });
    const p = await chamar(() => api.GET('/v1/ad-pieces/{id}', { params: { path: { id: r.data.piece_id } } }));
    setLida({ estado: 'ok', c: r.data, peca: p.ok ? p.data : null });
  }, [id]);

  useEffect(() => {
    setLida({ estado: 'lendo' });
    setErroAtivar(null);
    disparar(ler());
  }, [ler, acao.status, acao.updated_at]);

  // Criando na Meta (o vídeo leva até 15 minutos): a tela pergunta de novo até terminar.
  const criando = lida.estado === 'ok' && lida.c.status === 'criando';
  useEffect(() => {
    if (!criando) return;
    const t = setInterval(() => disparar(ler()), ESPERA_MS);
    return () => clearInterval(t);
  }, [criando, ler]);

  async function pedirAtivar(c: NewCampaignResponse) {
    setAtivando(true);
    setErroAtivar(null);
    const problema = await aoPedirAtivar(c.id);
    setAtivando(false);
    if (problema) setErroAtivar(mensagemDe(problema));
  }

  const voltar = (
    <button className="btn btn--ghost btn--sm voltar" type="button" onClick={aoVoltar}>
      <Icone nome="chevron-left" />
      Voltar para a lista
    </button>
  );
  const nomeDaCampanha = lida.estado === 'ok' ? lida.c.name : 'a campanha nova';
  const cabecalho = (
    <>
      <div className="det-cab">
        <span>
          <b>{cab.quem}</b> {cab.verbo}
        </span>
        <span>· {cab.quando}</span>
      </div>
      <h2 className="det-titulo" id="ap-det-titulo" ref={titulo} tabIndex={-1}>
        {criar ? `Criar a campanha “${nomeDaCampanha}”, pausada` : ativar ? `Ativar a campanha “${nomeDaCampanha}”` : `Pausar a campanha “${nomeDaCampanha}”`}
      </h2>
    </>
  );

  if (!id) {
    return (
      <>
        {voltar}
        {cabecalho}
        <p className="nota">
          <Icone nome="alert-circle" />
          <span>O pedido não aponta para uma campanha nova do Liame.</span>
        </p>
      </>
    );
  }
  if (lida.estado !== 'ok') {
    return (
      <>
        {voltar}
        {cabecalho}
        {lida.estado === 'erro' ? (
          <div className="plano-espera" role="alert">
            <p className="nota">
              <Icone nome="alert-circle" />
              <span>Não foi possível abrir a campanha. {mensagemDe(lida.problema)}</span>
            </p>
            <div className="vazio-acoes">
              <button className="btn btn--sm" type="button" onClick={() => disparar(ler())}>
                <Icone nome="refresh" pequeno />
                Tentar de novo
              </button>
            </div>
          </div>
        ) : (
          <div className="plano-espera" aria-busy="true">
            <p className="sr-only">Abrindo a campanha…</p>
            <span className="esqueleto esqueleto--curto" aria-hidden="true" />
            <span className="esqueleto" aria-hidden="true" />
          </div>
        )}
      </>
    );
  }

  const c = lida.c;
  const midia = fotos.get(c.media_id) ?? null;
  const video = midia ? ehVideo(midia) : Boolean(c.meta.video_id);
  const situacao = situacaoDaCampanha(c);
  const passos = passosDaCriacao(c, video);
  const pendente = grupo === 'pendente';
  const verba = reaisDeMicros(BigInt(c.daily_budget_micros));
  const resultado = pendente ? null : resultadoDe(acao);

  const resumo = (
    <dl className="pd-agora">
      <dt>Objetivo</dt>
      <dd>
        {OBJETIVOS[c.objective].rotulo}
        <small>botão “{OBJETIVOS[c.objective].botao}”</small>
      </dd>
      <dt>Quem vê</dt>
      <dd>
        {kmEscrito(c.radius_km)} em volta da loja
        <small>pessoas de 18 anos ou mais; o público ampliado da Meta fica desligado</small>
      </dd>
      <dt>Verba diária</dt>
      <dd>
        {verba}
        <small>{c.end_date ? `até ${c.end_date.split('-').reverse().join('/')}` : 'sem data de fim'}</small>
      </dd>
    </dl>
  );

  return (
    <>
      {voltar}
      {cabecalho}
      <div className="det-chips">
        <span className={`st st--${situacao.tom}`}>{situacao.rotulo}</span>
      </div>

      {criar && pendente && (
        <div className="secao">
          <p className="lite-frase lite-frase--grande">
            A campanha <b>nasce pausada</b>: não aparece para ninguém e não gasta. Ativar é outro pedido, com outra aprovação.
          </p>
        </div>
      )}
      {ativar && pendente && (
        <div className="secao">
          <p className="lite-frase lite-frase--grande">
            Ativada, a campanha gasta <b>até {verba} por dia</b>, depois que a Meta revisar o anúncio. A volta é pausar.
          </p>
          <div className="politica">
            <Icone nome="shield" />
            <span>{politicaDe(acao)}</span>
          </div>
        </div>
      )}

      <div className="secao cn-ap-previa">
        {lida.peca && (
          <>
            <div className="seg" role="group" aria-label="Ver como sai em">
              {(['instagram', 'facebook'] as const).map((a) => (
                <button key={a} type="button" aria-pressed={aba === a} onClick={() => setAba(a)}>
                  {a === 'instagram' ? 'Instagram' : 'Facebook'}
                </button>
              ))}
            </div>
            <PreviaDoAnuncio peca={lida.peca} midia={midia} objetivo={c.objective} nome="" instagram={aba === 'instagram'} />
          </>
        )}
        {!midia && (
          <p className="nota">
            <Icone nome="info" pequeno />
            <span>A foto ou o vídeo da loja aparece aqui para quem vê as Fotos.</span>
          </p>
        )}
      </div>

      <div className="secao">
        <p className="rotulo-marca">O que foi pedido</p>
        {resumo}
      </div>

      {(c.status === 'criando' || c.status === 'criada' || c.status === 'nao_criada') && (
        <div className="secao">
          <p className="rotulo-marca">Na Meta</p>
          <ul className="cn-passos">
            {passos.map((p) => (
              <li key={p.rotulo} data-estado={p.estado}>
                <Icone nome={p.estado === 'feito' ? 'check-circle' : p.estado === 'agora' ? 'clock' : 'minus'} />
                <span>
                  <b>{p.rotulo}</b>
                  <small>{p.detalhe}</small>
                </span>
              </li>
            ))}
          </ul>
          {c.status === 'criando' && (
            <p className="nota" role="status">
              <Icone nome="refresh" pequeno />
              <span>O Liame cria cada parte depois de conferir com a Meta. Você não precisa fazer nada: esta tela se atualiza sozinha.</span>
            </p>
          )}
        </div>
      )}

      {c.status === 'nao_criada' && (
        <div className="secao">
          <div className="pd-aviso pd-aviso--perigo" role="alert">
            <Icone nome="alert-circle" />
            <div>
              <b>A campanha não foi criada</b>
              {c.error && <span>{c.error}</span>}
              <span>O que já foi criado na Meta ficou pausado: nada aparece para ninguém nem gasta. Para tentar de novo, peça de novo pela peça, em Criativos.</span>
            </div>
          </div>
        </div>
      )}

      {c.status === 'criada' && c.meta.campaign_id && (
        <div className="secao cn-gerenciador">
          <a className="btn btn--sm" href={linkDoGerenciador(c.meta.campaign_id)} target="_blank" rel="noopener noreferrer">
            <Icone nome="external" pequeno />
            Abrir no Gerenciador de Anúncios
          </a>
          {c.active ? (
            <p className="nota">
              <Icone nome="info" pequeno />
              <span>A campanha está ativa. A Meta revisa o anúncio antes de mostrar; se ela reprovar, o Liame avisa em Atenção. Para parar, desfaça a ativação aqui em Aprovações.</span>
            </p>
          ) : c.pending_action_id ? (
            <p className="nota">
              <Icone nome="clock" pequeno />
              <span>Há um pedido de ativar ou pausar esta campanha esperando a decisão, na lista.</span>
            </p>
          ) : (
            podeOperar && (
              <>
                <button className="btn btn--primary btn--sm" type="button" onClick={() => disparar(pedirAtivar(c))} disabled={ativando}>
                  <Icone nome="play" pequeno />
                  {ativando ? 'Pedindo…' : 'Pedir para ativar'}
                </button>
                <p className="campo-dica">Ativar é outro pedido, com o código do app, os limites da empresa e a verba do mês. A volta é pausar.</p>
              </>
            )
          )}
          {erroAtivar && (
            <p className="campo-erro" role="alert">
              {erroAtivar}
            </p>
          )}
        </div>
      )}

      {resultado && (
        <div className="secao">
          <div className="politica">
            <Icone nome={resultado.ok ? 'check' : 'x'} />
            <span>{resultado.texto}</span>
          </div>
        </div>
      )}

      {pendente &&
        (podeDecidir ? (
          <>
            <p className="nota">
              <Icone nome="clock" />
              <span>Prazo: {prazoDe(acao, agora)}. Se ninguém decidir, o pedido expira e nada é feito.</span>
            </p>
            <BarraDaDecisao
              key={`${acao.id}:${acao.plan_hash}`}
              ids={ids}
              temApp={temApp}
              temChave={temChave}
              campoCodigo={campoCodigo}
              motivos={MOTIVOS}
              dica="O código de 6 números que o app autenticador mostra agora. A aprovação vale só para este plano."
              aoAprovar={(prova) => aoAprovar(acao, prova)}
              aoRecusar={(motivo) => aoRecusar(acao, motivo)}
            />
          </>
        ) : (
          <p className="nota ap-so-leitura">
            <Icone nome="lock" />
            <span>Só quem pode aprovar decide este pedido. Você acompanha por aqui.</span>
          </p>
        ))}
    </>
  );
}
