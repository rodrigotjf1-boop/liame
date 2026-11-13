'use client';

import type { ActionResponse, BrandPhoto, GoogleCampaignResponse } from '@liame/contracts';
import Link from 'next/link';
import { type RefObject, useCallback, useEffect, useId, useState } from 'react';
import { Icone } from '@/components/ui/icone';
import { idDaCampanhaGoogle, LINK_DO_GOOGLE_ADS, recortesDaFoto, situacaoDaCampanhaGoogle } from '@/components/criativos/campanha-google-textos';
import { kmEscrito } from '@/components/criativos/campanha-nova-textos';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import type { Prova } from '@/lib/chave-de-acesso';
import { disparar } from '@/lib/disparar';
import { reaisDeMicros } from '@/lib/formato';
import { BarraDaDecisao, type Decisao } from './barra-da-decisao';
import { cabecalhoDe, type Grupo, MOTIVOS_DA_RECUSA, politicaDe, prazoDe, resultadoDe, riscoDe, ROTULO_RISCO } from './textos';

// O pedido da campanha nova no Google em Aprovações (A5, Y9, parte 5b-2; P45 pré-aprovado em 12/11/2026; D-A5-25,
// D-A5-32): criar pausada (os textos, a foto e os recortes, o raio, a verba e o destino), a criação numa requisição só,
// criada e pausada (o que existe no Google e "Pedir para ativar"), não criada (o motivo do Google; nada foi criado) e
// ativar (os limites; a volta é pausar). A situação e o que fazer vêm antes do que foi pedido.

type Props = {
  acao: ActionResponse;
  grupo: Grupo | null;
  agora: Date;
  podeDecidir: boolean;
  podeOperar: boolean;
  temApp: boolean;
  temChave?: boolean;
  /** As fotos das marcas dos pedidos (a foto da campanha), quando quem vê pode ver as Fotos. */
  fotos: Map<string, BrandPhoto>;
  titulo: RefObject<HTMLHeadingElement | null>;
  campoCodigo: RefObject<HTMLInputElement | null>;
  aoVoltar: () => void;
  aoAprovar: (acao: ActionResponse, prova: Prova) => Promise<Decisao>;
  aoRecusar: (acao: ActionResponse, motivo: string) => Promise<Decisao>;
  /** Pede para ativar a campanha criada e pausada: devolve o problema, ou nulo quando o pedido foi criado. */
  aoPedirAtivar: (campanha: string) => Promise<Problema | null>;
};

type Lida = { estado: 'lendo' } | { estado: 'ok'; c: GoogleCampaignResponse } | { estado: 'erro'; problema: Problema };

const MOTIVOS = MOTIVOS_DA_RECUSA.map((m) => ({ valor: m, rotulo: m }));
/** Enquanto a campanha está sendo criada, a tela pergunta de novo neste intervalo. */
const ESPERA_MS = 10_000;
const dataEscrita = (d: string) => d.split('-').reverse().join('/');

export function DetalheCampanhaGoogle({ acao, grupo, agora, podeDecidir, podeOperar, temApp, temChave = false, fotos, titulo, campoCodigo, aoVoltar, aoAprovar, aoRecusar, aoPedirAtivar }: Props) {
  const ids = useId();
  const id = idDaCampanhaGoogle(acao.resource_id);
  const [lida, setLida] = useState<Lida>({ estado: 'lendo' });
  const [ativando, setAtivando] = useState(false);
  const [erroAtivar, setErroAtivar] = useState<string | null>(null);
  const cab = cabecalhoDe(acao, agora);
  const criar = acao.tool === 'campanha_google_criar';
  const ativar = acao.tool === 'campanha_google_ativar';

  const ler = useCallback(async () => {
    if (!id) return;
    const r = await chamar(() => api.GET('/v1/google-campaigns/{id}', { params: { path: { id } } }));
    setLida(r.ok ? { estado: 'ok', c: r.data } : { estado: 'erro', problema: r.problema });
  }, [id]);

  useEffect(() => {
    setLida({ estado: 'lendo' });
    setErroAtivar(null);
    disparar(ler());
  }, [ler, acao.status, acao.updated_at]);

  // Criando no Google: a tela pergunta de novo até terminar.
  const criando = lida.estado === 'ok' && lida.c.status === 'criando';
  useEffect(() => {
    if (!criando) return;
    const t = setInterval(() => disparar(ler()), ESPERA_MS);
    return () => clearInterval(t);
  }, [criando, ler]);

  async function pedirAtivar(c: GoogleCampaignResponse) {
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
        {criar ? `Criar a campanha “${nomeDaCampanha}” no Google, pausada` : ativar ? `Ativar a campanha “${nomeDaCampanha}” no Google` : `Pausar a campanha “${nomeDaCampanha}” no Google`}
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
          <span>O pedido não aponta para uma campanha nova do Liame no Google.</span>
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
  const foto = fotos.get(c.media_id) ?? null;
  const recortes = foto ? recortesDaFoto(foto.width, foto.height).filter((r) => r.ok) : [];
  const situacao = situacaoDaCampanhaGoogle(c);
  const pendente = grupo === 'pendente';
  const verba = reaisDeMicros(BigInt(c.daily_budget_micros));
  const naoCriada = c.status === 'nao_criada';
  // A campanha não criada já diz o motivo no aviso: o resultado do pedido repetiria o mesmo texto.
  const resultado = pendente || naoCriada ? null : resultadoDe(acao);
  const risco = riscoDe(acao);
  const noGoogle = c.google.campaign_id
    ? [
        { rotulo: 'A campanha', id: c.google.campaign_id, detalhe: c.active ? 'Performance Max, ativa' : 'Performance Max, pausada' },
        { rotulo: 'O orçamento', id: c.google.budget_id, detalhe: `${verba} por dia, só desta campanha` },
        { rotulo: 'O grupo de recursos', id: c.google.asset_group_id, detalhe: 'os textos, os recortes, o nome e a logo, com o cardápio' },
      ]
    : [];
  const googleAds = (
    <a className="btn btn--sm" href={LINK_DO_GOOGLE_ADS} target="_blank" rel="noopener noreferrer">
      <Icone nome="external" pequeno />
      Abrir o Google Ads
      <span className="sr-only"> (abre em outra aba)</span>
    </a>
  );

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
            Ativada, a campanha gasta <b>até {verba} por dia</b>, depois que o Google revisar os textos e as imagens. A volta é pausar.
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
          <div className="pd-aviso pd-aviso--perigo cg-aviso" role="alert">
            <Icone nome="alert-circle" />
            <div>
              <b>A campanha não foi criada</b>
              {c.error && <span>{c.error}</span>}
              <span>Nada foi criado no Google: a criação vai numa requisição só, e o Google cria tudo ou nada. Para tentar de novo, peça de novo pela peça, em Criativos.</span>
              <span className="cn-acoes">
                <Link className="btn btn--sm" href={`/criativos?peca=${c.piece_id}`}>
                  Abrir a peça em Criativos
                </Link>
              </span>
            </div>
          </div>
        </div>
      )}

      {c.status === 'criando' && (
        <div className="secao">
          <p className="nota" role="status">
            <Icone nome="refresh" pequeno />
            <span>O Liame confere com o Google e cria tudo numa requisição só: o orçamento, a campanha e o grupo de recursos, pausados. Você não precisa fazer nada: esta tela se atualiza sozinha.</span>
          </p>
        </div>
      )}

      {c.status === 'criada' && (
        <div className="secao cn-gerenciador">
          <p className="rotulo-marca">No Google</p>
          {noGoogle.length > 0 && (
            <ul className="cn-passos">
              {noGoogle.map((p) => (
                <li key={p.rotulo} data-estado="feito">
                  <Icone nome="check-circle" />
                  <span>
                    <b>{p.rotulo}</b>
                    <small>
                      {p.detalhe}
                      {p.id ? ` · id ${p.id}` : ''}
                    </small>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {googleAds}
          {c.active ? (
            <p className="nota">
              <Icone nome="info" pequeno />
              <span>A campanha está ativa. O Google revisa os textos e as imagens antes de mostrar. Para parar, desfaça a ativação aqui em Aprovações.</span>
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
          <dt>Tipo</dt>
          <dd>
            Performance Max
            <small>o Google mostra na Pesquisa, no YouTube, no Display, no Gmail, no Maps e no Discover, combinando os textos e as imagens</small>
          </dd>
          <dt>Quem vê</dt>
          <dd>
            {kmEscrito(c.radius_km)} em volta da loja
            <small>quem está ou costuma estar ali</small>
          </dd>
          <dt>Verba diária</dt>
          <dd>
            {verba}
            <small>{c.end_date ? `até ${dataEscrita(c.end_date)}` : 'sem data de fim'} · Maximizar conversões, sem alvo de custo por pedido</small>
          </dd>
          <dt>Para onde leva</dt>
          <dd>
            O cardápio online da loja
            <small>com o rastreio do Liame no sufixo do URL final</small>
          </dd>
          <dt>Nome da loja</dt>
          <dd>
            {c.business_name}
            <small>com a logo de Minha marca, num quadrado</small>
          </dd>
        </dl>
      </div>

      <div className="secao">
        <p className="rotulo-marca">Os textos do Google</p>
        <div className="cg-proposta">
          <p className="rotulo">Títulos ({c.headlines.length})</p>
          <ol>
            {c.headlines.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ol>
          <p className="rotulo">Título longo</p>
          <ul>
            {c.long_headlines.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
          <p className="rotulo">Descrições ({c.descriptions.length})</p>
          <ol>
            {c.descriptions.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ol>
        </div>
      </div>

      <div className="secao">
        <p className="rotulo-marca">A foto e os recortes</p>
        {foto ? (
          <ul className="cg-recortes" aria-label="Os recortes da foto">
            {recortes.map((r) => (
              <li key={r.id}>
                <figure>
                  <div className={`cg-quadro cg-quadro--${r.id}`}>
                    <img src={foto.thumbnail_url} alt="" referrerPolicy="no-referrer" />
                  </div>
                  <figcaption>
                    <b>{r.rotulo}</b>
                    {r.largura} × {r.altura}
                  </figcaption>
                </figure>
              </li>
            ))}
          </ul>
        ) : (
          <p className="nota">
            <Icone nome="info" pequeno />
            <span>A foto da loja aparece aqui para quem vê as Fotos.</span>
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
