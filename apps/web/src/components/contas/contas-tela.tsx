'use client';

import type { AccountFreshness, BrandResponse, ConnectionResponse } from '@liame/contracts';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { DialogoConectar } from './dialogo-conectar';
import { DialogoConectarRegem } from './dialogo-conectar-regem';
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

// "Contas conectadas" (mockups/prototipo-contas.html e, para as lojas do Regem, prototipo-contas-regem.html,
// P2): as plataformas de onde a equipe lê os números, com o frescor de cada conta, as autorizações e a volta
// do OAuth (escolher, conferindo, recusada). A loja do Regem mostra a leitura dos pedidos e o que ela libera.
// Parte 2 da P2: "Conectar o Regem" (o diálogo que explica antes de ir), "Ligar as lojas do Regem" na volta e
// "Revogar" por loja — o Regem só é oferecido quando a API diz que dá para conectar (`available`).
// Nenhum token passa pelo navegador; quem pode ver e conectar é o servidor que decide.

type Dados = { marcas: BrandResponse[]; conexoes: ConnectionResponse[]; contas: AccountFreshness[]; disponiveis: string[]; escritaRegem: boolean };
type Carga = { tipo: 'carregando' } | { tipo: 'ok'; dados: Dados } | { tipo: 'erro'; problema: Problema };
type Dialogo =
  | { tipo: 'conectar'; marca: string | null }
  | { tipo: 'regem'; marca: string | null }
  | { tipo: 'escolher'; conexao: ConnectionResponse }
  | { tipo: 'revogar'; conexao: ConnectionResponse };
/** A conexão sendo acompanhada: a da volta da plataforma ou a de um "procurar contas de novo". */
type Acompanhamento = { id: string; origem: 'volta' | 'procurar'; conexao: ConnectionResponse | null; tentativas: number; perdida: boolean };

/** Conferência curta: a cada 2 s, até 45 vezes (1,5 min). Depois, a pessoa pede de novo. */
const INTERVALO_MS = 2000;
const MAX_TENTATIVAS = 45;

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

  const carregar = useCallback(async () => {
    const [m, c, f] = await Promise.all([
      chamar(() => api.GET('/v1/brands')),
      chamar(() => api.GET('/v1/connections')),
      chamar(() => api.GET('/v1/media/freshness')),
    ]);
    if (!m.ok) return setEstado({ tipo: 'erro', problema: m.problema });
    if (!c.ok) return setEstado({ tipo: 'erro', problema: c.problema });
    if (!f.ok) return setEstado({ tipo: 'erro', problema: f.problema });
    setEstado({ tipo: 'ok', dados: { marcas: m.data.items.filter((b) => !b.archived_at), conexoes: c.data.items, contas: f.data.items, disponiveis: c.data.available, escritaRegem: c.data.regem_write } });
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

      {dados && autorizacoes.length > 0 && (
        <div className="anima" style={{ ['--i' as string]: 2 }}>
          <h2 className="sub-titulo">Autorizações</h2>
          <p className="sub-desc">Cada autorização é o &ldquo;sim&rdquo; que alguém deu na Meta, no Google ou no Regem. Revogar para a leitura de todas as contas dela.</p>
          <ul className="autorizacoes">
            {autorizacoes.map((c) =>
              c.provider === 'regem' ? (
                <CartaoAutorizacaoRegem
                  key={c.id}
                  conexao={c}
                  podeConectar={podeConectar}
                  aoEscolher={c.status === 'aguardando_escolha' && escolhiveis(c, existentes).length ? () => setDialogo({ tipo: 'escolher', conexao: c }) : null}
                  aoConectar={podeRegem ? () => setDialogo({ tipo: 'regem', marca: c.brand_id }) : null}
                  aoRevogar={() => setDialogo({ tipo: 'revogar', conexao: c })}
                  escritaLigada={Boolean(dados?.escritaRegem)}
                />
              ) : (
              <CartaoAutorizacao
                key={c.id}
                conexao={c}
                agora={agora}
                podeConectar={podeConectar}
                procurando={acomp?.origem === 'procurar' && acomp.id === c.id && (!acomp.conexao || emConferencia(acomp.conexao))}
                aoEscolher={
                  // Esperando a escolha, ou já valendo e com conta de outra autorização que vence antes (renovar).
                  (c.status === 'aguardando_escolha' && escolhiveis(c, existentes).length) || (c.status === 'ativa' && escolhiveis(c, existentes).some((o) => o.renovar))
                    ? () => setDialogo({ tipo: 'escolher', conexao: c })
                    : null
                }
                aoReconectar={() => setDialogo({ tipo: 'conectar', marca: c.brand_id })}
                aoProcurar={() => disparar(procurar(c))}
                aoRevogar={() => setDialogo({ tipo: 'revogar', conexao: c })}
              />
              ),
            )}
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
