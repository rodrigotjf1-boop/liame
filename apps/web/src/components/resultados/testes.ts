import type { CreativeTestResponse, RegionTestResponse } from '@liame/contracts';
import { resultadoDoTesteDeRegiao } from '@/components/aprovacoes/teste-de-regiao-textos';
import { reaisDeMicros } from '@/lib/formato';

/** Reais com os centavos ("R$ 40,00"), sem ponto flutuante. */
const moeda = (micros: number): string => reaisDeMicros(BigInt(Math.round(micros)));

// "Testes" em Resultados (R8; D-RG-97, protótipo `prototipo-campanha-nova.html`, "Telas do teste"): os testes da marca, de
// criativo e de região, do mais novo ao mais antigo, com a situação, o veredito em uma frase e os números que decidiram.
// Só leitura: nada é comparado entre empresas. Regras puras.

export type TomDoTeste = 'espera' | 'trabalhando' | 'concluido' | 'perigo' | 'neutro';

export type TesteNaLista = {
  id: string;
  nome: string;
  tipo: 'Teste de criativo' | 'Teste de região';
  situacao: { rotulo: string; tom: TomDoTeste };
  quando: string;
  veredito: string;
  numeros: string[];
  /** O pedido em Aprovações (onde o teste é acompanhado); nulo se foi apagado. */
  pedido: string | null;
  criadoEm: string;
};

const dia = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/** Os dias entre duas datas (`AAAA-MM-DD`), contando os dois. */
const diasEntre = (de: string, ate: string) => Math.round((Date.parse(`${ate}T12:00:00Z`) - Date.parse(`${de}T12:00:00Z`)) / 86_400_000) + 1;

/** "menos de 0,1%" ou "2,4%": a chance de a diferença ser acaso. */
export function chanceEscrita(chance: number): string {
  if (chance < 0.001) return 'menos de 0,1%';
  return `${(chance * 100).toFixed(1).replace('.', ',')}%`;
}

function situacaoDoTeste(status: CreativeTestResponse['status'], vencedor: 'A' | 'B' | null, veredito: string | null): TesteNaLista['situacao'] {
  switch (status) {
    case 'pedido':
      return { rotulo: 'Espera a aprovação', tom: 'espera' };
    case 'criando':
      return { rotulo: 'Sendo criado', tom: 'trabalhando' };
    case 'pronto':
      return { rotulo: 'Pronto, pausado', tom: 'espera' };
    case 'rodando':
      return { rotulo: 'Rodando', tom: 'trabalhando' };
    case 'terminado':
      return vencedor ? { rotulo: `O criativo ${vencedor} venceu`, tom: 'concluido' } : { rotulo: veredito === 'sem_vencedor' ? 'Acabou sem vencedor' : 'Terminado', tom: 'concluido' };
    case 'encerrado':
      return { rotulo: 'Encerrado antes do fim', tom: 'neutro' };
    case 'interrompido':
      return { rotulo: 'Interrompido', tom: 'perigo' };
    case 'cancelado':
      return { rotulo: 'Não foi criado', tom: 'neutro' };
  }
}

/** "desde 06/10 · dia 9 de 28", "14/09 a 27/09 · 14 dias" ou "pedido em 03/10". */
function quandoDoTeste(t: { started_on: string | null; ended_on: string | null; created_at: string; status: string }, maximo: number, hoje: string): string {
  if (t.started_on && t.ended_on) return `${dia(t.started_on)} a ${dia(t.ended_on)} · ${diasEntre(t.started_on, t.ended_on)} dias`;
  if (t.started_on && t.status === 'rodando') return `desde ${dia(t.started_on)} · dia ${Math.min(Math.max(diasEntre(t.started_on, hoje), 1), maximo)} de ${maximo}`;
  if (t.started_on) return `desde ${dia(t.started_on)}`;
  return `pedido em ${dia(t.created_at.slice(0, 10))}`;
}

/** Um teste de criativo na lista: o veredito da última olhada e o gasto, a receita e o custo por pedido. */
export function linhaDoTesteDeCriativo(t: CreativeTestResponse, hoje: string): TesteNaLista {
  const r = t.result;
  const numeros: string[] = [];
  let veredito: string;
  if (r) {
    const [a, b] = [r.arms.find((x) => x.letter === 'A')!, r.arms.find((x) => x.letter === 'B')!];
    const ultima = r.looks.at(-1);
    if (r.verdict === 'venceu' && r.winner) {
      const [v, p] = r.winner === 'A' ? [a, b] : [b, a];
      veredito = `O criativo ${r.winner} venceu: ${v.orders} pedidos no caixa contra ${p.orders}, com a mesma verba${ultima ? ` (${chanceEscrita(ultima.chance)} de chance de ser acaso)` : ''}.`;
    } else if (r.verdict === 'sem_vencedor') {
      veredito = `Em ${ultima?.day ?? t.max_days} dias, ${a.orders} pedidos do criativo A contra ${b.orders} do B: pelo caixa, os dois vendem parecido.`;
    } else {
      const proxima = ultima ? ultima.day + 7 : 7;
      veredito = `Ainda não dá para dizer: ${a.orders} pedidos do criativo A contra ${b.orders} do B${ultima ? ` na olhada do dia ${ultima.day}` : ''}.${t.status === 'rodando' && proxima <= t.max_days ? ` A próxima olhada é a do dia ${proxima}.` : ''}`;
    }
    const gasto = (a.spend_micros ?? 0) + (b.spend_micros ?? 0);
    const receita = a.revenue_micros + b.revenue_micros;
    const pedidos = a.orders + b.orders;
    if (a.spend_micros !== null || b.spend_micros !== null) numeros.push(`Gasto ${moeda(gasto)}`);
    if (receita > 0) numeros.push(`Receita ${moeda(receita)}`);
    if (gasto > 0 && pedidos > 0) numeros.push(`Custo por pedido ${moeda(Math.round(gasto / pedidos))}`);
  } else if (t.status === 'interrompido' || t.status === 'cancelado') {
    veredito = t.reason ?? t.error ?? (t.status === 'cancelado' ? 'O pedido foi recusado ou expirou em Aprovações.' : 'O teste foi interrompido: o Liame não conclui.');
  } else if (t.status === 'rodando') {
    veredito = 'A primeira olhada é a do dia 7: até lá, o Liame não espia.';
  } else {
    veredito = 'O teste ainda não começou.';
  }
  numeros.push(`Verba ${moeda(t.daily_budget_micros)}/dia`);
  return {
    id: t.id,
    nome: t.name,
    tipo: 'Teste de criativo',
    situacao: situacaoDoTeste(t.status, r?.winner ?? null, r?.verdict ?? null),
    quando: quandoDoTeste(t, t.max_days, hoje),
    veredito,
    numeros,
    pedido: t.action_id,
    criadoEm: t.created_at,
  };
}

/** Um teste de região na lista: o bairro, os pedidos de antes e, depois da medida, o resultado em faixa (D-RG-102). */
export function linhaDoTesteDeRegiao(t: RegionTestResponse, hoje: string): TesteNaLista {
  const alvo = t.weeks.districts.find((d) => d.target);
  const resultado = resultadoDoTesteDeRegiao(t);
  let veredito: string;
  if (t.status === 'interrompido' || t.status === 'cancelado') veredito = t.reason ?? t.error ?? (t.status === 'cancelado' ? 'O pedido foi recusado ou expirou em Aprovações.' : 'O teste foi interrompido: o Liame não conclui.');
  else if (resultado) veredito = resultado;
  else if (t.status === 'rodando') veredito = `${t.district.name} está sem anúncio. O resultado sai quando os ${t.days} dias acabarem.`;
  else if (t.status === 'encerrado') veredito = `O teste foi encerrado antes do fim: com menos de ${t.days} dias, o Liame não tira conclusão.`;
  else veredito = `${t.district.name} vai ficar ${t.days} dias sem anúncio nas campanhas do Liame; o caixa diz quanto o anúncio traz ali.`;
  return {
    id: t.id,
    nome: t.name,
    tipo: 'Teste de região',
    situacao: situacaoDoTeste(t.status, null, null),
    quando: quandoDoTeste(t, t.days, hoje),
    veredito,
    numeros: alvo ? [`Pedidos em ${alvo.name} nas 4 semanas de antes: ${alvo.orders}`] : [],
    pedido: t.action_id,
    criadoEm: t.created_at,
  };
}

/** Os dois tipos numa lista só, do mais novo ao mais antigo. */
export function testesDaMarca(criativos: CreativeTestResponse[], regioes: RegionTestResponse[], hoje: string): TesteNaLista[] {
  return [...criativos.map((t) => linhaDoTesteDeCriativo(t, hoje)), ...regioes.map((t) => linhaDoTesteDeRegiao(t, hoje))].sort((x, y) => (x.criadoEm < y.criadoEm ? 1 : x.criadoEm > y.criadoEm ? -1 : 0));
}
