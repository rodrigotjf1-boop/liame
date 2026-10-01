'use client';

import type { BrandResponse, CouponItem, CouponResponse, CouponStore, CreatedTrackingLinkResponse, ExternalCouponPlatform, TrackingCheckResponse, TrackingLink } from '@liame/contracts';
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useAvisar } from '@/components/ui/avisos';
import { Estado } from '@/components/ui/estado';
import { Faixa } from '@/components/ui/faixa';
import { Icone } from '@/components/ui/icone';
import { useAgora } from '@/lib/agora';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { useSessao } from '@/lib/sessao';
import { copiar } from './copiar';
import { avisoDesligado, avisoLigado, infoPlataforma, plataformaDaLoja } from './cupons-textos';
import { DialogoCriarLink } from './dialogo-criar-link';
import { DialogoCupomExterno } from './dialogo-cupom-externo';
import { DialogoLigarCupom } from './dialogo-ligar-cupom';
import { DialogoLinkPronto } from './dialogo-link-pronto';
import { DialogoPlataforma } from './dialogo-plataforma';
import { FaixaRastreio } from './faixa-rastreio';
import { FaixaSemCupom } from './faixa-sem-cupom';
import { LinhaPlataforma } from './linha-plataforma';
import { type CargaCupons, PainelCupons } from './painel-cupons';
import { TabelaLinks } from './tabela-links';
import { avisoDoLink } from './textos';

// "Links e cupons" (mockups/prototipo-links-cupons-plataforma.html, P3 com a plataforma de pedidos aprovado
// em 30/09/2026): a plataforma de pedidos da loja e duas abas. Links: o link do cardápio com rastreio de cada
// campanha, os parâmetros para colar e a conferência dos anúncios ativos (`GET /v1/links`,
// `/v1/links/tracking-check`). Cupons: os do Regem e os informados de outra plataforma, ligados a campanhas
// (`GET /v1/coupons`; mudar com `atribuicao.gerenciar`). O Liame não escreve na Meta, no Google, no Regem nem
// na plataforma de pedidos.

type Dados = { links: TrackingLink[]; check: TrackingCheckResponse | null; erroCheck: Problema | null };
type Carga = { tipo: 'carregando' } | { tipo: 'ok'; dados: Dados } | { tipo: 'erro'; problema: Problema };
type Aba = 'links' | 'cupons';
type Dialogo =
  | { tipo: 'criar'; inicial?: { campanha: string; anuncio: string } }
  | { tipo: 'pronto'; link: TrackingLink; criado: boolean | null }
  | { tipo: 'plataforma' }
  | { tipo: 'externo'; campanha?: string }
  | { tipo: 'ligar'; cupom: CouponItem };

const ABAS: Aba[] = ['links', 'cupons'];

export function LinksTela() {
  const { pode } = useSessao();
  const avisar = useAvisar();
  const podeVer = pode('vendas.ver');
  const podeCriar = pode('links.gerenciar');
  const podeGerenciarCupons = pode('atribuicao.gerenciar');
  const podeCriarCupom = pode('cupons.criar');
  const podeVerContas = pode('contas.ver');
  const titulo = useRef<HTMLHeadingElement>(null);
  const botaoCriar = useRef<HTMLButtonElement>(null);
  const botaoInformar = useRef<HTMLButtonElement>(null);
  const abas = useRef<Record<Aba, HTMLButtonElement | null>>({ links: null, cupons: null });
  const [marcas, setMarcas] = useState<BrandResponse[] | null>(null);
  const [erroMarcas, setErroMarcas] = useState<Problema | null>(null);
  const [marca, setMarca] = useState<string | null>(null);
  const [carga, setCarga] = useState<Carga>({ tipo: 'carregando' });
  const [cupons, setCupons] = useState<CargaCupons>({ tipo: 'carregando' });
  const [loja, setLoja] = useState<string | null>(null);
  const [aba, setAba] = useState<Aba>('links');
  const [tentativa, setTentativa] = useState(0);
  const [dialogo, setDialogo] = useState<Dialogo | null>(null);
  const agora = useAgora(60_000, carga);
  // Só a resposta mais nova vale (trocar de marca no meio de uma leitura não mistura listas).
  const seq = useRef(0);

  // "#cupons" no endereço abre direto na aba Cupons (para o passo a passo do piloto).
  useEffect(() => {
    if (window.location.hash === '#cupons') setAba('cupons');
  }, []);

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
        chamar(() => api.GET('/v1/coupons', { params: { query } })),
      ]).then(([l, c, k]) => {
        if (id !== seq.current) return;
        // Cupons e conferência são à parte: se falharem, os links continuam na tela.
        setCupons(k.ok ? { tipo: 'ok', dados: k.data } : { tipo: 'erro', problema: k.problema });
        if (k.ok) {
          setLoja((atual) => {
            const lojas = k.data.stores;
            if (atual && lojas.some((s) => s.connected_account_id === atual)) return atual;
            return (lojas.find((s) => s.unit) ?? lojas[0])?.connected_account_id ?? null;
          });
        }
        if (!l.ok) return setCarga({ tipo: 'erro', problema: l.problema });
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
  const dadosCupons = cupons.tipo === 'ok' ? cupons.dados : null;
  const lojaAtual: CouponStore | null = dadosCupons?.stores.find((s) => s.connected_account_id === loja) ?? null;
  const itensDaLoja = dadosCupons && lojaAtual ? dadosCupons.items.filter((i) => i.connected_account_id === lojaAtual.connected_account_id) : [];
  const plataforma = plataformaDaLoja(lojaAtual, dadosCupons?.detected_platform ?? null);
  const recarregar = () => setTentativa((t) => t + 1);

  function mostrarAba(nova: Aba, focar = false) {
    setAba(nova);
    try {
      window.history.replaceState(null, '', nova === 'cupons' ? '#cupons' : window.location.pathname + window.location.search);
    } catch {
      /* o endereço é só conveniência */
    }
    if (focar) abas.current[nova]?.focus();
  }

  function teclaNasAbas(e: KeyboardEvent<HTMLDivElement>) {
    const i = ABAS.indexOf(aba);
    const alvo = ({ ArrowRight: ABAS[(i + 1) % 2], ArrowLeft: ABAS[(i + 1) % 2], Home: 'links', End: 'cupons' } as Record<string, Aba | undefined>)[e.key];
    if (alvo) {
      e.preventDefault();
      mostrarAba(alvo, true);
    }
  }

  async function copiarLink(link: TrackingLink) {
    const ok = await copiar(link.tracking_url);
    avisar(ok ? 'Link com rastreio copiado.' : 'Não deu para copiar: abra “Parâmetros e QR” e copie de lá.', { tipo: ok ? 'ok' : 'perigo' });
  }

  function aoCriado(link: CreatedTrackingLinkResponse) {
    avisar(avisoDoLink(link, link.created));
    setDialogo({ tipo: 'pronto', link, criado: link.created });
    recarregar();
  }

  function aoCupomLigado(r: CouponResponse, de?: string) {
    const l = r.item.link;
    if (l) avisar(avisoLigado(r.item.code, l.campaign.name, l.exclusive, de));
    recarregar();
  }

  async function desligar(c: CouponItem): Promise<boolean> {
    const campanha = c.link?.campaign.name ?? '';
    const r = await chamar(() => api.POST('/v1/coupons/{id}/unlink', { params: { path: { id: c.id } } }));
    if (!r.ok) {
      avisar(mensagemDe(r.problema), { tipo: 'perigo' });
      return false;
    }
    avisar(avisoDesligado(c, campanha));
    recarregar();
    return true;
  }

  let corpoLinks;
  if (erroMarcas) {
    corpoLinks = <Erro problema={erroMarcas} aoTentar={() => disparar(carregarMarcas())} />;
  } else if (marcas && !marcas.length) {
    corpoLinks = (
      <div className="card">
        <Estado icone="info" titulo="Nenhuma marca ativa nesta empresa">
          Os links são por marca: quando a empresa tiver uma marca ativa, os links dela aparecem aqui.
        </Estado>
      </div>
    );
  } else if (carga.tipo === 'erro') {
    corpoLinks = <Erro problema={carga.problema} aoTentar={recarregar} />;
  } else if (!dados) {
    corpoLinks = <LinksCarregando />;
  } else {
    const outraPlataforma = !!dadosCupons && !!lojaAtual && plataforma.plataforma !== 'regem';
    corpoLinks = (
      <>
        {outraPlataforma && dadosCupons ? (
          <FaixaSemCupom
            plataforma={plataforma}
            campanhas={dadosCupons.campaigns}
            itens={itensDaLoja}
            podeInformar={podeGerenciarCupons && !!lojaAtual?.unit && plataforma.info.cupomExterno}
            aoInformar={(campanha) => setDialogo({ tipo: 'externo', campanha })}
          />
        ) : dados.check ? (
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

  const lojas = dadosCupons?.stores ?? [];
  const plataformaExterna = plataforma.info.cupomExterno ? (plataforma.plataforma as ExternalCouponPlatform) : null;

  return (
    <section aria-labelledby="h-links">
      <div className="view-cab anima" style={{ ['--i' as string]: 0 }}>
        <div>
          <h1 id="h-links" ref={titulo} tabIndex={-1}>
            Links e cupons
          </h1>
          <p>O link do cardápio com rastreio e o cupom exclusivo de cada campanha: é assim que o Liame prova de onde veio cada pedido. O Liame não mexe nos anúncios; você cola os parâmetros.</p>
        </div>
        {((marcas && marcas.length > 1) || lojas.length > 1) && (
          <div className="res-controles">
            {marcas && marcas.length > 1 && (
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
            )}
            {lojas.length > 1 && (
              <label className="res-campo">
                <span>Loja</span>
                <select className="input" value={loja ?? ''} onChange={(e) => setLoja(e.target.value)}>
                  {lojas.map((s) => (
                    <option key={s.connected_account_id} value={s.connected_account_id}>
                      {s.unit?.name ?? s.store_name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}
      </div>

      {lojaAtual && dadosCupons && (
        <LinhaPlataforma
          loja={lojaAtual}
          plataforma={plataforma}
          sugerida={dadosCupons.detected_platform}
          podeAlterar={podeGerenciarCupons}
          aoAlterar={() => setDialogo({ tipo: 'plataforma' })}
        />
      )}

      <div className="abas" role="tablist" aria-label="Links e cupons" onKeyDown={teclaNasAbas}>
        <button
          ref={(b) => {
            abas.current.links = b;
          }}
          className="aba"
          type="button"
          role="tab"
          id="aba-links"
          aria-controls="painel-links"
          aria-selected={aba === 'links'}
          tabIndex={aba === 'links' ? 0 : -1}
          onClick={() => mostrarAba('links')}
        >
          <Icone nome="link" />
          Links <span className="aba-num">{dados ? dados.links.length : '—'}</span>
        </button>
        <button
          ref={(b) => {
            abas.current.cupons = b;
          }}
          className="aba"
          type="button"
          role="tab"
          id="aba-cupons"
          aria-controls="painel-cupons"
          aria-selected={aba === 'cupons'}
          tabIndex={aba === 'cupons' ? 0 : -1}
          onClick={() => mostrarAba('cupons')}
        >
          <Icone nome="ticket" />
          Cupons <span className="aba-num">{dadosCupons && lojaAtual ? itensDaLoja.length : '—'}</span>
        </button>
      </div>

      <div className="painel" role="tabpanel" id="painel-links" aria-labelledby="aba-links" hidden={aba !== 'links'}>
        <div className="painel-cab">
          <p className="painel-desc">Cada link leva ao cardápio da loja com o código do Liame (lk) e os parâmetros de cada plataforma. Também sai em QR para material impresso.</p>
          {podeCriar && marca && (
            <button ref={botaoCriar} className="btn btn--primary" type="button" aria-haspopup="dialog" onClick={() => setDialogo({ tipo: 'criar' })}>
              <Icone nome="plus" />
              Criar link
            </button>
          )}
        </div>
        {corpoLinks}
      </div>

      <div className="painel" role="tabpanel" id="painel-cupons" aria-labelledby="aba-cupons" hidden={aba !== 'cupons'}>
        <PainelCupons
          carga={cupons}
          loja={lojaAtual}
          itens={itensDaLoja}
          plataforma={plataforma}
          agora={agora}
          podeGerenciar={podeGerenciarCupons}
          podeCriarCupom={podeCriarCupom}
          podeVerContas={podeVerContas}
          botaoInformar={botaoInformar}
          aoInformar={() => setDialogo({ tipo: 'externo' })}
          aoCriarNoRegem={() => avisar('A criação de cupons está desligada para a sua empresa. Crie o cupom no Regem: ele aparece aqui na próxima leitura.')}
          aoLigar={(cupom) => setDialogo({ tipo: 'ligar', cupom })}
          aoDesligar={desligar}
          aoTentar={recarregar}
        />
      </div>

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
      {dialogo?.tipo === 'plataforma' && lojaAtual?.unit && dadosCupons && (
        <DialogoPlataforma
          loja={{ ...lojaAtual, unit: lojaAtual.unit }}
          atual={plataforma.plataforma}
          sugerida={dadosCupons.detected_platform}
          reserva={titulo}
          aoSalvo={(s) => {
            const nome = infoPlataforma(s.order_platform ?? 'regem', s.order_platform_url).nome;
            avisar(`Plataforma de pedidos: ${nome.charAt(0).toUpperCase()}${nome.slice(1)}. A conferência dos anúncios e os cupons passam a seguir essa escolha.`);
            recarregar();
          }}
          aoFechar={() => setDialogo((d) => (d?.tipo === 'plataforma' ? null : d))}
        />
      )}
      {dialogo?.tipo === 'externo' && lojaAtual?.unit && plataformaExterna && dadosCupons && (
        <DialogoCupomExterno
          unidade={lojaAtual.unit.id}
          plataforma={plataformaExterna}
          campanhas={dadosCupons.campaigns}
          campanhaInicial={dialogo.campanha}
          existentes={itensDaLoja.map((i) => i.code)}
          reserva={titulo}
          aoInformado={(r) => aoCupomLigado(r, plataforma.info.de)}
          aoFechar={() => setDialogo((d) => (d?.tipo === 'externo' ? null : d))}
        />
      )}
      {dialogo?.tipo === 'ligar' && lojaAtual && dadosCupons && (
        <DialogoLigarCupom
          cupom={dialogo.cupom}
          loja={lojaAtual}
          campanhas={dadosCupons.campaigns}
          agora={agora}
          reserva={titulo}
          aoLigado={(r) => aoCupomLigado(r)}
          aoFechar={() => setDialogo((d) => (d?.tipo === 'ligar' ? null : d))}
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
