'use client';

import type { AccountFreshness, BrandResponse, ConnectionResponse, GoogleConversionsResponse } from '@liame/contracts';
import { useRouter, useSearchParams } from 'next/navigation';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAvisar } from '@/components/ui/avisos';
import { Estado } from '@/components/ui/estado';
import { Faixa as FaixaDeAviso } from '@/components/ui/faixa';
import { Icone } from '@/components/ui/icone';
import { useAgora } from '@/lib/agora';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import { useContadorAtencao } from '@/lib/contador-atencao';
import { disparar } from '@/lib/disparar';
import { useSessao } from '@/lib/sessao';
import { CartaoAutorizacao } from './cartao-autorizacao';
import { CartaoAutorizacaoRegem } from './cartao-autorizacao-regem';
import { CartaoVendasGoogle } from './cartao-vendas-google';
import { DialogoConectar } from './dialogo-conectar';
import { DialogoConectarRegem } from './dialogo-conectar-regem';
import { DialogoConversao } from './dialogo-conversao';
import { DialogoEscolher } from './dialogo-escolher';
import { DialogoLojasRegem } from './dialogo-lojas-regem';
import { DialogoRevogar } from './dialogo-revogar';
import { FaixaVolta } from './faixa-volta';
import { type ContaDaTabela, LinhaConta } from './linha-conta';
import {
  artigo,
  autorizacoesVisiveis,
  autorizadorDa,
  type ContaExistente,
  contasExistentes,
  emConferencia,
  enderecoSeguro,
  escolhiveis,
  type Faixa,
  faixaDaVolta,
  faixaDoRegem,
  lerVolta,
  naPlataforma,
  semCusto,
  situacaoDaConta,
  situacaoDaLoja,
  subDaLoja,
} from './textos';
import { type ContaDasVendas, ESCOPO_DE_INFORMAR_VENDAS, esperaPorExtenso, juntarVendas, trocarAMarca, vendasPorAutorizacao } from './vendas-google';

// "Contas conectadas" (mockups/prototipo-contas.html e, para as lojas do Regem, prototipo-contas-regem.html,
// P2): as plataformas de onde a equipe lê os números, com o frescor de cada conta, as autorizações e a volta
// do OAuth (escolher, conferindo, recusada). A loja do Regem mostra a leitura dos pedidos e o que ela libera.
// Parte 2 da P2: "Conectar o Regem" (o diálogo que explica antes de ir), "Ligar as lojas do Regem" na volta e
// "Revogar" por loja — o Regem só é oferecido quando a API diz que dá para conectar (`available`).
// A5 · Y1 (mockups/prototipo-contas-conversoes.html, P14): com "vendas informadas ao Google" ligado para a marca,
// um cartão por conta do Google Ads depois da autorização do Google. Sem a função, a tela é a de sempre.
// Nenhum token passa pelo navegador; quem pode ver e conectar é o servidor que decide.

type Dados = {
  marcas: BrandResponse[];
  conexoes: ConnectionResponse[];
  contas: AccountFreshness[];
  disponiveis: string[];
  escritaRegem: boolean;
  /** As vendas informadas ao Google, uma resposta por marca lida. */
  vendas: GoogleConversionsResponse[];
  /** A leitura das vendas falhou agora e o que aparece é o da leitura anterior. */
  vendasDesatualizadas: boolean;
};
type Carga = { tipo: 'carregando' } | { tipo: 'ok'; dados: Dados } | { tipo: 'erro'; problema: Problema };
type Dialogo =
  | { tipo: 'conectar'; marca: string | null }
  | { tipo: 'regem'; marca: string | null }
  | { tipo: 'escolher'; conexao: ConnectionResponse }
  | { tipo: 'revogar'; conexao: ConnectionResponse }
  | { tipo: 'conversao'; vendas: ContaDasVendas };
/** A conexão sendo acompanhada: a da volta da plataforma ou a de um "procurar contas de novo". */
type Acompanhamento = { id: string; origem: 'volta' | 'procurar'; conexao: ConnectionResponse | null; tentativas: number; perdida: boolean };

/** Conferência curta: a cada 2 s, até 45 vezes (1,5 min). Depois, a pessoa pede de novo. */
const INTERVALO_MS = 2000;
const MAX_TENTATIVAS = 45;
/** As vendas informadas ao Google são lidas por marca: uma chamada para cada, até este tanto (a empresa comum tem uma). */
const MAX_MARCAS_COM_VENDAS = 8;

export function ContasTela() {
  const { empresa, pode } = useSessao();
  const avisar = useAvisar();
  // Ligar, desligar e revogar mudam os avisos de mídia: o número do menu é lido de novo.
  const { recarregar: recarregarAvisos } = useContadorAtencao();
  const router = useRouter();
  const params = useSearchParams();
  const volta = useMemo(() => lerVolta(params), [params]);
  const titulo = useRef<HTMLHeadingElement>(null);
  const [estado, setEstado] = useState<Carga>({ tipo: 'carregando' });
  const [filtro, setFiltro] = useState<'todas' | 'problema'>('todas');
  const [dialogo, setDialogo] = useState<Dialogo | null>(null);
  const [acomp, setAcomp] = useState<Acompanhamento | null>(() =>
    volta.conexao ? { id: volta.conexao, origem: 'volta', conexao: null, tentativas: 0, perdida: false } : null,
  );
  const agora = useAgora(60_000, estado);
  const podeVer = pode('contas.ver');
  const podeConectar = pode('contas.conectar');
  // A última leitura boa das vendas informadas ao Google, por marca (o cartão não some numa falha passageira).
  const vendasLidas = useRef<GoogleConversionsResponse[]>([]);
  // O cartão que recebe o foco depois de a pessoa escolher a conversão no diálogo.
  const [focoDasVendas, setFocoDasVendas] = useState({ conta: '', n: 0 });

  const carregar = useCallback(async () => {
    const [m, c, f] = await Promise.all([
      chamar(() => api.GET('/v1/brands')),
      chamar(() => api.GET('/v1/connections')),
      chamar(() => api.GET('/v1/media/freshness')),
    ]);
    if (!m.ok) return setEstado({ tipo: 'erro', problema: m.problema });
    if (!c.ok) return setEstado({ tipo: 'erro', problema: c.problema });
    if (!f.ok) return setEstado({ tipo: 'erro', problema: f.problema });
    const marcas = m.data.items.filter((b) => !b.archived_at);
    // As vendas informadas ao Google (A5, Y1), por marca. A função nasce desligada: sem ela, ou se a leitura falhar
    // sem nunca ter dado certo, a tela é a de sempre. Falha depois de uma leitura boa: fica o que havia, com o aviso.
    const comVendas = marcas.slice(0, MAX_MARCAS_COM_VENDAS);
    const lidas = await Promise.all(comVendas.map((b) => chamar(() => api.GET('/v1/conversions/google', { params: { query: { brand_id: b.id } } }))));
    const antes = vendasLidas.current;
    const guardada = (i: number) => antes.find((x) => x.brand_id === comVendas[i]?.id) ?? null;
    const vendas = lidas.flatMap((r, i) => {
      if (r.ok) return [r.data];
      const anterior = guardada(i);
      return anterior ? [anterior] : [];
    });
    const vendasDesatualizadas = lidas.some((r, i) => !r.ok && guardada(i)?.enabled === true);
    vendasLidas.current = vendas;
    setEstado({
      tipo: 'ok',
      dados: { marcas, conexoes: c.data.items, contas: f.data.items, disponiveis: c.data.available, escritaRegem: c.data.regem_write, vendas, vendasDesatualizadas },
    });
  }, []);

  useEffect(() => {
    if (podeVer) disparar(carregar());
  }, [carregar, podeVer]);

  // A URL mudou sem remontar a tela (menu, voltar do navegador): acompanha a conexão nova ou para.
  const conexaoDaUrl = volta.conexao;
  useEffect(() => {
    setAcomp((a) => {
      if (conexaoDaUrl) return a?.id === conexaoDaUrl ? a : { id: conexaoDaUrl, origem: 'volta', conexao: null, tentativas: 0, perdida: false };
      return a?.origem === 'volta' ? null : a;
    });
  }, [conexaoDaUrl]);

  const dados = estado.tipo === 'ok' ? estado.dados : null;
  const existentes = useMemo<ContaExistente[]>(() => (dados ? contasExistentes(dados.conexoes) : []), [dados]);

  // Conferência curta da conexão acompanhada, enquanto o worker troca o código e descobre as contas.
  useEffect(() => {
    if (!acomp || acomp.perdida) return;
    if (acomp.conexao && !emConferencia(acomp.conexao)) return;
    if (acomp.tentativas >= MAX_TENTATIVAS) return;
    const id = acomp.id;
    const t = setTimeout(
      () =>
        disparar(
          chamar(() => api.GET('/v1/connections/{id}', { params: { path: { id } } })).then((r) => {
            if (!r.ok && r.problema.status === 404) {
              return setAcomp((a) => (a && a.id === id ? { ...a, perdida: true } : a));
            }
            setAcomp((a) => (a && a.id === id ? { ...a, conexao: r.ok ? r.data : a.conexao, tentativas: a.tentativas + 1 } : a));
            // Terminou: a lista passa a mostrar a autorização e as contas como estão agora.
            if (r.ok && !emConferencia(r.data)) disparar(carregar());
          }),
        ),
      acomp.tentativas === 0 ? 0 : INTERVALO_MS,
    );
    return () => clearTimeout(t);
  }, [acomp, carregar]);

  // "Procurar contas de novo" que não achou nada novo: só avisa (a faixa é para quando há o que escolher).
  useEffect(() => {
    if (!acomp || acomp.origem !== 'procurar' || !acomp.conexao || emConferencia(acomp.conexao)) return;
    if (acomp.conexao.status !== 'erro' && escolhiveis(acomp.conexao, existentes).length) return;
    const a = autorizadorDa(acomp.conexao.provider);
    if (acomp.conexao.status === 'erro') avisar(`Não deu para procurar as contas ${naPlataforma(a)}. Veja a autorização abaixo.`, { tipo: 'perigo' });
    else avisar(`Nenhuma conta nova ${naPlataforma(a)}.`);
    setAcomp(null);
  }, [acomp, avisar, existentes]);

  const nomeDaMarca = useCallback(
    (id: string | null | undefined) => dados?.marcas.find((m) => m.id === id)?.name ?? empresa?.name ?? 'sua marca',
    [dados, empresa],
  );

  // O Regem só é oferecido (conectar, conectar de novo, autorizar de novo) quando a API diz que dá para começar.
  const podeRegem = Boolean(dados?.disponiveis.includes('regem'));
  const linhas = useMemo<(ContaDaTabela & { loja?: { scopes: string[]; origem: string } })[]>(() => {
    if (!dados) return [];
    const ligadas = new Map(dados.conexoes.flatMap((c) => c.accounts).map((a) => [a.id, a]));
    const variasMarcas = new Set(dados.contas.map((c) => c.brand_id)).size > 1;
    const origemDa = new Map(dados.conexoes.map((c) => [c.id, c.origin]));
    return dados.contas.map((c) => {
      const ligada = ligadas.get(c.connected_account_id);
      const base = {
        id: c.connected_account_id,
        nome: c.name,
        provider: c.provider,
        externalId: ligada?.external_id ?? null,
        marca: variasMarcas ? (dados.marcas.find((m) => m.id === c.brand_id)?.name ?? null) : null,
        brandId: c.brand_id,
      };
      // A loja do Regem: a leitura dos pedidos, o que ela libera e a loja do Liame no lugar do id.
      if (c.provider === 'regem') {
        const loja = { scopes: ligada?.scopes ?? [], origem: (ligada?.connection_id && origemDa.get(ligada.connection_id)) || 'oauth' };
        const situacao = situacaoDaLoja(c, loja, agora);
        return { ...base, sub: subDaLoja(ligada?.unit_name ?? null), revogar: true, situacao: { ...situacao, reconectar: situacao.reconectar && podeRegem }, loja };
      }
      return { ...base, situacao: situacaoDaConta(c) };
    });
  }, [dados, agora, podeRegem]);
  const avisoDoRegem = useMemo(
    () =>
      faixaDoRegem(
        linhas.flatMap((l) =>
          'loja' in l && l.loja
            ? [{ nome: l.nome, desconectada: l.situacao.rotulo === 'Desconectada', semCusto: l.situacao.tom !== 'lendo' && semCusto(l.loja.scopes), origem: l.loja.origem }]
            : [],
        ),
      ),
    [linhas],
  );
  const autorizacoes = useMemo(() => (dados ? autorizacoesVisiveis(dados.conexoes) : []), [dados]);
  // Vendas informadas ao Google: as marcas com a função ligada e o cartão de cada conta, depois da autorização que a lê.
  const vendas = useMemo(() => juntarVendas(dados?.vendas ?? []), [dados]);
  const vendasDaAutorizacao = useMemo(() => vendasPorAutorizacao(vendas.contas, dados?.conexoes ?? [], autorizacoes), [vendas, dados, autorizacoes]);
  // Quem chega pelo atalho de Resultados ou da Atenção (`#vendas-<conta>`, ou `#vendas-google` para o primeiro cartão)
  // cai no cartão da conta, uma vez, quando os cartões aparecem (eles só existem depois da leitura).
  const levouAoCartao = useRef(false);
  useEffect(() => {
    if (levouAoCartao.current || !vendas.contas.length) return;
    const alvo = window.location.hash.slice(1);
    if (!alvo.startsWith('vendas-')) return;
    const cartao = document.getElementById(alvo) ?? document.querySelector<HTMLElement>('.autorizacao--larga[id^="vendas-"]');
    if (!cartao) return;
    levouAoCartao.current = true;
    cartao.scrollIntoView({ block: 'start' });
    cartao.focus({ preventScroll: true });
  }, [vendas]);

  if (!podeVer) {
    return (
      <Estado icone="lock" titulo="Esta tela é de quem cuida das contas de anúncio">
        O seu nível nesta empresa não mostra as contas conectadas. Se precisar, peça ao dono da conta.
      </Estado>
    );
  }

  const problemas = linhas.filter((l) => l.situacao.precisaDeVoce).length;
  const visiveis = filtro === 'problema' ? linhas.filter((l) => l.situacao.precisaDeVoce) : linhas;
  const marcas = dados?.marcas ?? [];
  const umaMarca = new Set(linhas.map((l) => l.brandId)).size <= 1;
  const legenda = umaMarca ? `Contas ligadas à marca ${nomeDaMarca(linhas[0]?.brandId ?? marcas[0]?.id)}` : `Contas ligadas às marcas da ${empresa?.name ?? 'empresa'}`;

  // Faixa da volta: erro da URL, conexão perdida, ou o que a conexão acompanhada mostra agora.
  let faixa: Faixa | null = null;
  const marcaDaVolta = nomeDaMarca(acomp?.conexao?.brand_id);
  if (volta.erro) faixa = faixaDaVolta(volta, acomp?.conexao ?? null, marcaDaVolta);
  else if (acomp?.perdida) faixa = faixaDaVolta({ conexao: acomp.id, erro: 'autorizacao_invalida' }, null, marcaDaVolta);
  else if (acomp && acomp.origem === 'volta' && !acomp.conexao)
    faixa =
      acomp.tentativas >= MAX_TENTATIVAS
        ? { tipo: 'demorando', titulo: 'Ainda conferindo a autorização.', texto: 'Está levando mais que o normal. As contas aparecem aqui assim que a conferência terminar.' }
        : { tipo: 'conferindo', titulo: 'Conferindo a autorização…', texto: 'Estamos buscando as contas que você liberou. Leva alguns segundos; pode continuar usando o Liame.' };
  else if (acomp?.conexao) {
    const f = faixaDaVolta({ conexao: acomp.id, erro: null }, acomp.conexao, marcaDaVolta, { esgotou: acomp.tentativas >= MAX_TENTATIVAS, existentes });
    // O "procurar de novo" só ganha faixa quando há contas para escolher; a espera aparece no cartão.
    if (acomp.origem === 'procurar') {
      const n = f?.tipo === 'escolher' ? escolhiveis(acomp.conexao, existentes).length : 0;
      const onde = naPlataforma(autorizadorDa(acomp.conexao.provider));
      faixa = f?.tipo === 'escolher' ? { ...f, titulo: `Encontramos ${n} ${n === 1 ? 'conta para ligar' : 'contas para ligar'} ${onde}.` } : null;
    } else faixa = f;
  }

  function limparVolta() {
    setAcomp(null);
    if (params.has('conexao') || params.has('erro')) router.replace('/contas', { scroll: false });
  }

  async function desligar(l: ContaDaTabela): Promise<boolean> {
    const r = await chamar(() => api.DELETE('/v1/connected-accounts/{id}', { params: { path: { id: l.id } } }));
    if (!r.ok) {
      avisar(mensagemDe(r.problema), { tipo: 'perigo' });
      return false;
    }
    avisar(
      l.revogar
        ? 'Loja desligada. O token foi revogado no Regem e no Liame; o que já foi lido segue o prazo de guarda.'
        : 'Conta desligada. O histórico de números fica.',
    );
    recarregarAvisos();
    await carregar();
    titulo.current?.focus({ preventScroll: true });
    return true;
  }

  async function procurar(c: ConnectionResponse) {
    const r = await chamar(() => api.POST('/v1/connections/{id}/discover', { params: { path: { id: c.id } } }));
    if (!r.ok) return avisar(mensagemDe(r.problema), { tipo: 'perigo' });
    avisar(`Procurando contas novas ${naPlataforma(autorizadorDa(c.provider))}. Aparecem aqui em alguns segundos.`);
    setAcomp({ id: c.id, origem: 'procurar', conexao: r.data, tentativas: 1, perdida: false });
  }

  /** A resposta de escolher, voltar ou parar traz a situação nova das contas da marca: entra no lugar da antiga. */
  function aplicarVendas(resposta: GoogleConversionsResponse) {
    vendasLidas.current = trocarAMarca(vendasLidas.current, resposta);
    setEstado((e) => (e.tipo === 'ok' ? { tipo: 'ok', dados: { ...e.dados, vendas: trocarAMarca(e.dados.vendas, resposta) } } : e));
  }

  async function pararVendas(v: ContaDasVendas): Promise<boolean> {
    const r = await chamar(() => api.POST('/v1/conversions/google/destination/stop', { body: { connected_account_id: v.conta.connected_account_id } }));
    if (!r.ok) {
      avisar(mensagemDe(r.problema), { tipo: 'perigo' });
      return false;
    }
    aplicarVendas(r.data);
    avisar('O Liame parou de informar as vendas ao Google. Dá para voltar quando quiser.');
    return true;
  }

  /** Voltar depois de uma parada é escolher de novo a mesma conversão: o servidor a confere no Google e recomeça de agora. */
  async function voltarVendas(v: ContaDasVendas): Promise<boolean> {
    const conversao = v.conta.destination?.conversion_action_id;
    if (!conversao) return false;
    const r = await chamar(() =>
      api.PUT('/v1/conversions/google/destination', { body: { connected_account_id: v.conta.connected_account_id, conversion_action_id: conversao } }),
    );
    if (!r.ok) {
      avisar(mensagemDe(r.problema), { tipo: 'perigo' });
      // A conversão de antes não existe mais no Google: a saída é escolher outra.
      if (r.problema.code === 'conversao-nao-encontrada') setDialogo({ tipo: 'conversao', vendas: v });
      return false;
    }
    aplicarVendas(r.data);
    avisar('O Liame voltou a informar as vendas. Só entram os pedidos confirmados a partir de agora.');
    return true;
  }

  /** "Autorizar o Google de novo": direto para a página do Google, com a marca da conta. Verdadeiro = está indo. */
  async function autorizarGoogle(brandId: string): Promise<boolean> {
    const r = await chamar(() => api.POST('/v1/connections', { body: { provider: 'google', brand_id: brandId } }));
    if (!r.ok) {
      avisar(mensagemDe(r.problema), { tipo: 'perigo' });
      return false;
    }
    const destino = enderecoSeguro(r.data.authorize_url);
    if (!destino) {
      avisar('A plataforma devolveu um endereço inválido. Tente de novo; se continuar, fale com o suporte.', { tipo: 'perigo' });
      return false;
    }
    avisar('Indo para a página do Google para você autorizar…');
    window.location.assign(destino);
    return true;
  }

  /** A conversão foi escolhida no diálogo: a situação nova entra na tela e o foco vai para o cartão da conta. */
  function conversaoEscolhida(v: ContaDasVendas, resposta: GoogleConversionsResponse) {
    const antes = v.conta.destination;
    const depois = resposta.accounts.find((a) => a.connected_account_id === v.conta.connected_account_id)?.destination ?? null;
    // Confirmar a mesma conversão, com ela informando, não muda nada no servidor: o aviso não promete um recomeço.
    const igual = antes !== null && antes.stopped_at === null && depois !== null && depois.conversion_action_id === antes.conversion_action_id && depois.starts_at === antes.starts_at;
    aplicarVendas(resposta);
    setDialogo(null);
    setFocoDasVendas((f) => ({ conta: v.conta.connected_account_id, n: f.n + 1 }));
    avisar(
      igual
        ? 'Nada mudou: o Liame já informa as vendas para esta conversão.'
        : `Pronto. O Liame começa a informar as vendas confirmadas a partir de agora; a primeira sai ${esperaPorExtenso(v.esperaMin)} depois da confirmação.`,
    );
  }

  const cartaoDasVendas = (v: ContaDasVendas) => (
    <CartaoVendasGoogle
      key={v.conta.connected_account_id}
      conta={v.conta}
      agora={agora}
      esperaMin={v.esperaMin}
      janelaDias={v.janelaDias}
      podeGerir={v.podeGerir}
      pedirFoco={focoDasVendas.conta === v.conta.connected_account_id ? focoDasVendas.n : 0}
      aoAutorizar={() => autorizarGoogle(v.brandId)}
      aoEscolher={() => setDialogo({ tipo: 'conversao', vendas: v })}
      aoParar={() => pararVendas(v)}
      aoVoltar={() => voltarVendas(v)}
    />
  );

  const conexaoDaFaixa = acomp?.conexao ?? null;
  const vazio = dados !== null && !linhas.length && !autorizacoes.length;
  return (
    <section aria-labelledby="h-contas">
      <div className="view-cab anima" style={{ ['--i' as string]: 0 }}>
        <div>
          <h1 id="h-contas" ref={titulo} tabIndex={-1}>
            Contas conectadas
          </h1>
          <p>As plataformas de onde a equipe lê os seus números. Você só autoriza; nenhuma senha ou token aparece aqui.</p>
        </div>
        {podeConectar && (
          <button className="btn btn--primary" type="button" disabled={!dados || !marcas.length} onClick={() => setDialogo({ tipo: 'conectar', marca: null })}>
            <Icone nome="plus" />
            Conectar plataforma
          </button>
        )}
      </div>

      {faixa && (
        <FaixaVolta
          faixa={faixa}
          aoEscolher={() => conexaoDaFaixa && setDialogo({ tipo: 'escolher', conexao: conexaoDaFaixa })}
          aoTentarDeNovo={
            podeConectar && dados
              ? () => setDialogo({ tipo: conexaoDaFaixa?.provider === 'regem' && podeRegem ? 'regem' : 'conectar', marca: conexaoDaFaixa?.brand_id ?? null })
              : null
          }
          aoConferirDeNovo={() => setAcomp((a) => (a ? { ...a, tentativas: 0 } : a))}
        />
      )}

      {avisoDoRegem && (
        <FaixaDeAviso
          tipo={avisoDoRegem.tipo}
          icone={<Icone nome={avisoDoRegem.tipo === 'perigo' ? 'alert-circle' : 'alert'} />}
          titulo={avisoDoRegem.titulo}
          texto={avisoDoRegem.texto}
          acao={
            podeConectar && podeRegem ? (
              <button
                className={avisoDoRegem.tipo === 'perigo' ? 'btn btn--primary' : 'btn'}
                type="button"
                onClick={() => setDialogo({ tipo: 'regem', marca: linhas.find((l) => l.loja)?.brandId ?? null })}
              >
                {avisoDoRegem.botao}
              </button>
            ) : undefined
          }
        />
      )}

      {estado.tipo === 'carregando' && <TabelaCarregando />}
      {estado.tipo === 'erro' && (
        <div className="card">
          <Estado
            icone="alert"
            perigo
            titulo="Não deu para carregar as contas"
            acao={
              <button className="btn" type="button" onClick={() => disparar(carregar())}>
                <Icone nome="refresh" />
                Tentar de novo
              </button>
            }
          >
            {mensagemDe(estado.problema)}
          </Estado>
        </div>
      )}

      {vazio && (
        <div className="card anima" style={{ ['--i' as string]: 1 }}>
          <Estado
            icone="plug"
            titulo="Conecte suas plataformas de anúncio"
            acao={
              podeConectar && marcas.length ? (
                <div className="vazio-acoes">
                  <button className="btn btn--primary" type="button" onClick={() => setDialogo({ tipo: 'conectar', marca: null })}>
                    Conectar a Meta
                  </button>
                  <button className="btn" type="button" onClick={() => setDialogo({ tipo: 'conectar', marca: null })}>
                    Conectar o Google (Ads e Analytics)
                  </button>
                  {podeRegem && (
                    <button className="btn" type="button" onClick={() => setDialogo({ tipo: 'regem', marca: null })}>
                      Conectar o Regem (vendas)
                    </button>
                  )}
                </div>
              ) : undefined
            }
          >
            {podeConectar
              ? `Com a Meta e o Google conectados, a equipe lê gasto, cliques, conversas e vendas todo dia, e avisa quando algo sai do normal.${
                  podeRegem ? ' Com o Regem, o Liame confirma no caixa quais pedidos vieram dos anúncios.' : ''
                }`
              : 'Nenhuma plataforma conectada ainda. Quem administra a conta conecta a Meta e o Google aqui.'}
          </Estado>
        </div>
      )}

      {dados && linhas.length > 0 && (
        <div className="anima" style={{ ['--i' as string]: 1 }}>
          <div className="filtros" role="group" aria-label="Filtrar contas">
            <button className="chip" type="button" aria-pressed={filtro === 'todas'} onClick={() => setFiltro('todas')}>
              Todas <span className="num">{linhas.length}</span>
            </button>
            <button className="chip" type="button" aria-pressed={filtro === 'problema'} onClick={() => setFiltro('problema')}>
              Precisam de você <span className="num">{problemas}</span>
            </button>
          </div>
          <div className="table-wrap contas-tabela">
            <table className="tabela">
              <caption className="sr-only">{legenda}</caption>
              <thead>
                <tr>
                  <th scope="col">Conta</th>
                  <th scope="col">Plataforma</th>
                  <th scope="col">Dados</th>
                  <th scope="col">Última leitura</th>
                  <th scope="col">
                    <span className="sr-only">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visiveis.map((l) => (
                  <LinhaConta
                    key={l.id}
                    conta={l}
                    agora={agora}
                    podeConectar={podeConectar}
                    aoReconectar={() => setDialogo({ tipo: l.provider === 'regem' ? 'regem' : 'conectar', marca: l.brandId })}
                    aoDesligar={() => desligar(l)}
                  />
                ))}
                {!visiveis.length && (
                  <tr className="linha-vazia">
                    <td colSpan={5}>Nenhuma conta precisa de você agora.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {dados && (autorizacoes.length > 0 || vendas.contas.length > 0) && (
        <div className="anima" style={{ ['--i' as string]: 2 }}>
          <h2 className="sub-titulo">Autorizações</h2>
          <p className="sub-desc">Cada autorização é o &ldquo;sim&rdquo; que alguém deu na Meta, no Google ou no Regem. Revogar para a leitura de todas as contas dela.</p>
          {dados.vendasDesatualizadas && (
            <p className="aut-txt aut-txt--atencao conv-desatualizado" role="status">
              <Icone nome="alert" pequeno />
              <span>Não deu para atualizar as vendas informadas ao Google agora. O que aparece é o da última leitura.</span>
              <button className="btn btn--sm" type="button" onClick={() => disparar(carregar())}>
                Tentar de novo
              </button>
            </p>
          )}
          <ul className="autorizacoes">
            {autorizacoes.map((c) => (
              <Fragment key={c.id}>
              {c.provider === 'regem' ? (
                <CartaoAutorizacaoRegem
                  conexao={c}
                  podeConectar={podeConectar}
                  aoEscolher={c.status === 'aguardando_escolha' && escolhiveis(c, existentes).length ? () => setDialogo({ tipo: 'escolher', conexao: c }) : null}
                  aoConectar={podeRegem ? () => setDialogo({ tipo: 'regem', marca: c.brand_id }) : null}
                  aoRevogar={() => setDialogo({ tipo: 'revogar', conexao: c })}
                  escritaLigada={Boolean(dados?.escritaRegem)}
                />
              ) : (
              <CartaoAutorizacao
                conexao={c}
                agora={agora}
                podeConectar={podeConectar}
                informaVendas={vendas.marcas.has(c.brand_id) && c.scopes.includes(ESCOPO_DE_INFORMAR_VENDAS)}
                procurando={acomp?.origem === 'procurar' && acomp.id === c.id && (!acomp.conexao || emConferencia(acomp.conexao))}
                aoEscolher={
                  // Esperando a escolha, ou já valendo e com conta de outra autorização que vence antes (renovar).
                  (c.status === 'aguardando_escolha' && escolhiveis(c, existentes).length) || (c.status === 'ativa' && escolhiveis(c, existentes).some((o) => o.renovar || o.permissao))
                    ? () => setDialogo({ tipo: 'escolher', conexao: c })
                    : null
                }
                aoReconectar={() => setDialogo({ tipo: 'conectar', marca: c.brand_id })}
                aoProcurar={() => disparar(procurar(c))}
                aoRevogar={() => setDialogo({ tipo: 'revogar', conexao: c })}
              />
              )}
              {(vendasDaAutorizacao.get(c.id) ?? []).map(cartaoDasVendas)}
              </Fragment>
            ))}
            {(vendasDaAutorizacao.get('') ?? []).map(cartaoDasVendas)}
          </ul>
        </div>
      )}

      {dialogo?.tipo === 'conectar' && (
        <DialogoConectar
          marcas={marcas}
          marcaInicial={dialogo.marca}
          reserva={titulo}
          aoFechar={() => setDialogo((d) => (d?.tipo === 'conectar' ? null : d))}
          aoIr={(a) => avisar(`Indo para a página ${a === 'meta' ? 'da Meta' : 'do Google'} para você autorizar…`)}
          aoRegem={podeRegem ? (marca) => setDialogo({ tipo: 'regem', marca }) : null}
          vendasAoGoogle={vendas.marcas}
        />
      )}
      {dialogo?.tipo === 'regem' && (
        <DialogoConectarRegem
          marcas={marcas}
          marcaInicial={dialogo.marca}
          reserva={titulo}
          aoFechar={() => setDialogo((d) => (d?.tipo === 'regem' ? null : d))}
          aoIr={() => avisar('Indo para o Regem para o presidente autorizar…')}
        />
      )}
      {dialogo?.tipo === 'escolher' && dialogo.conexao.provider === 'regem' && (
        <DialogoLojasRegem
          conexao={dialogo.conexao}
          existentes={existentes}
          reserva={titulo}
          escritaLigada={Boolean(dados?.escritaRegem)}
          aoFechar={() => setDialogo(null)}
          aoLigar={(texto) => {
            avisar(texto);
            limparVolta();
            recarregarAvisos();
            disparar(carregar());
          }}
        />
      )}
      {dialogo?.tipo === 'escolher' && dialogo.conexao.provider !== 'regem' && (
        <DialogoEscolher
          conexao={dialogo.conexao}
          existentes={existentes}
          marca={nomeDaMarca(dialogo.conexao.brand_id)}
          reserva={titulo}
          aoFechar={() => setDialogo(null)}
          aoLigar={(texto) => {
            avisar(texto);
            limparVolta();
            recarregarAvisos();
            disparar(carregar());
          }}
        />
      )}
      {dialogo?.tipo === 'conversao' && (
        <DialogoConversao
          conta={dialogo.vendas.conta}
          esperaMin={dialogo.vendas.esperaMin}
          reserva={titulo}
          aoFechar={() => setDialogo((d) => (d?.tipo === 'conversao' ? null : d))}
          aoEscolher={(resposta) => conversaoEscolhida(dialogo.vendas, resposta)}
          aoAutorizar={() => disparar(autorizarGoogle(dialogo.vendas.brandId))}
        />
      )}
      {dialogo?.tipo === 'revogar' && (
        <DialogoRevogar
          conexao={dialogo.conexao}
          reserva={titulo}
          aoFechar={() => setDialogo(null)}
          aoRevogar={() => {
            avisar('Autorização revogada. A leitura das contas dela parou.');
            recarregarAvisos();
            disparar(carregar());
          }}
        />
      )}
    </section>
  );
}

function TabelaCarregando() {
  return (
    <div className="table-wrap" aria-busy="true">
      <p className="sr-only">Carregando as contas…</p>
      <div style={{ display: 'grid', gap: 14, padding: 16 }} aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: 16 }}>
            <span className="esqueleto" style={{ height: 14 }} />
            <span className="esqueleto" style={{ height: 14 }} />
            <span className="esqueleto" style={{ height: 14 }} />
            <span className="esqueleto" style={{ height: 14 }} />
          </span>
        ))}
      </div>
    </div>
  );
}
