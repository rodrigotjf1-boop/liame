'use client';

import type { BrandResponse, MonthlyReportResponse } from '@liame/contracts';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Estado } from '@/components/ui/estado';
import { Icone } from '@/components/ui/icone';
import { api, chamar, mensagemDe, type Problema } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { useSessao } from '@/lib/sessao';
import { RelatorioConteudo } from './relatorio-conteudo';
import { introDoRelatorio, mesEscrito, mesQueFecha, mesValido, naData } from './textos';

// "Relatório do mês" (mockups/prototipo-relatorio-mes.html, P24 aprovado em 21/10/2026): o mês fechado da loja, como
// foi gerado no dia 1º de manhã. Abre pelo cabeçalho dos Resultados e pelo link do e-mail do mês (`?marca` e `?mes`,
// AAAA-MM). A conta é do servidor; a tela só mostra. O casco é o da Revisão da semana.

type Carga =
  | { tipo: 'carregando' }
  | { tipo: 'ok'; dados: MonthlyReportResponse; marca: string; mes: string | null }
  | { tipo: 'erro'; problema: Problema };

export function RelatorioTela() {
  const { pode } = useSessao();
  const params = useSearchParams();
  const podeVer = pode('vendas.ver');
  const titulo = useRef<HTMLHeadingElement>(null);
  const [marcas, setMarcas] = useState<BrandResponse[] | null>(null);
  const [erroMarcas, setErroMarcas] = useState<Problema | null>(null);
  const [marca, setMarca] = useState<string | null>(null);
  const [carga, setCarga] = useState<Carga>({ tipo: 'carregando' });
  const [tentativa, setTentativa] = useState(0);
  const seq = useRef(0);
  const marcaPedida = params.get('marca');
  const mes = mesValido(params.get('mes'));

  const carregarMarcas = useCallback(async () => {
    setErroMarcas(null);
    const r = await chamar(() => api.GET('/v1/brands'));
    if (!r.ok) return setErroMarcas(r.problema);
    const ativas = r.data.items.filter((b) => !b.archived_at);
    setMarcas(ativas);
    // A marca do link, se é desta empresa, vale cada vez que a pessoa chega por ele (ERR-159: o Next guarda a tela
    // visitada com a marca de antes, e a chave desse estado não leva os parâmetros da busca); sem link, a que já estava
    // aberta; senão, a primeira (como na tela Resultados).
    setMarca((m) => ativas.find((b) => b.id === marcaPedida)?.id ?? (m && ativas.some((b) => b.id === m) ? m : (ativas[0]?.id ?? null)));
  }, [marcaPedida]);
  // O link de outra marca se aplica ainda no desenho, sem mostrar o relatório da marca de antes enquanto as marcas são lidas.
  const [marcaDoEndereco, setMarcaDoEndereco] = useState(marcaPedida);
  if (marcaPedida !== marcaDoEndereco) {
    setMarcaDoEndereco(marcaPedida);
    if (marcaPedida && marcas?.some((b) => b.id === marcaPedida)) setMarca(marcaPedida);
  }

  useEffect(() => {
    if (podeVer) disparar(carregarMarcas());
  }, [podeVer, carregarMarcas]);

  useEffect(() => {
    if (!marca) return;
    const id = ++seq.current;
    setCarga({ tipo: 'carregando' });
    const query = { brand_id: marca, ...(mes ? { month: mes } : {}) };
    disparar(
      chamar(() => api.GET('/v1/results/monthly-report', { params: { query } })).then((r) => {
        // Só a resposta mais nova vale (trocar de marca ou de mês no meio de uma leitura não mistura relatórios).
        if (id !== seq.current) return;
        setCarga(r.ok ? { tipo: 'ok', dados: r.data, marca, mes } : { tipo: 'erro', problema: r.problema });
      }),
    );
  }, [marca, mes, tentativa]);

  if (!podeVer) {
    return (
      <Estado icone="lock" titulo="Esta tela é de quem acompanha as vendas">
        O seu nível nesta empresa não mostra os resultados de vendas. Se precisar, peça ao dono da conta.
      </Estado>
    );
  }

  const ok = carga.tipo === 'ok' ? carga : null;
  const dados = ok?.dados ?? null;
  const relatorio = dados?.report ?? null;
  // O mês do selo: o do relatório; sem relatório, o mês pedido, ou o que o primeiro relatório vai fechar.
  const mesDoSelo = !ok ? null : relatorio ? relatorio.month.from : ok.mes ? `${ok.mes}-01` : mesQueFecha(ok.dados.next_report_on);

  let corpo;
  if (erroMarcas) {
    corpo = <Erro problema={erroMarcas} aoTentar={() => disparar(carregarMarcas())} />;
  } else if (marcas && !marcas.length) {
    corpo = (
      <div className="card">
        <Estado icone="info" titulo="Nenhuma marca ativa nesta empresa">
          O relatório é por marca: quando a empresa tiver uma marca ativa, o relatório dela aparece aqui.
        </Estado>
      </div>
    );
  } else if (carga.tipo === 'erro') {
    corpo = <Erro problema={carga.problema} aoTentar={() => setTentativa((t) => t + 1)} />;
  } else if (!ok) {
    corpo = <RelatorioCarregando />;
  } else if (!relatorio) {
    corpo = (
      <div className="card">
        {ok.mes ? (
          <Estado
            icone="calendar"
            titulo="Não há relatório desse mês"
            acao={
              <div className="vazio-acoes">
                <Link className="btn btn--primary" href={`/resultados/relatorio?marca=${ok.marca}`}>
                  Ver o relatório mais recente
                </Link>
              </div>
            }
          >
            O relatório sai uma vez por mês, no dia 1º, e só para os meses com as vendas conectadas.
          </Estado>
        ) : (
          <Estado
            icone="calendar"
            titulo={`O primeiro relatório sai ${naData(ok.dados.next_report_on)}`}
            acao={
              <div className="vazio-acoes">
                <Link className="btn" href="/resultados">
                  Ver os Resultados
                </Link>
                <Link className="btn btn--ghost" href={`/resultados/revisao?marca=${ok.marca}`}>
                  Ver a revisão da semana
                </Link>
              </div>
            }
          >
            Ele junta o mês que fecha na véspera: o que vendeu, cada semana, o que cada campanha trouxe no caixa, a verba do mês, o que a equipe fez e o que fica para o mês seguinte.
          </Estado>
        )}
      </div>
    );
  } else {
    corpo = <RelatorioConteudo relatorio={relatorio} podeVerContas={pode('contas.ver')} pode={pode} />;
  }

  return (
    <section aria-labelledby="h-relatorio">
      <div className="view-cab anima" style={{ ['--i' as string]: 0 }}>
        <div>
          <h1 id="h-relatorio" ref={titulo} tabIndex={-1}>
            Relatório do mês
          </h1>
          <p>{introDoRelatorio(relatorio?.email ?? null)}</p>
        </div>
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
          {mesDoSelo && <span className="lite-chip">{mesEscrito(mesDoSelo)}</span>}
        </div>
      </div>
      {corpo}
    </section>
  );
}

function Erro({ problema, aoTentar }: { problema: Problema; aoTentar: () => void }) {
  return (
    <div className="card">
      <Estado
        icone="alert-circle"
        perigo
        titulo="Não foi possível carregar o relatório"
        acao={
          <div className="vazio-acoes">
            <button className="btn btn--primary" type="button" onClick={aoTentar}>
              <Icone nome="refresh" />
              Tentar de novo
            </button>
          </div>
        }
      >
        {mensagemDe(problema)} Nada foi perdido.
      </Estado>
    </div>
  );
}

function RelatorioCarregando() {
  return (
    <div className="rev-sem" aria-busy="true">
      <p className="sr-only">Carregando o relatório…</p>
      {[0, 1, 2, 3].map((i) => (
        <div className="card res-esqueleto" aria-hidden="true" key={i}>
          <span className="esqueleto esqueleto--curto" />
          <span className="esqueleto esqueleto--medio" />
          <span className="esqueleto" />
        </div>
      ))}
    </div>
  );
}
