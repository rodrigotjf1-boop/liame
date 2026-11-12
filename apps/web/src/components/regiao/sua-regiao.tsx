'use client';

import type { RegionOverviewResponse, StoreLocation } from '@liame/contracts';
import { useSearchParams } from 'next/navigation';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Estado } from '@/components/ui/estado';
import { Faixa } from '@/components/ui/faixa';
import { Icone } from '@/components/ui/icone';
import { api, chamar, mensagemDe } from '@/lib/api';
import { disparar } from '@/lib/disparar';
import { useDetalhes } from '@/lib/modo';
import { BairrosDosPedidos } from './bairros-dos-pedidos';
import { DemandaDaLoja } from './demanda-da-loja';
import { GavetaFontes } from './gaveta-fontes';
import { MidiaNaRegiao } from './midia-na-regiao';
import { PublicoNasRedes } from './publico-nas-redes';
import { Numero } from './numero';
import {
  comparaDensidade,
  condicaoEmFrase,
  diaCurto,
  FONTE_DA_PREVISAO,
  FONTE_DO_CNPJ,
  FONTES_COM_ESTADO_PROPRIO,
  FONTES_DA_REGIAO,
  iconeDoTempo,
  quandoFoiLida,
  tipoDaData,
  fonteDaRendaDoBairro,
  fonteDoNumero,
  fontesQueFalharam,
  fraseDaRenda,
  frescor,
  grande,
  hora,
  inteiro,
  mesAno,
  movimentoDaContagem,
  pct,
  reais,
  tiposDaContagem,
  trimestre,
  umaCasa,
  variacao,
} from './textos-da-regiao';

// Sua região (protótipo P40, aprovado em 11/11/2026; plano da região, R2, parte 2): o retrato da região de uma loja,
// calculado pelo sistema com dados públicos, sem IA (`GET /v1/region/overview`). Uma loja por vez; enquanto as fontes são
// lidas (a rotina do worker olha a cada minuto), a tela lê de novo a cada 10 segundos, por até 3 minutos.

const RELER_MS = 10_000;
const ESPERA_MAXIMA_MS = 3 * 60_000;

type Carga = { tipo: 'carregando'; loja: string } | { tipo: 'ok'; loja: string; r: RegionOverviewResponse } | { tipo: 'erro'; loja: string; texto: string };

export function SuaRegiao({ brandId, lojas }: { brandId: string; lojas: StoreLocation[] }) {
  const ids = useId();
  const titulo = useRef<HTMLHeadingElement>(null);
  const noMapa = lojas.filter((l) => l.address);
  const [sel, setSel] = useState<string | null>(noMapa[0]?.unit_id ?? null);
  const [carga, setCarga] = useState<Carga | null>(null);
  const [fontes, setFontes] = useState(false);
  const [tentativa, setTentativa] = useState(0);
  const { pro, aberto, mostraPro, alternar } = useDetalhes();
  const seq = useRef(0);
  const desde = useRef(0);
  const loja = noMapa.find((l) => l.unit_id === sel) ?? noMapa[0] ?? null;
  const lojaId = loja?.unit_id ?? null;
  const assinatura = loja ? JSON.stringify([loja.address, loja.delivery_areas]) : '';

  // A leitura vale só para a loja de que veio (V64); a loja salva de novo (outro endereço) lê de novo.
  useEffect(() => {
    if (!lojaId) return;
    const id = ++seq.current;
    desde.current = Date.now();
    let espera: ReturnType<typeof setTimeout> | undefined;
    const ler = async () => {
      const r = await chamar(() => api.GET('/v1/region/overview', { params: { query: { brand_id: brandId, unit_id: lojaId } } }));
      if (id !== seq.current) return;
      if (!r.ok) return setCarga({ tipo: 'erro', loja: lojaId, texto: mensagemDe(r.problema) });
      setCarga({ tipo: 'ok', loja: lojaId, r: r.data });
      if (r.data.status === 'lendo' && Date.now() - desde.current < ESPERA_MAXIMA_MS) espera = setTimeout(() => disparar(ler()), RELER_MS);
    };
    setCarga({ tipo: 'carregando', loja: lojaId });
    disparar(ler());
    return () => clearTimeout(espera);
    // `assinatura` muda quando a loja é salva de novo, e `tentativa` no "Tentar de novo": o retrato é lido outra vez.
  }, [brandId, lojaId, assinatura, tentativa]);

  // "Ver as fontes" da resposta da LIA (D-RG-18) chega com `?fontes=1`: a gaveta abre uma vez, com o retrato pronto.
  const params = useSearchParams();
  const pediuAsFontes = params.get('fontes') === '1';
  const fontesAbertasPelaUrl = useRef(false);
  const prontoParaAsFontes = carga?.tipo === 'ok' && carga.r.status !== 'lendo' && carga.r.status !== 'sem_endereco';
  useEffect(() => {
    if (!pediuAsFontes || !prontoParaAsFontes || fontesAbertasPelaUrl.current) return;
    fontesAbertasPelaUrl.current = true;
    setFontes(true);
  }, [pediuAsFontes, prontoParaAsFontes]);

  const cab = (acoes?: ReactNode) => (
    <div className="rg-card-cab">
      <div>
        <h2 id={`${ids}-t`} tabIndex={-1} ref={titulo}>
          Sua região <span className="st st--espera">Sem IA</span>
        </h2>
        <p className="card-sub">
          Calculada pelo sistema com dados públicos{noMapa.length > 1 ? ', uma loja por vez' : loja ? ` em volta da loja ${loja.unit_name}` : ''}. Cada número diz de onde veio e de quando é.
        </p>
      </div>
      {acoes && <div className="rg-cab-acoes">{acoes}</div>}
    </div>
  );

  if (!loja) {
    return (
      <section className="card rg-card" aria-labelledby={`${ids}-t`}>
        {cab()}
        <Estado icone="map-pin" titulo="Sua região aparece quando a loja estiver no mapa" compacto>
          Com o endereço, o Liame lê o IBGE pelos códigos do bairro e do município e mostra aqui a gente, o bolso e a concorrência em volta, cada número com a fonte e o período.
        </Estado>
      </section>
    );
  }

  const r = carga?.tipo === 'ok' && carga.loja === loja.unit_id ? carga.r : null;
  const seletor =
    noMapa.length > 1 ? (
      <div className="rg-lojas-seg">
        <span className="eixo-nota" id={`${ids}-seg`}>
          Loja
        </span>
        <div className="seg" role="group" aria-labelledby={`${ids}-seg`}>
          {noMapa.map((l) => (
            <button key={l.unit_id} type="button" aria-pressed={l.unit_id === loja.unit_id} onClick={() => setSel(l.unit_id)}>
              {l.unit_name}
              {l.address?.district ? ` · ${l.address.district}` : ''}
            </button>
          ))}
        </div>
      </div>
    ) : null;

  let corpo: ReactNode;
  if (carga?.tipo === 'erro' && carga.loja === loja.unit_id) {
    corpo = (
      <Estado
        icone="alert-circle"
        titulo="Não deu para abrir Sua região"
        perigo
        compacto
        acao={
          <div className="vazio-acoes">
            <button className="btn" type="button" onClick={() => setTentativa((t) => t + 1)}>
              <Icone nome="refresh" />
              Tentar de novo
            </button>
          </div>
        }
      >
        {carga.texto} Nada foi perdido.
      </Estado>
    );
  } else if (!r) {
    corpo = (
      <p className="lite-frase" role="status">
        Abrindo Sua região…
      </p>
    );
  } else if (r.status === 'lendo') {
    const censo = r.sources.find((s) => s.source === 'ibge_censo_bairro');
    const cidadeLida = r.sources.filter((s) => s.source !== 'ibge_censo_bairro' && !FONTES_COM_ESTADO_PROPRIO.has(s.source)).every((s) => s.status === 'em_dia');
    const passo = (ok: boolean, texto: string) => (
      <li className={ok ? 'rg-ok' : undefined}>
        <Icone nome={ok ? 'check-circle' : 'clock'} />
        <span>{texto}</span>
        <span className={`st ${ok ? 'st--concluido' : 'st--info'}`}>{ok ? 'Pronto' : 'Lendo'}</span>
      </li>
    );
    corpo = (
      <div className="rg-lendo" aria-busy="true">
        <div className="rg-lendo-cab">
          <h3 tabIndex={-1}>Lendo a região da loja {loja.unit_name}…</h3>
        </div>
        <p className="lite-frase">Leva até 1 minuto: o Liame consulta o IBGE pelos códigos do bairro e do município. A tela atualiza sozinha; você pode sair daqui.</p>
        <ul className="rg-passos">
          {passo(true, `Os códigos pelo CEP: ${loja.address?.city ?? ''} (${loja.address?.ibge_city_code ?? ''})${loja.address?.district ? `, ${loja.address.district}` : ''}`)}
          {passo(censo?.status === 'em_dia', `O bairro no Censo 2022${loja.address?.district ? `: ${loja.address.district}` : ''}`)}
          {passo(cidadeLida, 'O município no IBGE: população, renda e restaurantes')}
        </ul>
      </div>
    );
  } else {
    const falhas = fontesQueFalharam(r);
    const b = r.district;
    const c = r.city;
    // Os restaurantes pelo CNPJ da Receita (R2, parte 4) e a leitura deles (horas na primeira vez; não segura o retrato).
    const fp = r.food_places;
    const cnpj = r.sources.find((s) => s.source === FONTE_DO_CNPJ);
    // A semana que vem (parte 5): a cidade no CPTEC e a previsão têm o estado próprio, como o CNPJ.
    const cidadeNoCptec = r.sources.find((s) => s.source === 'cptec_cidade');
    const previsao = r.sources.find((s) => s.source === FONTE_DA_PREVISAO);
    const falhou = (fonte: string) => falhas.some((f) => f.source === fonte);
    const proxima = falhas.map((f) => f.next_try_at).filter((x): x is string => x !== null)[0];
    const linhaDaFalha = (o: string) => (
      <p className="rg-falhou">
        <Icone nome="alert-circle" />
        <span>
          <b>{o}: o IBGE não respondeu.</b> {proxima ? `Tentamos de novo às ${hora(proxima)}.` : 'Tentamos de novo em 1 hora.'} Os outros números valem.
        </span>
      </p>
    );
    // Os valores da régua na mesma base do número de cima: corrigidos pelo IPCA quando ele foi lido.
    const tipico = b?.income_rank ? (r.ipca && b.head_income_median_today !== null ? Math.round(b.income_rank.typical_median * r.ipca.factor) : b.income_rank.typical_median) : 0;
    const doBairro = b ? (b.head_income_median_today ?? b.head_income_median ?? 0) : 0;
    const regua =
      b?.income_rank && b.head_income_median !== null ? (
        <>
          <div className="rg-regua" role="img" aria-label={`O bairro ${b.name} fica acima de ${b.income_rank.above_pct}% dos ${inteiro(b.income_rank.districts)} bairros do município; o bairro típico tem ${reais(tipico)}.`}>
            <span className="rg-regua-trilho" />
            <span className="rg-regua-marca" style={{ left: '50%' }} />
            <span className="rg-regua-ponto" style={{ left: `${Math.min(98, Math.max(2, b.income_rank.above_pct))}%` }} />
          </div>
          <p className="rg-regua-rot" aria-hidden="true">
            <span>menor renda</span>
            <span>maior renda</span>
          </p>
          <p className="rg-regua-chave" aria-hidden="true">
            <span>
              <i className="rg-ch-marca" />
              bairro típico do município: {reais(tipico)}
            </span>
            <span>
              <i className="rg-ch-ponto" />
              {b.name}: {reais(doBairro)}
            </span>
          </p>
        </>
      ) : null;
    const semBairro =
      r.district_status === 'nao_achado' ? (
        <Numero
          classe="rg-num--falta"
          valor="Bairro fora do Censo"
          obs={`O bairro “${loja.address?.district ?? ''}” do CEP não está entre os bairros do Censo do município${c?.name ? ` (${c.name})` : ''}. Sua região mostra o município.`}
          fonte="IBGE · Censo 2022, agregados por bairro"
          mostraPro={mostraPro}
        />
      ) : null;
    corpo = (
      <>
        {falhas.length > 0 && (
          <Faixa
            tipo="atencao"
            icone={<Icone nome="alert" />}
            titulo="O IBGE não respondeu"
            texto={`${falhas.map((f) => FONTES_DA_REGIAO[f.source]?.dado ?? f.source).join(', ')} ficaram de fora. Tentamos de novo ${proxima ? `às ${hora(proxima)}` : 'em 1 hora'}; os outros números valem.`}
          />
        )}
        <div className="rg-grupos">
          <section className="rg-grupo" aria-labelledby={`${ids}-gente`}>
            <div className="rg-grupo-cab">
              <h3 id={`${ids}-gente`}>Gente</h3>
              <p>no bairro da loja</p>
            </div>
            <div className="rg-nums">
              {b && b.population !== null && (
                <Numero
                  valor={inteiro(b.population)}
                  obs={`pessoas moram no bairro ${b.name}${b.area_km2 !== null ? `, em ${umaCasa(Math.round(b.area_km2 * 100) / 100)} km²` : ''}`}
                  fonte="IBGE · Censo 2022"
                  pro={`Censo 2022, agregados por bairro · v0001 e AREA_KM2 · bairro ${b.code}`}
                  mostraPro={mostraPro}
                />
              )}
              {b && b.density !== null && (
                <Numero
                  valor={
                    <>
                      {inteiro(b.density)} <small>por km²</small>
                    </>
                  }
                  obs={c?.density ? comparaDensidade(b.density, c.density.value, c.name) : 'pessoas por km² no bairro'}
                  fonte="Conta do sistema com o Censo 2022"
                  pro={c?.density ? `v0001 ÷ AREA_KM2 · ${c.name}: tabela 4714, variável 614` : 'v0001 ÷ AREA_KM2'}
                  mostraPro={mostraPro}
                />
              )}
              {r.delivery_area.matched > 0 && r.delivery_area.population !== null && (
                <Numero
                  valor={inteiro(r.delivery_area.population)}
                  obs={`pessoas em ${r.delivery_area.matched} ${r.delivery_area.matched === 1 ? 'bairro' : 'bairros'} da área de entrega${r.delivery_area.total > r.delivery_area.matched ? ` (de ${r.delivery_area.total}; os outros não estão no Censo com esse nome)` : ''}`}
                  fonte="IBGE · Censo 2022, a soma dos bairros"
                  mostraPro={mostraPro}
                />
              )}
              {c?.population_estimate && (
                <Numero
                  valor={inteiro(c.population_estimate.value)}
                  obs={`pessoas no município (${c.name}) pela estimativa mais nova do IBGE`}
                  fonte={`IBGE · Estimativas de População, ${c.population_estimate.period}`}
                  pro={`tabela 6579 · variável 9324 · série com base própria: não se compara com o Censo de 2022 (${c.population ? inteiro(c.population.value) : '—'} pessoas)`}
                  mostraPro={mostraPro}
                />
              )}
              {semBairro}
            </div>
            <p className="eixo-nota">O bairro só tem número no Censo de 2022: nenhuma pesquisa mais nova desce até o bairro.</p>
          </section>

          <section className="rg-grupo" aria-labelledby={`${ids}-bolso`}>
            <div className="rg-grupo-cab">
              <h3 id={`${ids}-bolso`}>Bolso</h3>
              <p>renda de quem mora em volta</p>
            </div>
            {falhou('ibge_censo_bairro') && linhaDaFalha('A renda do bairro')}
            <div className="rg-nums">
              {b && b.head_income_median !== null && (
                <Numero
                  classe="rg-num--largo"
                  valor={reais(b.head_income_median_today ?? b.head_income_median)}
                  obs={fraseDaRenda(r)}
                  extra={regua}
                  fonte={fonteDaRendaDoBairro(r)}
                  pro={`renda do responsável por bairro · V06006 (mediana): ${reais(b.head_income_median)} em 2022${b.head_income_mean !== null ? ` · média: ${reais(b.head_income_mean)} (V06004)` : ''}${r.ipca ? ` · IPCA de ${mesAno(r.ipca.from)} a ${mesAno(r.ipca.to)}: ×${r.ipca.factor.toLocaleString('pt-BR', { maximumFractionDigits: 4 })}` : ''}`}
                  mostraPro={mostraPro}
                />
              )}
              {c?.income_pc_rm && (
                <Numero
                  valor={reais(c.income_pc_rm.value)}
                  obs="é a renda por pessoa na região metropolitana, a mais nova"
                  fonte={`IBGE · PNAD Contínua, ${c.income_pc_rm.period}`}
                  pro={`tabela 7395 · variável 4196 · RM ${c.rm_code}`}
                  mostraPro={mostraPro}
                />
              )}
              {c?.income_pc_uf && (
                <Numero
                  valor={reais(c.income_pc_uf.value)}
                  obs={`é a renda por pessoa no estado (${c.state}), a mais nova`}
                  fonte={`IBGE · PNAD Contínua, ${c.income_pc_uf.period}`}
                  pro={`tabela 7531 · variável 10824 · UF ${c.code.slice(0, 2)}`}
                  mostraPro={mostraPro}
                />
              )}
              {c?.work_income_capital && (
                <Numero
                  valor={reais(c.work_income_capital.value)}
                  obs={`é a renda do trabalho de quem trabalha na capital, na média de ${c.work_income_capital.quarters} ${c.work_income_capital.quarters === 1 ? 'trimestre' : 'trimestres'} até o ${trimestre(c.work_income_capital.period)}`}
                  fonte={`IBGE · PNAD Contínua trimestral, ${trimestre(c.work_income_capital.period)}`}
                  pro="tabela 6472 · variável 5933 (real, habitual, todos os trabalhos) · a média tira a oscilação da amostra da capital"
                  mostraPro={mostraPro}
                />
              )}
              {mostraPro && c?.income_pc_median && (
                <Numero
                  valor={reais(c.income_pc_median.value)}
                  obs={`é a renda por pessoa (mediana) no município (${c.name})${c.income_pc_mean ? `; a média é ${reais(c.income_pc_mean.value)}` : ''}`}
                  fonte={`${fonteDoNumero(c.income_pc_median)} · valor de ${c.income_pc_median.period}`}
                  pro={`tabela 10295 · variáveis 13534 (mediana) e 13431 (média) · município ${c.code}`}
                  mostraPro={mostraPro}
                />
              )}
              {!b && semBairro === null && <p className="lite-frase">A renda do bairro aparece quando o bairro da loja estiver no Censo.</p>}
            </div>
            <p className="rg-nota">
              <Icone nome="lock" pequeno />
              <span>
                A renda escolhe a oferta e a verba; <b>nunca vai para o texto do anúncio</b>.
              </span>
            </p>
          </section>

          <section className="rg-grupo" aria-labelledby={`${ids}-conc`}>
            <div className="rg-grupo-cab">
              <h3 id={`${ids}-conc`}>Concorrência</h3>
              <p>{fp ? 'restaurantes, lanchonetes e bares com CNPJ ativo' : 'no município'}</p>
            </div>
            {!fp && cnpj?.status === 'falhou' && (
              <p className="rg-falhou">
                <Icone nome="alert-circle" />
                <span>
                  <b>Os restaurantes por bairro e por CEP: a Receita não respondeu.</b> {cnpj.next_try_at ? `Tentamos de novo às ${hora(cnpj.next_try_at)}.` : 'Tentamos de novo em 1 hora.'} Os números do IBGE valem.
                </span>
              </p>
            )}
            {!fp && cnpj?.status === 'lendo' && (
              <p className="lite-frase">
                Os restaurantes por bairro e por CEP vêm do cadastro de CNPJ da Receita Federal, lido uma vez por mês para o Brasil inteiro. A primeira leitura leva algumas horas; enquanto isso, a conta é a do município (IBGE).
              </p>
            )}
            {fp && (
              <div className="rg-nums">
                {fp.district && b && (
                  <Numero
                    classe="rg-num--largo"
                    valor={inteiro(fp.district.active)}
                    obs={`lugares de comida com CNPJ ativo no bairro ${b.name}${fp.district.per_km2 !== null ? `, ${umaCasa(fp.district.per_km2)} por km²` : ''}: ${tiposDaContagem(fp.district)}. ${movimentoDaContagem(fp.district, fp.since)}.`}
                    fonte={`Receita Federal · CNPJ aberto, ${mesAno(fp.period)}`}
                    pro={`CNAE principal 5611-2/01, /03, /04, /05 e 5620-1/04 · situação 02 · pelo nome do bairro que a empresa informou · bairro ${b.code}`}
                    mostraPro={mostraPro}
                  />
                )}
                {fp.postal && (
                  <Numero
                    valor={inteiro(fp.postal.active)}
                    obs={`lugares de comida na área do CEP ${fp.postal.prefix}-xxx (os 5 primeiros números do CEP da loja): ${tiposDaContagem(fp.postal)}`}
                    fonte={`Receita Federal · CNPJ aberto, ${mesAno(fp.period)}`}
                    pro={`CEP ${fp.postal.prefix} · ${movimentoDaContagem(fp.postal, fp.since)}`}
                    mostraPro={mostraPro}
                  />
                )}
                {fp.delivery_area && (
                  <Numero
                    valor={inteiro(fp.delivery_area.active)}
                    obs={`lugares de comida em ${fp.delivery_area.matched} ${fp.delivery_area.matched === 1 ? 'bairro' : 'bairros'} da área de entrega: ${tiposDaContagem(fp.delivery_area)}`}
                    fonte={`Receita Federal · CNPJ aberto, ${mesAno(fp.period)} · a soma dos bairros`}
                    pro={movimentoDaContagem(fp.delivery_area, fp.since)}
                    mostraPro={mostraPro}
                  />
                )}
                <Numero
                  valor={inteiro(fp.city.active)}
                  obs={`lugares de comida no município${c?.name ? ` (${c.name})` : ''}${fp.city.per_10k !== null ? `, ${umaCasa(fp.city.per_10k)} para cada 10 mil pessoas` : ''}: ${tiposDaContagem(fp.city)}. ${movimentoDaContagem(fp.city, fp.since)}.`}
                  fonte={`Receita Federal · CNPJ aberto, ${mesAno(fp.period)}`}
                  pro={c?.population_estimate ? `por 10 mil: ativos ÷ ${inteiro(c.population_estimate.value)} pessoas (IBGE, estimativa de ${c.population_estimate.period})` : undefined}
                  mostraPro={mostraPro}
                />
              </div>
            )}
            {falhou('ibge_9528') ? (
              linhaDaFalha('Os restaurantes do município')
            ) : (
              <div className="rg-nums">
                {c?.restaurants && (
                  <Numero
                    valor={inteiro(c.restaurants.value)}
                    obs={`restaurantes e similares no município (${c.name})${fp ? ', pelo IBGE: as empresas com atividade no ano' : ''}`}
                    fonte={fonteDoNumero(c.restaurants)}
                    pro={`tabela 9528 · variável 706 · CNAE 56.11-2 (categoria 117551) · município ${c.code}`}
                    mostraPro={mostraPro}
                  />
                )}
                {c?.restaurants_per_10k !== null && c?.restaurants_per_10k !== undefined && (
                  <Numero
                    valor={
                      <>
                        {umaCasa(c.restaurants_per_10k)} <small>por 10 mil habitantes</small>
                      </>
                    }
                    obs="restaurantes para cada 10 mil pessoas do município"
                    fonte={`Conta do sistema: restaurantes ÷ ${c.population_estimate ? `${inteiro(c.population_estimate.value)} pessoas (IBGE, estimativa de ${c.population_estimate.period})` : c.population ? `${inteiro(c.population.value)} pessoas (IBGE, Censo 2022)` : 'a população'}`}
                    pro={c.population ? `tabela 6579 · variável 9324 · Censo 2022: ${inteiro(c.population.value)} pessoas (tabela 4714, variável 93)` : undefined}
                    mostraPro={mostraPro}
                  />
                )}
              </div>
            )}
            {fp && (
              <p className="eixo-nota">
                A Receita conta todo CNPJ ativo, inclusive MEI e quem parou sem dar baixa; o IBGE conta as empresas com atividade no ano. Por isso os números são diferentes.
                {fp.city.district_coverage_pct !== null && fp.city.district_coverage_pct < 100
                  ? ` ${fp.city.district_coverage_pct}% dos ativos do município informaram um bairro que o Censo conhece; os outros entram só no município e no CEP.`
                  : ''}
              </p>
            )}
          </section>

          <DemandaDaLoja r={r} lojaNome={loja.unit_name} ids={ids} mostraPro={mostraPro} />
          <BairrosDosPedidos r={r} ids={ids} mostraPro={mostraPro} />
          <MidiaNaRegiao r={r} ids={ids} mostraPro={mostraPro} />
          <PublicoNasRedes r={r} ids={ids} mostraPro={mostraPro} />

          {c?.pix && (
            <section className="rg-grupo" aria-labelledby={`${ids}-pulso`}>
              <div className="rg-grupo-cab">
                <h3 id={`${ids}-pulso`}>Pulso do consumo</h3>
                <p>no município, todo mês</p>
              </div>
              {falhou('bcb_pix') && linhaDaFalha('O Pix do município')}
              <div className="rg-nums">
                <Numero
                  valor={grande(c.pix.payers)}
                  obs={`de pessoas pagaram com Pix no município em ${mesAno(c.pix.period)}${variacao(c.pix.payers, c.pix.payers_prev_year) ? ` (${variacao(c.pix.payers, c.pix.payers_prev_year)} sobre ${mesAno(`${Number(c.pix.period.slice(0, 4)) - 1}${c.pix.period.slice(4)}`)})` : ''}`}
                  fonte={`Banco Central · Pix, ${mesAno(c.pix.period)}`}
                  pro="TransacoesPixPorMunicipio · QT_PES_PagadorPF (pessoas físicas distintas que pagaram)"
                  mostraPro={mostraPro}
                />
                <Numero
                  valor={`R$ ${grande(c.pix.value)}`}
                  obs={`pagos com Pix por pessoas físicas em ${mesAno(c.pix.period)}${variacao(c.pix.value, c.pix.value_prev_year) ? ` (${variacao(c.pix.value, c.pix.value_prev_year)} sobre o mesmo mês do ano anterior, sem descontar a inflação)` : ''}`}
                  fonte={`Banco Central · Pix, ${mesAno(c.pix.period)}`}
                  pro="TransacoesPixPorMunicipio · VL_PagadorPF"
                  mostraPro={mostraPro}
                />
              </div>
            </section>
          )}

          {c?.food_away_inflation && (
            <section className="rg-grupo" aria-labelledby={`${ids}-preco`}>
              <div className="rg-grupo-cab">
                <h3 id={`${ids}-preco`}>Preço de comer fora</h3>
                <p>inflação de 12 meses até {mesAno(c.food_away_inflation.period)}</p>
              </div>
              <ul className="rg-ainda">
                {(
                  [
                    ['Alimentação fora de casa', c.food_away_inflation.away, c.food_away_inflation.brasil?.away],
                    ['Refeição', c.food_away_inflation.meal, c.food_away_inflation.brasil?.meal],
                    ['Lanche', c.food_away_inflation.snack, c.food_away_inflation.brasil?.snack],
                  ] as Array<[string, number | null, number | null | undefined]>
                )
                  .filter(([, v]) => v !== null)
                  .map(([rotulo, v, br]) => (
                    <li key={rotulo}>
                      <span className="st st--info">{pct(v!)}</span>
                      <span>
                        <b>{rotulo}</b>
                        <small>
                          {c.food_away_inflation!.scope === 'brasil' ? 'no Brasil' : c.food_away_inflation!.scope === 'rm' ? 'na região metropolitana' : 'no município'}
                          {br !== null && br !== undefined ? ` · Brasil: ${pct(br)}` : ''}
                        </small>
                      </span>
                    </li>
                  ))}
              </ul>
              <p className="rg-num-f">
                IBGE · IPCA, 12 meses até {mesAno(c.food_away_inflation.period)}
                {c.food_away_inflation.scope === 'brasil' ? ' · o IPCA não tem a região desta loja' : ''}
              </p>
            </section>
          )}

          {r.week_ahead && (
            <section className="rg-grupo" aria-labelledby={`${ids}-semana`}>
              <div className="rg-grupo-cab">
                <h3 id={`${ids}-semana`}>A semana que vem</h3>
                <p>tempo, feriados e datas</p>
              </div>
              <div className="rg-duas">
                <div>
                  <h4>Previsão do tempo{c?.name ? ` · ${c.name}` : ''}</h4>
                  {r.week_ahead.weather ? (
                    <>
                      <ul className="rg-tempo" aria-label="Previsão por dia">
                        {r.week_ahead.weather.days.map((d) => (
                          <li className="rg-dia" key={d.day}>
                            <b>{diaCurto(d.day)}</b>
                            <Icone nome={iconeDoTempo(d.condition)} />
                            <span>{condicaoEmFrase(d.description)}</span>
                            <span>
                              <span className="num">{d.min}°</span> a <span className="num">{d.max}°</span>
                            </span>
                          </li>
                        ))}
                      </ul>
                      <p className="rg-num-f">CPTEC/INPE, pela BrasilAPI · previsão por dia, lida {quandoFoiLida(r.week_ahead.weather.read_at)}</p>
                    </>
                  ) : previsao?.status === 'falhou' ? (
                    <p className="rg-falhou">
                      <Icone nome="alert-circle" />
                      <span>
                        <b>O CPTEC não respondeu.</b> {previsao.next_try_at ? `Tentamos de novo às ${hora(previsao.next_try_at)}.` : 'Tentamos de novo em 1 hora.'}
                      </span>
                    </p>
                  ) : cidadeNoCptec?.status === 'em_dia' && !previsao ? (
                    <p className="lite-frase">O CPTEC não tem previsão para este município.</p>
                  ) : (
                    <p className="lite-frase">Lendo a previsão do CPTEC para o município; aparece em até 1 minuto.</p>
                  )}
                </div>
                <div>
                  <h4>Feriados e datas</h4>
                  {r.week_ahead.dates.length ? (
                    <ul className="rg-datas">
                      {r.week_ahead.dates.map((d) => (
                        <li className="rg-data" key={`${d.day}-${d.name}`}>
                          <span className="num">{diaCurto(d.day)}</span>
                          <span>
                            {d.name}
                            <small>{tipoDaData(d.kind)}</small>
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="lite-frase">Nenhum feriado nacional nem data do varejo nos próximos 45 dias.</p>
                  )}
                  <p className="rg-num-f">Feriados nacionais (pela lei) e datas do varejo: calendário do Liame · o prazo do salário é conta do sistema</p>
                  {mostraPro && <p className="rg-num-c">os feriados do estado e da cidade ainda não têm fonte pública gratuita (base §19.4) · o 5º dia útil conta o sábado e não conta o domingo nem o feriado nacional</p>}
                </div>
              </div>
              <p className="rg-nota">
                <Icone nome="info" pequeno />
                <span>Chuva e frio costumam aumentar o pedido em casa (referência do setor); a prova vem do caixa da própria loja.</span>
              </p>
            </section>
          )}

          {r.sector_references.length > 0 && (
            <section className="rg-grupo" aria-labelledby={`${ids}-ref`}>
              <div className="rg-grupo-cab">
                <h3 id={`${ids}-ref`}>Referência do setor</h3>
                <p>da imprensa; não é o número da sua loja</p>
              </div>
              <ul className="rg-ref">
                {r.sector_references.map((ref) => (
                  <li key={ref.text}>
                    <span>
                      <span className="st st--espera">Referência do setor (imprensa)</span>
                    </span>
                    <span>{ref.text}</span>
                    <small>{ref.source}</small>
                    {ref.extra && mostraPro && <small>{ref.extra}</small>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="rg-grupo" aria-labelledby={`${ids}-ainda`}>
            <div className="rg-grupo-cab">
              <h3 id={`${ids}-ainda`}>Ainda não</h3>
              <p>o que depende de outra entrega</p>
            </div>
            <ul className="rg-ainda">
              {[
                ['Pessoas no raio, na Meta', 'Aparece com a conta de anúncios: a Meta estima quantas pessoas há no raio, por faixa de idade, antes de gastar (R6).'],
                ['Concorrentes no raio', 'Aparece com o servidor de mapas próprio (R8). Hoje, a conta é a do município.'],
              ].map(([t, s]) => (
                <li key={t}>
                  <span className="st st--espera">Ainda não</span>
                  <span>
                    <b>{t}</b>
                    <small>{s}</small>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>
        {!pro && (
          <div className="rg-loja-acoes">
            <button className="detalhes-bt" type="button" onClick={alternar} aria-expanded={aberto}>
              <span>{aberto ? 'Menos detalhes' : 'Ver detalhes'}</span>
              <Icone nome="chevron-down" pequeno />
            </button>
          </div>
        )}
      </>
    );
  }

  const acoes = r ? (
    <>
      <span className="rg-frescor">{frescor(r)}</span>
      {r.status !== 'lendo' && (
        <button className="btn btn--sm" type="button" onClick={() => setFontes(true)} aria-haspopup="dialog">
          <Icone nome="file" pequeno />
          Ver as fontes
        </button>
      )}
    </>
  ) : undefined;

  return (
    <section className="card rg-card" aria-labelledby={`${ids}-t`}>
      {cab(acoes)}
      {seletor}
      {corpo}
      {fontes && r && <GavetaFontes loja={loja} r={r} reserva={titulo} aoFechar={() => setFontes(false)} />}
    </section>
  );
}
