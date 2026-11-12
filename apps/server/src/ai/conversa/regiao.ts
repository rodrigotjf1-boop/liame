import type { RegionOverviewResponse } from '@liame/contracts';
import { montador, type RespostaPorRegra } from './por-regra.js';

// "Como é a minha região?" (plano da região, D-RG-18; protótipo P40, cenário 17): a LIA responde por regra, sem IA, com
// os números de Sua região, a fonte e o período de cada um, e diz o que ainda não dá para saber. A leitura que a
// conversa guarda (`valor`) traz cada número escrito do mesmo jeito que o texto o escreve: a conferência da LIA exige
// que todo número da resposta esteja na leitura. Nada do endereço da loja entra (D-RG-2): o bairro, o município e os
// números calculados.

/** O que a conversa leu de Sua região para responder: a loja do retrato (a primeira no mapa) e o retrato dela. */
export interface EntradaDaRegiao {
  /** Quantas lojas da marca estão no mapa. */
  lojasNoMapa: number;
  /** A marca recebe os pedidos do Regem. */
  temRegem: boolean;
  /** A loja do retrato (nula sem loja no mapa) e o retrato dela. */
  loja: { nome: string; bairro: string | null; municipio: string } | null;
  retrato: RegionOverviewResponse | null;
}

export interface RespostaDaRegiao extends RespostaPorRegra {
  /** A leitura como a conversa a guarda (a origem de cada número na tela). */
  valor: Record<string, unknown>;
  /** `regiao` (com o retrato) ou `sem_loja` (nenhuma loja no mapa): decide o rótulo da leitura e os botões. */
  tipo: 'regiao' | 'sem_loja';
}

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const NO_DIA = ['no domingo', 'na segunda', 'na terça', 'na quarta', 'na quinta', 'na sexta', 'no sábado'];
/** Os códigos do CPTEC em que há chuva prevista (chuva, pancadas, chuvisco, tempestade, possibilidade de chuva). */
const COM_CHUVA = new Set(['ec', 'ci', 'c', 'in', 'pp', 'cm', 'cn', 'pt', 'pm', 'np', 'pc', 'cv', 'ch', 't', 'pnt', 'psc', 'pcm', 'pct', 'pcn', 'npt', 'npn', 'ncn', 'nct', 'ncm', 'npm', 'npp', 'ct', 'ppn', 'ppt', 'ppm']);

const inteiro = (n: number): string => Math.round(n).toLocaleString('pt-BR');
const umaCasa = (n: number): string => n.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
const duasCasas = (n: number): string => n.toLocaleString('pt-BR', { maximumFractionDigits: 2 });
const reais = (n: number): string => `R$ ${inteiro(n)}`;
const pct = (n: number): string => `${Math.abs(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
const mesAno = (periodo: string): string => {
  const m = Number(periodo.slice(5, 7));
  return m >= 1 && m <= 12 ? `${MESES[m - 1]}/${periodo.slice(0, 4)}` : periodo;
};
const diaMes = (dia: string): string => `${dia.slice(8, 10)}/${dia.slice(5, 7)}`;
const noDia = (dia: string): string => `${NO_DIA[new Date(`${dia}T12:00:00Z`).getUTCDay()]}, ${diaMes(dia)}`;
const juntar = (itens: string[]): string => (itens.length <= 1 ? (itens[0] ?? '') : `${itens.slice(0, -1).join(', ')} e ${itens.at(-1)}`);

/** A resposta de "como é a minha região?", com a leitura que a sustenta. Nula quando não há o que responder por regra. */
export function respostaDaRegiao(e: EntradaDaRegiao): RespostaDaRegiao {
  const m = montador();
  const valor: Record<string, unknown> = {};

  if (!e.loja || !e.retrato || e.retrato.status === 'sem_endereco') {
    valor.lojas_no_mapa = '0';
    m.p(
      'Sua região aparece quando a loja estiver no mapa: em Minha marca › Região, informe o endereço da loja pelo CEP ou pelo Perfil do Google. Com ele, o Liame lê o IBGE e mostra a gente, o bolso, a concorrência e a semana que vem em volta da loja.',
    );
    return { ...m.pronto(), valor, tipo: 'sem_loja' };
  }

  const r = e.retrato;
  const loja = e.loja;
  valor.loja = loja.nome;
  valor.municipio = loja.municipio;
  if (loja.bairro) valor.bairro = loja.bairro;
  if (e.lojasNoMapa > 1) {
    valor.lojas_no_mapa = String(e.lojasNoMapa);
    m.p(`A marca tem ${e.lojasNoMapa} lojas no mapa; esta resposta é da loja ${loja.nome}. As outras estão em Sua região.`);
  }

  if (r.status === 'lendo') {
    m.p(`Sua região da loja ${loja.nome} ainda está sendo lida: o Liame consulta o IBGE pelos códigos do bairro e do município, e isso leva até 1 minuto. Pergunte de novo daqui a pouco.`);
    valor.leitura = 'leva até 1 minuto';
    return { ...m.pronto(), valor, tipo: 'regiao' };
  }

  // Gente: o bairro do Censo (pessoas, área e densidade) ou, sem ele, a estimativa do município.
  const b = r.district;
  const c = r.city;
  if (b && b.population !== null) {
    const gente: Record<string, string> = { pessoas: inteiro(b.population), fonte: 'IBGE, Censo 2022' };
    let frase = `Gente: a loja ${loja.nome} fica no bairro ${b.name}, ${loja.municipio}: ${gente.pessoas} pessoas`;
    if (b.area_km2 !== null) {
      gente.area_km2 = duasCasas(b.area_km2);
      frase += ` em ${gente.area_km2} km²`;
    }
    if (b.density !== null) {
      gente.por_km2 = inteiro(b.density);
      frase += `, ${gente.por_km2} por km²`;
    }
    valor.gente = gente;
    m.p(`${frase} (${gente.fonte}).`);
  } else if (c?.population_estimate) {
    const gente = { pessoas_no_municipio: inteiro(c.population_estimate.value), fonte: `IBGE, estimativa de ${c.population_estimate.period}` };
    valor.gente = gente;
    m.p(`Gente: a loja ${loja.nome} fica em ${loja.municipio}, com ${gente.pessoas_no_municipio} pessoas (${gente.fonte}); o bairro da loja não está entre os bairros do Censo.`);
  }

  // Bolso: a renda do responsável pelo domicílio no bairro, corrigida pelo IPCA quando ele foi lido.
  if (b && b.head_income_median !== null) {
    const hoje = b.head_income_median_today;
    const bolso: Record<string, string> = {};
    let frase: string;
    if (hoje !== null && r.ipca) {
      bolso.renda_mediana = reais(hoje);
      bolso.a_precos_de = mesAno(r.ipca.to);
      bolso.fonte = 'IBGE, Censo 2022, corrigida pelo IPCA';
      frase = `Bolso: a renda mediana do responsável pelo domicílio no bairro é ${bolso.renda_mediana}, a preços de ${bolso.a_precos_de}`;
    } else {
      bolso.renda_mediana = reais(b.head_income_median);
      bolso.fonte = 'IBGE, Censo 2022, valor de 2022';
      frase = `Bolso: a renda mediana do responsável pelo domicílio no bairro é ${bolso.renda_mediana}`;
    }
    if (b.income_rank) {
      bolso.acima_de = `${b.income_rank.above_pct}%`;
      bolso.bairros = inteiro(b.income_rank.districts);
      frase += `, acima de ${bolso.acima_de} dos ${bolso.bairros} bairros do município`;
    }
    valor.bolso = bolso;
    m.p(`${frase} (${bolso.fonte}).`);
  }

  // Concorrência: os ativos pelo CNPJ da Receita; sem eles, os restaurantes do município pelo IBGE.
  const fp = r.food_places;
  if (fp) {
    const conc: Record<string, string> = { no_municipio: inteiro(fp.city.active), fonte: `Receita Federal, CNPJ aberto, ${mesAno(fp.period)}` };
    let frase = 'Concorrência: ';
    if (fp.district) {
      conc.no_bairro = inteiro(fp.district.active);
      frase += `${conc.no_bairro} lugares de comida com CNPJ ativo no bairro e ${conc.no_municipio} no município`;
    } else {
      frase += `${conc.no_municipio} lugares de comida com CNPJ ativo no município`;
    }
    if (fp.city.per_10k !== null) {
      conc.por_10_mil = `${umaCasa(fp.city.per_10k)} para cada 10 mil pessoas`;
      frase += `, ${conc.por_10_mil}`;
    }
    valor.concorrencia = conc;
    m.p(`${frase} (${conc.fonte}).`);
  } else if (c?.restaurants) {
    const conc: Record<string, string> = { no_municipio: inteiro(c.restaurants.value), fonte: `IBGE, Cadastro Central de Empresas, ${c.restaurants.period}` };
    let frase = `Concorrência: o município tem ${conc.no_municipio} restaurantes e similares`;
    if (c.restaurants_per_10k !== null) {
      conc.por_10_mil = `${umaCasa(c.restaurants_per_10k)} para cada 10 mil habitantes`;
      frase += `, ${conc.por_10_mil}`;
    }
    valor.concorrencia = conc;
    m.p(`${frase} (${conc.fonte}).`);
  }

  // Preço de comer fora: o IPCA de 12 meses do lanche e da refeição, no lugar e no Brasil.
  const ipca = c?.food_away_inflation;
  if (ipca && (ipca.snack !== null || ipca.meal !== null)) {
    const onde = ipca.scope === 'rm' ? 'na região metropolitana' : ipca.scope === 'municipio' ? 'no município' : 'no Brasil';
    const preco: Record<string, string> = { periodo: `12 meses até ${mesAno(ipca.period)}`, fonte: 'IBGE, IPCA' };
    const partes: string[] = [];
    let primeiro: number | null = null;
    const parte = (rotulo: string, chave: string, v: number | null, br: number | null | undefined) => {
      if (v === null) return;
      preco[chave] = pct(v);
      // O segundo, no mesmo sentido do primeiro, fica curto: "e a refeição, 2,66% (Brasil: 5,01%)".
      const curto = primeiro !== null && primeiro >= 0 === v >= 0;
      primeiro ??= v;
      let t = curto ? `${rotulo}, ${preco[chave]}` : `${rotulo} ${v >= 0 ? 'subiu' : 'caiu'} ${preco[chave]} ${onde}`;
      if (br !== null && br !== undefined) {
        preco[`${chave}_brasil`] = pct(br);
        t += ` (Brasil: ${br < 0 ? 'caiu ' : ''}${preco[`${chave}_brasil`]})`;
      }
      partes.push(t);
    };
    parte('o lanche', 'lanche', ipca.snack, ipca.brasil?.snack);
    parte('a refeição', 'refeicao', ipca.meal, ipca.brasil?.meal);
    valor.preco_de_comer_fora = preco;
    m.p(`Preço de comer fora, em ${preco.periodo}: ${juntar(partes)} (${preco.fonte}).`);
  }

  // A semana que vem: o primeiro dia com chuva prevista e as próximas três datas.
  const semana = r.week_ahead;
  if (semana && (semana.weather?.days.length || semana.dates.length)) {
    const s: Record<string, unknown> = {};
    const partes: string[] = [];
    const dias = semana.weather?.days ?? [];
    if (dias.length) {
      const chuva = dias.find((d) => COM_CHUVA.has(d.condition));
      const ultimo = dias.at(-1)!;
      s.chuva = chuva ? noDia(chuva.day) : null;
      s.ate = noDia(ultimo.day);
      partes.push(chuva ? `chuva prevista ${noDia(chuva.day)} (CPTEC)` : `sem chuva prevista até ${noDia(ultimo.day)} (CPTEC)`);
    }
    const datas = semana.dates.slice(0, 3).map((d) => ({ nome: d.name, quando: noDia(d.day) }));
    s.datas = datas;
    for (const d of datas) partes.push(`${d.nome} ${d.quando}`);
    valor.semana_que_vem = s;
    // Ponto e vírgula entre os itens: cada um já tem a vírgula do dia ("na sexta, 13/11").
    m.p(`Semana que vem: ${partes.join('; ')}.`);
  }

  if (r.status === 'parcial') m.p('Uma das fontes públicas não respondeu na última leitura; o número que faltou aparece em Sua região quando ela responder.');

  const pedidos = e.temRegem ? 'pedidos por hora e tíquete médio da loja (com os pedidos do Regem)' : 'pedidos por hora e tíquete médio da loja (só com o Regem)';
  m.p(`Ainda não dá para saber: ${pedidos}, pessoas no raio (com a conta de anúncios) e concorrentes no raio.`);
  return { ...m.pronto(), valor, tipo: 'regiao' };
}
