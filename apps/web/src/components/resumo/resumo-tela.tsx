'use client';

import type { BrandResponse, BudgetMonthResponse, SummaryResponse, TeamResponse } from '@liame/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Estado } from '@/components/ui/estado';
import { Icone } from '@/components/ui/icone';
import { useAgora } from '@/lib/agora';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { useModo } from '@/lib/modo';
import { useSessao } from '@/lib/sessao';
import { ResumoConteudo } from './resumo-conteudo';

// "Resumo" (mockups/prototipo-resumo.html, P8 aprovado em 03/10/2026): a página inicial do Lite. No Pro, a página
// inicial é a Atenção (protótipo geral aprovado): escolher Pro aqui leva para lá. A conta é do servidor
// (`GET /v1/summary`, `vendas.ver`); "o que a equipe fez" vem de `/v1/team` (quem vê campanhas e vendas) e a verba
// do mês, de `/v1/budget/month` (quem acompanha as campanhas; protótipo P9).

type Carga =
  | { tipo: 'carregando' }
  | { tipo: 'ok'; dados: SummaryResponse; equipe: TeamResponse | null; verba: BudgetMonthResponse | null; marca: string }
  | { tipo: 'erro'; problema: Problema };

export function ResumoTela() {
  const { me, pode } = useSessao();
  const { modo } = useModo();
  const router = useRouter();
  const podeVer = pode('vendas.ver');
  const podeVerEquipe = podeVer && pode('campanhas.ver');
  const podeVerVerba = podeVer && pode('campanhas.ver');
  const titulo = useRef<HTMLHeadingElement>(null);
  const [marcas, setMarcas] = useState<BrandResponse[] | null>(null);
  const [erroMarcas, setErroMarcas] = useState<Problema | null>(null);
  const [marca, setMarca] = useState<string | null>(null);
  const [carga, setCarga] = useState<Carga>({ tipo: 'carregando' });
  const [tentativa, setTentativa] = useState(0);
  const focarAoCarregar = useRef(false);
  const seq = useRef(0);
  const agora = useAgora(60_000, carga.tipo === 'ok' ? carga.dados.generated_at : null);
  const vaiParaAtencao = modo === 'pro' && pode('campanhas.ver');

  // No Pro, a página inicial é a Atenção.
  useEffect(() => {
    if (vaiParaAtencao) router.replace('/atencao');
  }, [vaiParaAtencao, router]);

  const carregarMarcas = useCallback(async () => {
    setErroMarcas(null);
    const r = await chamar(() => api.GET('/v1/brands'));
    if (!r.ok) return setErroMarcas(r.problema);
    const ativas = r.data.items.filter((b) => !b.archived_at);
    setMarcas(ativas);
    setMarca((m) => (m && ativas.some((b) => b.id === m) ? m : (ativas[0]?.id ?? null)));
  }, []);

  useEffect(() => {
    if (podeVer && !vaiParaAtencao) disparar(carregarMarcas());
  }, [podeVer, vaiParaAtencao, carregarMarcas]);

  useEffect(() => {
    if (!marca || vaiParaAtencao) return;
    const id = ++seq.current;
    setCarga({ tipo: 'carregando' });
    const query = { brand_id: marca };
    disparar(
      Promise.all([
        chamar(() => api.GET('/v1/summary', { params: { query } })),
        // A equipe é um cartão a mais: se a leitura dela falhar, o cartão some e o Resumo fica.
        podeVerEquipe ? chamar(() => api.GET('/v1/team', { params: { query } })) : Promise.resolve(null),
        // A verba do mês também: é da empresa (soma as contas de anúncio de todas as marcas).
        podeVerVerba ? chamar(() => api.GET('/v1/budget/month')) : Promise.resolve(null),
      ]).then(([r, e, v]) => {
        // Só a resposta mais nova vale (trocar de marca no meio de uma leitura não mistura números).
        if (id !== seq.current) return;
        setCarga(r.ok ? { tipo: 'ok', dados: r.data, equipe: e?.ok ? e.data : null, verba: v?.ok ? v.data : null, marca } : { tipo: 'erro', problema: r.problema });
      }),
    );
  }, [marca, tentativa, podeVerEquipe, podeVerVerba, vaiParaAtencao]);

  // Depois de "Tentar de novo", o foco vai para o título do Resumo que chegou.
  useEffect(() => {
    if (carga.tipo !== 'ok' || !focarAoCarregar.current) return;
    focarAoCarregar.current = false;
    titulo.current?.focus();
  }, [carga]);

  if (!podeVer) {
    return (
      <Estado
        icone="lock"
        titulo="O Resumo é de quem acompanha as vendas"
        acao={
          pode('campanhas.ver') ? (
            <div className="vazio-acoes">
              <Link className="btn btn--primary" href="/atencao">
                Abrir a Atenção
              </Link>
            </div>
          ) : undefined
        }
      >
        O seu nível nesta empresa não mostra as vendas. Se precisar, peça ao dono da conta.
      </Estado>
    );
  }
  if (vaiParaAtencao) return <ResumoCarregando texto="Abrindo a Atenção, a página inicial do Pro…" />;

  function tentarDeNovo() {
    focarAoCarregar.current = true;
    if (erroMarcas) disparar(carregarMarcas());
    else setTentativa((t) => t + 1);
  }

  if (erroMarcas || carga.tipo === 'erro') {
    const problema = erroMarcas ?? (carga.tipo === 'erro' ? carga.problema : null);
    return (
      <div className="card">
        <Estado
          icone="alert-circle"
          perigo
          titulo="Não foi possível carregar o resumo"
          acao={
            <div className="vazio-acoes">
              <button className="btn btn--primary" type="button" onClick={tentarDeNovo}>
                <Icone nome="refresh" />
                Tentar de novo
              </button>
            </div>
          }
        >
          {problema ? mensagemDe(problema) : 'Tente de novo em instantes.'} Nada foi perdido.
        </Estado>
      </div>
    );
  }
  if (marcas && !marcas.length) {
    return (
      <div className="card">
        <Estado icone="info" titulo="Nenhuma marca ativa nesta empresa">
          O Resumo é por marca: quando a empresa tiver uma marca ativa, o marketing dela aparece aqui.
        </Estado>
      </div>
    );
  }
  if (carga.tipo !== 'ok') return <ResumoCarregando texto="Carregando o resumo…" />;

  const nomeMarca = marcas?.find((m) => m.id === carga.marca)?.name ?? null;
  const seletor =
    marcas && marcas.length > 1 ? (
      <label className="res-campo resumo-marca">
        <span>Marca</span>
        <select className="input" value={marca ?? ''} onChange={(e) => setMarca(e.target.value)}>
          {marcas.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
    ) : null;

  return (
    <section aria-labelledby="h-resumo">
      <ResumoConteudo
        r={carga.dados}
        equipe={carga.equipe}
        verba={carga.verba}
        variasMarcas={(marcas?.length ?? 0) > 1}
        nomePessoa={me.user.name}
        nomeMarca={nomeMarca}
        agora={agora}
        pode={pode}
        seletor={seletor}
        tituloRef={titulo}
      />
    </section>
  );
}

function ResumoCarregando({ texto }: { texto: string }) {
  return (
    <div aria-busy="true">
      <h1 className="sr-only" id="h-resumo" tabIndex={-1}>
        Resumo
      </h1>
      <p className="sr-only">{texto}</p>
      <div className="dono-topo" aria-hidden="true">
        <span className="esqueleto esqueleto--curto" />
        <span className="esqueleto esqueleto--medio" />
      </div>
      <div className="stats3" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <div className="stat" key={i}>
            <span className="esqueleto esqueleto--medio" />
            <span className="esqueleto esqueleto--alto" />
          </div>
        ))}
      </div>
    </div>
  );
}
