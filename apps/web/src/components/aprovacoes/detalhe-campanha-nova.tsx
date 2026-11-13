'use client';

import type { ActionResponse, AdPieceResponse, BrandPhoto, NewCampaignOptionsResponse, NewCampaignResponse } from '@liame/contracts';
import Link from 'next/link';
import { type RefObject, useCallback, useEffect, useId, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { PreviaDoReels } from '@/components/criativos/campanha-do-reels';
import { PreviaDoAnuncio } from '@/components/criativos/gaveta-campanha-nova';
import {
  diaDoReels,
  ehVideo,
  FREQUENCIA_DO_ALCANCE,
  idDaCampanhaNova,
  kmEscrito,
  linkDoGerenciador,
  OBJETIVOS,
  passosDaCriacao,
  situacaoDaCampanha,
} from '@/components/criativos/campanha-nova-textos';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import type { Prova } from '@/lib/chave-de-acesso';
import { disparar } from '@/lib/disparar';
import { reaisDeMicros } from '@/lib/formato';
import { BarraDaDecisao, type Decisao } from './barra-da-decisao';
import { cabecalhoDe, type Grupo, MOTIVOS_DA_RECUSA, politicaDe, prazoDe, resultadoDe, riscoDe, ROTULO_RISCO } from './textos';

// O pedido da campanha nova em Aprovações (A4, X5, parte 5; P42 aprovado em 11/11/2026; D-A4-44 e D-A4-45): criar
// pausada (a prévia do anúncio, quem assina, o raio e a verba), a criação passo a passo, criada e pausada (o que existe
// na Meta e "Pedir para ativar"), não criada (o motivo da Meta) e ativar (os limites; a volta é pausar). A situação e o
// que fazer vêm antes da prévia: no estreito, a prévia ocupa a tela.

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

type Lida =
  | { estado: 'lendo' }
  | { estado: 'ok'; c: NewCampaignResponse; peca: AdPieceResponse | null; quem: Pick<NewCampaignOptionsResponse, 'page' | 'instagram'> | null }
  | { estado: 'erro'; problema: Problema };

const MOTIVOS = MOTIVOS_DA_RECUSA.map((m) => ({ valor: m, rotulo: m }));
/** Enquanto a campanha está sendo criada, a tela pergunta de novo neste intervalo. */
const ESPERA_MS = 10_000;
const dataEscrita = (d: string) => d.split('-').reverse().join('/');

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
    // A peça (o texto da prévia; o Reels não tem) e quem assina (a Página e o Instagram): sem eles, a prévia só fica
    // mais pobre.
    const pecaId = r.data.piece_id;
    const [p, o] = await Promise.all([
      pecaId ? chamar(() => api.GET('/v1/ad-pieces/{id}', { params: { path: { id: pecaId } } })) : null,
      chamar(() => api.GET('/v1/new-campaigns/options', { params: { query: { brand_id: r.data.brand_id } } })),
    ]);
    setLida({ estado: 'ok', c: r.data, peca: p?.ok ? p.data : null, quem: o.ok ? { page: o.data.page, instagram: o.data.instagram } : null });
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
  // A campanha a partir de um Reels (D-A4-46): o post como está, sem a peça e sem a mídia de Fotos.
  const doReels = c.instagram_media_id !== null;
  const midia = c.media_id ? (fotos.get(c.media_id) ?? null) : null;
  const video = doReels ? false : midia ? ehVideo(midia) : Boolean(c.meta.video_id);
  const situacao = situacaoDaCampanha(c);
  const passos = passosDaCriacao(c, video);
  const pendente = grupo === 'pendente';
  const verba = reaisDeMicros(BigInt(c.daily_budget_micros));
  const naoCriada = c.status === 'nao_criada';
  // A campanha não criada já diz o motivo no aviso: o resultado do pedido repetiria o mesmo texto.
  const resultado = pendente || naoCriada ? null : resultadoDe(acao);
  const risco = riscoDe(acao);
  const assina = aba === 'instagram' ? (lida.quem?.instagram?.name ?? lida.quem?.page?.name ?? '') : (lida.quem?.page?.name ?? '');
  const gerenciador = c.meta.campaign_id ? (
    <a className="btn btn--sm" href={linkDoGerenciador(c.meta.campaign_id, c.meta.account_id)} target="_blank" rel="noopener noreferrer">
      <Icone nome="external" pequeno />
      Abrir no Gerenciador de Anúncios
      <span className="sr-only"> (abre em outra aba)</span>
    </a>
  ) : null;

  return (
    <>
      {voltar}
      {cabecalho}
      <div className="det-chips">
        <span className={`st st--${situacao.tom}`}>{situacao.rotulo}</span>
        {pendente && <span className={`risco risco--${risco}`}>{ROTULO_RISCO[risco]}</span>}
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
        </div>
      )}
      {pendente && (
        <div className="secao">
          <p className="rotulo-marca">Risco e limites</p>
          <div className="politica">
            <Icone nome="shield" />
            <span>
              <b className={`risco risco--${risco}`}>{ROTULO_RISCO[risco]}.</b> {politicaDe(acao)}
            </span>
          </div>
          <p className="nota">
            <Icone nome="clock" />
            <span>Prazo: {prazoDe(acao, agora)}. Se ninguém decidir, o pedido expira e nada é feito.</span>
          </p>
        </div>
      )}

      {naoCriada && (
        <div className="secao">
          <div className="pd-aviso pd-aviso--perigo" role="alert">
            <Icone nome="alert-circle" />
            <div>
              <b>A campanha não foi criada</b>
              {c.error && <span>{c.error}</span>}
              <span>
                O que já foi criado na Meta ficou pausado: nada aparece para ninguém nem gasta.{' '}
                {doReels ? 'Para tentar de novo, peça de novo pelo Reels, em Fotos › Do seu Instagram.' : 'Para tentar de novo, peça de novo pela peça, em Criativos.'}
              </span>
              <span className="cn-acoes">
                {doReels ? (
                  <Link className="btn btn--sm" href="/fotos">
                    Abrir Fotos
                  </Link>
                ) : (
                  <Link className="btn btn--sm" href={`/criativos?peca=${c.piece_id}`}>
                    Abrir a peça em Criativos
                  </Link>
                )}
                {gerenciador}
              </span>
            </div>
          </div>
        </div>
      )}

      {(c.status === 'criando' || c.status === 'criada' || naoCriada) && (
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

      {c.status === 'criada' && (
        <div className="secao cn-gerenciador">
          {gerenciador}
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
                <button className="btn btn--primary btn--sm" type="button" onClick={() => disparar(pedirAtivar(c))} disabled={ativando} aria-describedby={`${ids}-ativar-d`}>
                  <Icone nome="play" pequeno />
                  {ativando ? 'Pedindo…' : 'Pedir para ativar'}
                </button>
                <p className="campo-dica" id={`${ids}-ativar-d`}>
                  Ativar é outro pedido, com o código do app, os limites da empresa e a verba do mês. A volta é pausar.
                </p>
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

      <div className="secao">
        <p className="rotulo-marca">O que foi pedido</p>
        <dl className="pd-agora cn-destino">
          {doReels && (
            <>
              <dt>O anúncio</dt>
              <dd>
                {c.reels ? `O Reels de ${diaDoReels(c.reels.published_at)}, como está no post` : 'Um Reels do Instagram da marca, como está no post'}
                <small>o vídeo e a legenda ficam como estão; o Liame põe o botão e o rastreio, e pergunta antes à Meta se o Reels pode virar anúncio</small>
              </dd>
            </>
          )}
          <dt>Objetivo</dt>
          <dd>
            {OBJETIVOS[c.objective].rotulo}
            <small>
              botão “{OBJETIVOS[c.objective].botao}”{c.objective === 'alcance' ? ` · ${FREQUENCIA_DO_ALCANCE.toLowerCase()}` : ''}
            </small>
          </dd>
          <dt>Quem vê</dt>
          <dd>
            {kmEscrito(c.radius_km)} em volta da loja
            <small>pessoas de 18 anos ou mais; o público ampliado da Meta fica desligado</small>
          </dd>
          <dt>Verba diária</dt>
          <dd>
            {verba}
            <small>{c.end_date ? `até ${dataEscrita(c.end_date)}` : 'sem data de fim'}</small>
          </dd>
          <dt>Quem assina</dt>
          <dd>
            {lida.quem?.page ? `Página ${lida.quem.page.name}` : 'a Página da marca'}
            <small>{lida.quem?.instagram ? `no Instagram, ${lida.quem.instagram.name}` : 'no Instagram, em nome da Página'}</small>
          </dd>
        </dl>
      </div>

      <div className="secao cn-ap-previa">
        <p className="rotulo-marca">Como o anúncio aparece</p>
        {doReels && <PreviaDoReels reels={c.reels} objetivo={c.objective} nome={lida.quem?.instagram?.name ?? lida.quem?.page?.name ?? ''} />}
        {doReels && c.reels?.permalink && (
          <a className="btn btn--sm" href={c.reels.permalink} target="_blank" rel="noopener noreferrer">
            <Icone nome="external" pequeno />
            Ver o Reels no Instagram
            <span className="sr-only"> (abre em outra aba)</span>
          </a>
        )}
        {lida.peca && (
          <>
            <div className="seg" role="group" aria-label="Ver como sai em">
              {(['instagram', 'facebook'] as const).map((a) => (
                <button key={a} type="button" aria-pressed={aba === a} onClick={() => setAba(a)}>
                  {a === 'instagram' ? 'Instagram' : 'Facebook'}
                </button>
              ))}
            </div>
            <PreviaDoAnuncio peca={lida.peca} midia={midia} objetivo={c.objective} nome={assina} instagram={aba === 'instagram'} />
          </>
        )}
        {!doReels && !midia && (
          <p className="nota">
            <Icone nome="info" pequeno />
            <span>A foto ou o vídeo da loja aparece aqui para quem vê as Fotos.</span>
          </p>
        )}
      </div>

      {pendente &&
        (podeDecidir ? (
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
        ) : (
          <p className="nota ap-so-leitura">
            <Icone nome="lock" />
            <span>Só quem pode aprovar decide este pedido. Você acompanha por aqui.</span>
          </p>
        ))}
    </>
  );
}
