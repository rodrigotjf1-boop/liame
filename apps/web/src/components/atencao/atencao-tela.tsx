'use client';

import type { BrandResponse } from '@liame/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { DialogoConectar } from '@/components/contas/dialogo-conectar';
import { liaLigada } from '@/components/explicar/pedir';
import { avisoTemExplicacao } from '@/components/explicar/textos';
import { useAvisar } from '@/components/ui/avisos';
import { Estado } from '@/components/ui/estado';
import { Faixa } from '@/components/ui/faixa';
import { Icone } from '@/components/ui/icone';
import { useAgora } from '@/lib/agora';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import { useContadorAtencao } from '@/lib/contador-atencao';
import { disparar } from '@/lib/disparar';
import { quandoComHora } from '@/lib/formato';
import { useModo } from '@/lib/modo';
import { useSessao } from '@/lib/sessao';
import { type Avisos, buscarAvisos } from './buscar-avisos';
import { ItemAviso } from './item-aviso';
import { contadorDoMenu, contagemPorGravidade, type Gravidade, GRAVIDADES, gravidadeDe, rotuloDoFiltro } from './textos';

// "Atenção de mídia" (mockups/prototipo-contas.html): o que precisa de alguém agora nas contas de anúncio
// e, para quem vê as vendas, entre a mídia e o caixa (Atenção do ciclo fechado, F9), do mais grave para o
// menos, com o motivo e o que fazer. É a tela "ver todos"; na home, os avisos entram como cartões numa
// fase futura (ux-modelo-interface §11).

type Carga =
  | { tipo: 'carregando' }
  | { tipo: 'ok'; dados: Avisos; semContas: boolean }
  | { tipo: 'erro'; problema: Problema };
type Filtro = Gravidade | 'todas';

export function AtencaoTela() {
  const { pode } = useSessao();
  const avisar = useAvisar();
  const contador = useContadorAtencao();
  const titulo = useRef<HTMLHeadingElement>(null);
  const [estado, setEstado] = useState<Carga>({ tipo: 'carregando' });
  const [filtro, setFiltro] = useState<Filtro>('todas');
  const [conectar, setConectar] = useState<BrandResponse[] | null>(null);
  /** Nulo até a tela saber (o botão "Explicar" só aparece depois, já no formato certo). */
  const [lia, setLia] = useState<boolean | null>(null);
  const agora = useAgora(60_000, estado);
  const podeVer = pode('campanhas.ver');
  const podeVerContas = pode('contas.ver');
  const podeConectar = pode('contas.conectar');
  const podeVerVendas = pode('vendas.ver');
  const { definir } = contador;
  const { modo, versao } = useModo();
  const router = useRouter();
  const versaoAoAbrir = useRef(versao);

  // A Atenção é a página inicial do Pro (protótipo P8): trocar para o Lite aqui leva ao Resumo, a do Lite. Quem
  // chega à Atenção já no Lite (por "Ver todos os avisos") fica nela.
  useEffect(() => {
    if (versao !== versaoAoAbrir.current && modo === 'lite' && podeVerVendas) router.replace('/resumo');
  }, [modo, versao, podeVerVendas, router]);

  /** Carrega os avisos; devolve se deu certo. */
  const carregar = useCallback(async (): Promise<boolean> => {
    const r = await buscarAvisos(podeVerVendas);
    if (!r.ok) {
      setEstado({ tipo: 'erro', problema: r.problema });
      return false;
    }
    definir(contadorDoMenu(r.data.items));
    // Sem avisos: "tudo em dia" só vale se há conta ligada; sem nenhuma, o convite é conectar.
    let semContas = false;
    if (!r.data.items.length && podeVerContas) {
      const f = await chamar(() => api.GET('/v1/media/freshness'));
      semContas = f.ok && !f.data.items.length;
    }
    setEstado({ tipo: 'ok', dados: r.data, semContas });
    return true;
  }, [definir, podeVerContas, podeVerVendas]);

  useEffect(() => {
    if (podeVer) disparar(carregar());
  }, [carregar, podeVer]);

  // "Explicar" (A3 · I4) é de quem vê as vendas. A LIA responde para a empresa? Decide o botão dela ou o neutro.
  useEffect(() => {
    if (!podeVer || !podeVerVendas) return;
    let vivo = true;
    disparar(
      liaLigada().then((ligada) => {
        if (vivo) setLia(ligada);
      }),
    );
    return () => {
      vivo = false;
    };
  }, [podeVer, podeVerVendas]);

  // A explicação de um aviso que saiu da lista com a tela aberta pede a lista de agora. O aviso some junto
  // com o botão que tinha o foco: o foco vai para o título da tela.
  async function atualizarAvisos() {
    const ok = await carregar();
    titulo.current?.focus();
    if (ok) avisar('Avisos atualizados.');
  }

  async function abrirConectar() {
    const r = await chamar(() => api.GET('/v1/brands'));
    if (!r.ok) return avisar(mensagemDe(r.problema), { tipo: 'perigo' });
    setConectar(r.data.items.filter((b) => !b.archived_at));
  }

  if (!podeVer) {
    return (
      <Estado icone="lock" titulo="Esta tela é de quem acompanha as campanhas">
        O seu nível nesta empresa não mostra os avisos de mídia. Se precisar, peça ao dono da conta.
      </Estado>
    );
  }

  const dados = estado.tipo === 'ok' ? estado.dados : null;
  const itens = dados?.items ?? [];
  const contagem = contagemPorGravidade(itens);
  const visiveis = filtro === 'todas' ? itens : itens.filter((i) => gravidadeDe(i.severity) === filtro);

  return (
    <section aria-labelledby="h-atencao">
      <div className="view-cab anima" style={{ ['--i' as string]: 0 }}>
        <div>
          <h1 id="h-atencao" ref={titulo} tabIndex={-1}>
            Atenção de mídia
          </h1>
          <p>
            {podeVerVendas
              ? 'O que precisa de alguém agora nas suas contas de anúncio e nas vendas das campanhas, do mais grave para o menos. Cada aviso diz o motivo e o que fazer.'
              : 'O que precisa de alguém agora nas suas contas de anúncio, do mais grave para o menos. Cada aviso diz o motivo e o que fazer.'}
          </p>
        </div>
        {dados && <span className="lite-chip">Atualizado {quandoComHora(dados.generated_at, agora)}</span>}
      </div>

      {estado.tipo === 'carregando' && <AvisosCarregando />}
      {estado.tipo === 'erro' && (
        <div className="card">
          <Estado
            icone="alert"
            perigo
            titulo="Não deu para carregar os avisos"
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

      {dados?.erroCiclo && (
        <Faixa
          icone={<Icone nome="info" />}
          titulo="Os avisos das vendas não carregaram agora"
          texto={`${mensagemDe(dados.erroCiclo)} Os avisos das contas de anúncio abaixo continuam valendo.`}
        />
      )}

      {estado.tipo === 'ok' && !itens.length && (
        <div className="card anima" style={{ ['--i' as string]: 1 }}>
          {estado.semContas ? (
            <Estado
              icone="plug"
              titulo="Nenhuma conta conectada ainda"
              acao={
                <Link className="btn btn--primary" href="/contas">
                  Abrir Contas conectadas
                </Link>
              }
            >
              Os avisos aparecem aqui quando a Meta e o Google estiverem conectados.
            </Estado>
          ) : (
            <Estado icone="check" ok titulo="Tudo em dia nas suas contas">
              Nenhuma conta parada, nenhum gasto fora do normal. Os números são conferidos todo dia de manhã.
            </Estado>
          )}
        </div>
      )}

      {itens.length > 0 && (
        <>
          <div className="filtros anima" style={{ ['--i' as string]: 1 }} role="group" aria-label="Filtrar por gravidade">
            {(['todas', ...GRAVIDADES] as Filtro[]).map((f) => (
              <button key={f} className="chip" type="button" aria-pressed={filtro === f} onClick={() => setFiltro(f)}>
                {rotuloDoFiltro(f)} <span className="num">{contagem[f]}</span>
              </button>
            ))}
          </div>
          {visiveis.length ? (
            <ul className="avisos-midia anima" style={{ ['--i' as string]: 2 }} aria-label="Avisos">
              {visiveis.map((item, i) => (
                <ItemAviso
                  key={`${item.kind}-${item.connected_account_id ?? ''}-${item.campaign_id ?? ''}-${item.provider ?? ''}-${i}`}
                  item={item}
                  podeVerContas={podeVerContas}
                  podeConectar={podeConectar}
                  podeVerVendas={podeVerVendas}
                  aoReconectar={() => disparar(abrirConectar())}
                  explicar={podeVerVendas && lia !== null && avisoTemExplicacao(item) ? { lia } : null}
                  aoAtualizar={() => disparar(atualizarAvisos())}
                />
              ))}
            </ul>
          ) : (
            <p className="seg-txt">Nenhum aviso com essa gravidade agora.</p>
          )}
        </>
      )}

      {conectar && (
        <DialogoConectar
          marcas={conectar}
          marcaInicial={null}
          reserva={titulo}
          aoFechar={() => setConectar(null)}
          aoIr={(a) => avisar(`Indo para a página ${a === 'meta' ? 'da Meta' : 'do Google'} para você autorizar…`)}
        />
      )}
    </section>
  );
}

function AvisosCarregando() {
  return (
    <ul className="avisos-midia" aria-busy="true" aria-label="Carregando os avisos">
      {[0, 1, 2].map((i) => (
        <li key={i} className="card aviso-midia" aria-hidden="true">
          <span className="esqueleto" style={{ width: 150, height: 22 }} />
          <span className="esqueleto" style={{ width: '55%', height: 16 }} />
          <span className="esqueleto" style={{ width: '80%', height: 12 }} />
        </li>
      ))}
    </ul>
  );
}
