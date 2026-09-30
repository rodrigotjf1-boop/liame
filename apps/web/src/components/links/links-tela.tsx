'use client';

import type { BrandResponse, CreatedTrackingLinkResponse, TrackingCheckResponse, TrackingLink } from '@liame/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAvisar } from '@/components/ui/avisos';
import { Estado } from '@/components/ui/estado';
import { Faixa } from '@/components/ui/faixa';
import { Icone } from '@/components/ui/icone';
import { useAgora } from '@/lib/agora';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { useSessao } from '@/lib/sessao';
import { copiar } from './copiar';
import { DialogoCriarLink } from './dialogo-criar-link';
import { DialogoLinkPronto } from './dialogo-link-pronto';
import { FaixaRastreio } from './faixa-rastreio';
import { TabelaLinks } from './tabela-links';
import { avisoDoLink } from './textos';

// "Links e cupons" (mockups/prototipo-links-cupons.html, P3 aprovado em 29/09/2026), aba Links: o link do
// cardápio com rastreio de cada campanha, os parâmetros para colar no anúncio, o QR e a conferência dos
// anúncios ativos (`GET /v1/links`, `/v1/links/tracking-check`; criar com `links.gerenciar`). A aba
// Cupons chega com a F6. O Liame não escreve na Meta nem no Google.

type Dados = { links: TrackingLink[]; check: TrackingCheckResponse | null; erroCheck: Problema | null };
type Carga = { tipo: 'carregando' } | { tipo: 'ok'; dados: Dados } | { tipo: 'erro'; problema: Problema };
type Dialogo = { tipo: 'criar'; inicial?: { campanha: string; anuncio: string } } | { tipo: 'pronto'; link: TrackingLink; criado: boolean | null };

export function LinksTela() {
  const { pode } = useSessao();
  const avisar = useAvisar();
  const podeVer = pode('vendas.ver');
  const podeCriar = pode('links.gerenciar');
  const podeVerContas = pode('contas.ver');
  const titulo = useRef<HTMLHeadingElement>(null);
  const botaoCriar = useRef<HTMLButtonElement>(null);
  const [marcas, setMarcas] = useState<BrandResponse[] | null>(null);
  const [erroMarcas, setErroMarcas] = useState<Problema | null>(null);
  const [marca, setMarca] = useState<string | null>(null);
  const [carga, setCarga] = useState<Carga>({ tipo: 'carregando' });
  const [tentativa, setTentativa] = useState(0);
  const [dialogo, setDialogo] = useState<Dialogo | null>(null);
  const agora = useAgora(60_000, carga);
  // Só a resposta mais nova vale (trocar de marca no meio de uma leitura não mistura listas).
  const seq = useRef(0);

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
    const query = { brand_id: marca };
    disparar(
      Promise.all([
        chamar(() => api.GET('/v1/links', { params: { query } })),
        chamar(() => api.GET('/v1/links/tracking-check', { params: { query } })),
      ]).then(([l, c]) => {
        if (id !== seq.current) return;
        if (!l.ok) return setCarga({ tipo: 'erro', problema: l.problema });
        // A conferência é à parte: se ela falhar, os links continuam na tela.
        setCarga({ tipo: 'ok', dados: { links: l.data.items, check: c.ok ? c.data : null, erroCheck: c.ok ? null : c.problema } });
      }),
    );
  }, [marca, tentativa]);

  if (!podeVer) {
    return (
      <Estado icone="lock" titulo="Esta tela é de quem acompanha as vendas">
        O seu nível nesta empresa não mostra os links de campanha. Se precisar, peça ao dono da conta.
      </Estado>
    );
  }

  const nomeDaMarca = marcas?.find((m) => m.id === marca)?.name ?? 'sua marca';
  const dados = carga.tipo === 'ok' ? carga.dados : null;

  async function copiarLink(link: TrackingLink) {
    const ok = await copiar(link.tracking_url);
    avisar(ok ? 'Link com rastreio copiado.' : 'Não deu para copiar: abra “Parâmetros e QR” e copie de lá.', { tipo: ok ? 'ok' : 'perigo' });
  }

  function aoCriado(link: CreatedTrackingLinkResponse) {
    avisar(avisoDoLink(link, link.created));
    setDialogo({ tipo: 'pronto', link, criado: link.created });
    setTentativa((t) => t + 1);
  }

  let corpo;
  if (erroMarcas) {
    corpo = <Erro problema={erroMarcas} aoTentar={() => disparar(carregarMarcas())} />;
  } else if (marcas && !marcas.length) {
    corpo = (
      <div className="card">
        <Estado icone="info" titulo="Nenhuma marca ativa nesta empresa">
          Os links são por marca: quando a empresa tiver uma marca ativa, os links dela aparecem aqui.
        </Estado>
      </div>
    );
  } else if (carga.tipo === 'erro') {
    corpo = <Erro problema={carga.problema} aoTentar={() => setTentativa((t) => t + 1)} />;
  } else if (!dados) {
    corpo = <LinksCarregando />;
  } else {
    corpo = (
      <>
        {dados.check ? (
          <FaixaRastreio
            check={dados.check}
            links={dados.links}
            agora={agora}
            podeCriar={podeCriar}
            aoVerParametros={(link) => setDialogo({ tipo: 'pronto', link, criado: null })}
            aoCriarLink={(inicial) => setDialogo({ tipo: 'criar', inicial })}
          />
        ) : (
          dados.erroCheck && (
            <Faixa
              icone={<Icone nome="info" />}
              titulo="A conferência dos anúncios não carregou agora"
              texto={`${mensagemDe(dados.erroCheck)} Os links abaixo continuam valendo no cardápio.`}
            />
          )
        )}
        {dados.links.length ? (
          <TabelaLinks
            links={dados.links}
            marca={nomeDaMarca}
            agora={agora}
            aoCopiar={(l) => disparar(copiarLink(l))}
            aoParametros={(link) => setDialogo({ tipo: 'pronto', link, criado: null })}
          />
        ) : (
          <div className="card">
            <Estado
              icone="link"
              titulo="Nenhum link de campanha ainda"
              acao={
                podeCriar ? (
                  <div className="vazio-acoes">
                    <button className="btn btn--primary" type="button" aria-haspopup="dialog" onClick={() => setDialogo({ tipo: 'criar' })}>
                      Criar o primeiro link
                    </button>
                  </div>
                ) : undefined
              }
            >
              {podeCriar
                ? 'Crie o primeiro link: o Liame monta o endereço do cardápio com o rastreio e os parâmetros para colar na Meta e no Google Ads, e o QR para material impresso.'
                : 'Quando alguém da equipe criar um link de campanha, ele aparece aqui com os pedidos que trouxe.'}
            </Estado>
          </div>
        )}
      </>
    );
  }

  return (
    <section aria-labelledby="h-links">
      <div className="view-cab anima" style={{ ['--i' as string]: 0 }}>
        <div>
          <h1 id="h-links" ref={titulo} tabIndex={-1}>
            Links e cupons
          </h1>
          <p>O link do cardápio com rastreio de cada campanha: é assim que o Liame prova de onde veio cada pedido. O Liame não mexe nos anúncios; você cola os parâmetros.</p>
        </div>
        {marcas && marcas.length > 1 && (
          <div className="res-controles">
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
          </div>
        )}
      </div>

      <div className="painel-cab">
        <p className="painel-desc">Cada link leva ao cardápio da loja com o código do Liame (lk) e os parâmetros de cada plataforma. Também sai em QR para material impresso.</p>
        {podeCriar && marca && (
          <button ref={botaoCriar} className="btn btn--primary" type="button" aria-haspopup="dialog" onClick={() => setDialogo({ tipo: 'criar' })}>
            <Icone nome="plus" />
            Criar link
          </button>
        )}
      </div>

      {corpo}

      {dialogo?.tipo === 'criar' && marca && (
        <DialogoCriarLink
          marca={marca}
          inicial={dialogo.inicial}
          podeVerContas={podeVerContas}
          reserva={titulo}
          aoCriado={aoCriado}
          aoFechar={() => setDialogo((d) => (d?.tipo === 'criar' ? null : d))}
        />
      )}
      {dialogo?.tipo === 'pronto' && (
        <DialogoLinkPronto
          link={dialogo.link}
          criado={dialogo.criado}
          reserva={dialogo.criado === null ? titulo : botaoCriar}
          aoFechar={() => setDialogo((d) => (d?.tipo === 'pronto' ? null : d))}
        />
      )}
    </section>
  );
}

function Erro({ problema, aoTentar }: { problema: Problema; aoTentar: () => void }) {
  return (
    <div className="card">
      <Estado
        icone="alert-circle"
        perigo
        titulo="Não foi possível carregar os links"
        acao={
          <div className="vazio-acoes">
            <button className="btn btn--primary" type="button" onClick={aoTentar}>
              <Icone nome="refresh" />
              Tentar de novo
            </button>
          </div>
        }
      >
        {mensagemDe(problema)} Os links que já estão nos anúncios continuam funcionando no cardápio.
      </Estado>
    </div>
  );
}

function LinksCarregando() {
  return (
    <div className="card res-esqueleto" aria-hidden="true">
      <span className="esqueleto esqueleto--curto" />
      <span className="esqueleto" />
      <span className="esqueleto" />
      <span className="esqueleto" />
    </div>
  );
}
