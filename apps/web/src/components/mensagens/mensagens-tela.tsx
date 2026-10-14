'use client';

import type { ActionResponse, BrandResponse, MessageDiscountResponse, MessagingResponse } from '@liame/contracts';
import Link from 'next/link';
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAvisar } from '@/components/ui/avisos';
import { Estado } from '@/components/ui/estado';
import { Icone } from '@/components/ui/icone';
import { useAgora } from '@/lib/agora';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { useModo } from '@/lib/modo';
import { useSessao } from '@/lib/sessao';
import { caixaDoDesconto, faixaDoDesconto } from './desconto-textos';
import { GavetaDesconto } from './gaveta-desconto';
import { GavetaMensagem } from './gaveta-mensagem';
import { type DescontoNaTela, MensagensConteudo } from './mensagens-conteudo';
import { contaDaTela, faixaDosPedidos, telaDasMensagens } from './textos';

// "Mensagens" (mockups/prototipo-mensagens.html, P15 aprovado em 09/10/2026; Y4 da A5): o que a empresa enviou de
// WhatsApp pelo RegemCast, com os números de cada mensagem, se a conta pode enviar e o teto de gasto. Tudo é lido do
// RegemCast na hora pelo servidor (`GET /v1/messaging`, de quem acompanha as campanhas); nada é guardado no Liame e
// esta tela não envia nem pausa nada. O desconto do cupom das mensagens (P15, parte D) é a exceção: é do Liame, por
// marca (`GET` e `PUT /v1/messaging/discount`), e quem o define é o Dono ou o Administrador.

type Carga = { tipo: 'carregando' } | { tipo: 'ok'; dados: MessagingResponse } | { tipo: 'erro'; problema: Problema };
type CargaDoDesconto = { tipo: 'carregando' } | { tipo: 'ok'; dados: MessageDiscountResponse } | { tipo: 'erro' };

export function MensagensTela() {
  const { me, pode } = useSessao();
  const { modo } = useModo();
  const podeVer = pode('campanhas.ver');
  // A faixa diz "a sua aprovação" só a quem decide o pedido (ERR-136): a lista é de quem vê campanhas.
  const podeAprovar = pode('acoes.aprovar');
  const souDono = me.organizations.find((o) => o.id === me.active_organization_id)?.role === 'dono';
  const podeVerContas = pode('contas.ver');
  const titulo = useRef<HTMLHeadingElement>(null);
  const [marcas, setMarcas] = useState<BrandResponse[] | null>(null);
  const [erroMarcas, setErroMarcas] = useState<Problema | null>(null);
  const [marca, setMarca] = useState<string | null>(null);
  const [carga, setCarga] = useState<Carga>({ tipo: 'carregando' });
  const [tentativa, setTentativa] = useState(0);
  const [contaEscolhida, setContaEscolhida] = useState<string | null>(null);
  const [aberta, setAberta] = useState<string | null>(null);
  /** Os pedidos que esperam aprovação (para a faixa do pedido de mensagem). Se a leitura falhar, a tela segue sem a faixa. */
  const [esperando, setEsperando] = useState<ActionResponse[]>([]);
  /** O desconto do cupom das mensagens da marca (P15, parte D); nulo sem conta do RegemCast na tela. */
  const [desconto, setDesconto] = useState<CargaDoDesconto | null>(null);
  const [lerDesconto, setLerDesconto] = useState(0);
  const [definindo, setDefinindo] = useState(false);
  const avisar = useAvisar();
  // Ao fechar a gaveta, o foco volta a quem abriu; se foi a faixa (que some quando o desconto é definido), vai para o
  // botão da caixa, e sem ele para o título.
  const reservaDoDesconto = useMemo<RefObject<HTMLElement | null>>(
    () => ({
      get current() {
        return document.getElementById('mens-desconto-bt') ?? document.getElementById('h-mensagens');
      },
    }),
    [],
  );
  /** Depois de "Tentar de novo", o foco volta ao título quando a leitura chega. */
  const focarTitulo = useRef(false);
  // Só a resposta mais nova vale (trocar de marca no meio de uma leitura não mistura as contas).
  const seq = useRef(0);
  const agora = useAgora(60_000, carga.tipo === 'ok' ? carga.dados.read_at : null);

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
    setAberta(null);
    disparar(
      chamar(() => api.GET('/v1/messaging', { params: { query: { brand_id: marca } } })).then((r) => {
        if (id !== seq.current) return;
        setCarga(r.ok ? { tipo: 'ok', dados: r.data } : { tipo: 'erro', problema: r.problema });
      }),
    );
  }, [marca, tentativa]);

  // Com a função ligada e conta conectada, a tela lê os pedidos de mensagem que esperam a aprovação.
  const temConta = carga.tipo === 'ok' && carga.dados.enabled && carga.dados.accounts.length > 0;
  useEffect(() => {
    if (!temConta) return setEsperando([]);
    let vivo = true;
    disparar(
      chamar(() => api.GET('/v1/actions', { params: { query: { status: 'aguardando_aprovacao' } } })).then((r) => {
        if (vivo) setEsperando(r.ok ? r.data.items : []);
      }),
    );
    return () => {
      vivo = false;
    };
  }, [temConta, tentativa, marca]);

  // O desconto do cupom das mensagens da marca: só com a função ligada e conta conectada (a tela das mensagens).
  useEffect(() => {
    if (!temConta || !marca) return setDesconto(null);
    let vivo = true;
    setDesconto({ tipo: 'carregando' });
    disparar(
      chamar(() => api.GET('/v1/messaging/discount', { params: { query: { brand_id: marca } } })).then((r) => {
        if (vivo) setDesconto(r.ok ? { tipo: 'ok', dados: r.data } : { tipo: 'erro' });
      }),
    );
    return () => {
      vivo = false;
    };
  }, [temConta, marca, tentativa, lerDesconto]);
  const descontoNaTela = useMemo<DescontoNaTela | null>(() => {
    if (!desconto) return null;
    if (desconto.tipo !== 'ok') return desconto;
    if (!desconto.dados.enabled) return null;
    return { tipo: 'ok', caixa: caixaDoDesconto(desconto.dados), faixa: faixaDoDesconto(desconto.dados) };
  }, [desconto]);

  // Depois de salvar, o foco vai para o botão da caixa, já redesenhada: a faixa que abriu a gaveta some no mesmo
  // desenho, e devolver o foco a ela o perderia (V82).
  const focarACaixa = useRef(false);
  useEffect(() => {
    if (!focarACaixa.current || desconto?.tipo !== 'ok') return;
    focarACaixa.current = false;
    document.getElementById('mens-desconto-bt')?.focus({ preventScroll: true });
  }, [desconto]);

  function descontoSalvo(r: MessageDiscountResponse) {
    const primeira = desconto?.tipo === 'ok' && !desconto.dados.discount;
    focarACaixa.current = true;
    setDesconto({ tipo: 'ok', dados: r });
    avisar(primeira ? 'Desconto do cupom das mensagens definido.' : 'Desconto do cupom das mensagens mudado. Vale para as próximas propostas.');
  }

  useEffect(() => {
    if (!focarTitulo.current || carga.tipo === 'carregando') return;
    focarTitulo.current = false;
    titulo.current?.focus({ preventScroll: true });
  }, [carga]);

  const tela = useMemo(() => (carga.tipo === 'ok' ? telaDasMensagens(carga.dados, agora) : null), [carga, agora]);
  const conta = useMemo(() => {
    if (carga.tipo !== 'ok') return null;
    return carga.dados.accounts.find((a) => a.connected_account_id === contaEscolhida) ?? carga.dados.accounts[0] ?? null;
  }, [carga, contaEscolhida]);
  const daConta = useMemo(() => (conta ? contaDaTela(conta, agora) : null), [conta, agora]);
  const pedido = useMemo(
    () => (conta ? faixaDosPedidos(esperando, conta.connected_account_id, { podeAprovar, souDono, eu: me.user.id }) : null),
    [esperando, conta, podeAprovar, souDono, me.user.id],
  );
  const campanhaAberta = aberta && conta ? (conta.campaigns.items.find((c) => c.id === aberta) ?? null) : null;

  if (!podeVer) {
    return (
      <Estado icone="lock" titulo="Esta tela é de quem acompanha as campanhas">
        O seu nível nesta empresa não mostra as mensagens enviadas. Se precisar, peça ao dono da conta.
      </Estado>
    );
  }

  function tentarDeNovo() {
    focarTitulo.current = true;
    if (erroMarcas) disparar(carregarMarcas());
    else setTentativa((t) => t + 1);
  }

  const problema = erroMarcas ?? (carga.tipo === 'erro' ? carga.problema : null);
  let corpo;
  if (problema) {
    corpo = (
      <div className="card">
        <Estado
          icone="alert-circle"
          perigo
          titulo="Não foi possível ler as mensagens"
          acao={
            <div className="vazio-acoes">
              <button className="btn btn--primary" type="button" onClick={tentarDeNovo}>
                <Icone nome="refresh" />
                Tentar de novo
              </button>
            </div>
          }
        >
          {mensagemDe(problema)} Nada mudou; tente de novo em instantes.
        </Estado>
      </div>
    );
  } else if (marcas && !marcas.length) {
    corpo = (
      <div className="card">
        <Estado icone="info" titulo="Nenhuma marca ativa nesta empresa">
          As mensagens são lidas por marca: quando a empresa tiver uma marca ativa, elas aparecem aqui.
        </Estado>
      </div>
    );
  } else if (carga.tipo !== 'ok' || !tela) {
    corpo = <MensagensCarregando />;
  } else if (tela.tipo === 'desligada') {
    corpo = (
      <div className="card">
        <Estado icone="send" titulo="As mensagens pelo RegemCast ainda não estão ligadas para esta empresa">
          Quem liga é a Liame, a pedido do dono. Com a função desligada, o Liame não lê nada do RegemCast.
        </Estado>
      </div>
    );
  } else if (tela.tipo === 'sem_regemcast' || !daConta) {
    corpo = (
      <div className="card">
        <Estado
          icone="plug"
          titulo="Conecte o RegemCast para acompanhar as mensagens"
          acao={
            podeVerContas ? (
              <div className="vazio-acoes">
                <Link className="btn btn--primary" href="/contas">
                  Abrir Contas conectadas
                </Link>
              </div>
            ) : undefined
          }
        >
          É o RegemCast que envia as mensagens de WhatsApp e guarda os contatos. Sem ele conectado a esta marca, não há o que mostrar aqui.
        </Estado>
      </div>
    );
  } else {
    corpo = (
      <MensagensConteudo
        conta={daConta}
        modo={modo}
        podeVerContas={podeVerContas}
        pedido={pedido}
        desconto={descontoNaTela}
        aoDefinirDesconto={() => setDefinindo(true)}
        aoLerDesconto={() => setLerDesconto((n) => n + 1)}
        aoVer={setAberta}
        aoTentarDeNovo={tentarDeNovo}
      />
    );
  }

  const contas = tela?.tipo === 'contas' ? tela.contas : [];
  const seletores =
    (marcas && marcas.length > 1) || contas.length > 1 ? (
      <div className="mens-filtros">
        {marcas && marcas.length > 1 && (
          <label className="res-campo">
            <span>Marca</span>
            <select className="input" id="mens-marca" value={marca ?? ''} onChange={(e) => setMarca(e.target.value)}>
              {marcas.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {contas.length > 1 && (
          <label className="res-campo">
            <span>Conta do RegemCast</span>
            <select
              className="input"
              id="mens-conta-sel"
              value={conta?.connected_account_id ?? ''}
              onChange={(e) => {
                setAberta(null);
                setContaEscolhida(e.target.value);
              }}
            >
              {contas.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nome}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    ) : null;

  return (
    <section aria-labelledby="h-mensagens">
      <div className="view-cab anima" style={{ ['--i' as string]: 0 }}>
        <div>
          <h1 id="h-mensagens" ref={titulo} tabIndex={-1}>
            Mensagens
          </h1>
          <p>As mensagens de WhatsApp que a sua empresa enviou pelo RegemCast, com o resultado de cada uma. Os números são lidos do RegemCast na hora.</p>
        </div>
        {tela?.tipo === 'contas' && daConta?.tipo === 'ok' && (
          <span className="lite-chip" id="mens-lido">
            {tela.lido}
          </span>
        )}
      </div>
      {seletores}
      {corpo}
      {campanhaAberta && conta && <GavetaMensagem key={campanhaAberta.id} contaId={conta.connected_account_id} campanha={campanhaAberta} agora={agora} reserva={titulo} aoFechar={() => setAberta(null)} />}
      {definindo && desconto?.tipo === 'ok' && (
        <GavetaDesconto resposta={desconto.dados} agora={agora} reserva={reservaDoDesconto} aoSalvar={descontoSalvo} aoFechar={() => setDefinindo(false)} />
      )}
    </section>
  );
}

function MensagensCarregando() {
  return (
    <div className="mens" aria-busy="true">
      <p className="sr-only">Carregando as mensagens…</p>
      <div className="card res-esqueleto" aria-hidden="true">
        <span className="esqueleto esqueleto--curto" />
        <span className="esqueleto esqueleto--alto" />
      </div>
      <div className="card res-esqueleto" aria-hidden="true">
        <span className="esqueleto esqueleto--medio" />
        <span className="esqueleto esqueleto--medio" />
        <span className="esqueleto esqueleto--medio" />
      </div>
    </div>
  );
}
