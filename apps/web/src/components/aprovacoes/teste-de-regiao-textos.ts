import { REGION_TEST_WEEKS_BEFORE, type RegionTestResponse } from '@liame/contracts';

// O teste de região em Aprovações (plano da região, R8; protótipo dos testes aprovado pelo dono em 13/11/2026; D-RG-81 e
// D-RG-82): as regras puras do detalhe. Por enquanto, aprovar só marca o teste como pronto: os passos que tiram o bairro
// das campanhas e o devolvem entram depois da prova na conta real (D-RG-89), e a tela diz isso sem prometer o que não faz.

const PREFIXO = 'teste_de_regiao:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** O pedido é o do teste de região (a ferramenta `teste_de_regiao`)? */
export const ehPedidoDoTesteDeRegiao = (a: { tool: string }): boolean => a.tool === 'teste_de_regiao';

/** O id do teste no recurso do pedido (`teste_de_regiao:<id>`), ou nulo quando o recurso é outro. */
export function idDoTesteDeRegiao(recurso: string): string | null {
  if (!recurso.startsWith(PREFIXO)) return null;
  const id = recurso.slice(PREFIXO.length);
  return UUID.test(id) ? id : null;
}

/** "Teste de região: Lapa sem anúncio por 14 dias" (o nome do teste já diz o bairro e os dias). */
export const tituloDoTesteDeRegiao = (nome: string | null): string => (nome ? `Teste de região: ${nome}` : 'Teste de região');

/** Os pedidos por semana, com uma casa quando não é inteiro ("12,5"). */
const porSemana = (pedidos: number): string => {
  const n = pedidos / REGION_TEST_WEEKS_BEFORE;
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace('.', ',');
};

/** A tabela dos bairros nas semanas de antes: o do teste primeiro, depois os de comparar, como o servidor guardou. */
export function bairrosDoTeste(t: RegionTestResponse): Array<{ nome: string; porSemana: string; alvo: boolean }> {
  const alvo = t.weeks.districts.filter((d) => d.target);
  const outros = t.weeks.districts.filter((d) => !d.target);
  return [...alvo, ...outros].map((d) => ({ nome: d.name, porSemana: porSemana(d.orders), alvo: d.target }));
}

/** "de 12/10 a 08/11": as 4 semanas que entram na conta. */
export const semanasDoTeste = (t: RegionTestResponse): string => `de ${t.weeks.from.slice(8, 10)}/${t.weeks.from.slice(5, 7)} a ${t.weeks.to.slice(8, 10)}/${t.weeks.to.slice(5, 7)}`;

export function situacaoDoTesteDeRegiao(t: RegionTestResponse): { rotulo: string; tom: 'espera' | 'trabalhando' | 'concluido' | 'perigo' | 'neutro' } {
  switch (t.status) {
    case 'pedido':
      return { rotulo: 'Espera a aprovação', tom: 'espera' };
    case 'criando':
    case 'pronto':
      return { rotulo: 'Pronto', tom: 'espera' };
    case 'rodando':
      return { rotulo: 'Rodando', tom: 'trabalhando' };
    case 'terminado':
      return { rotulo: 'Terminado', tom: 'concluido' };
    case 'encerrado':
      return { rotulo: 'Encerrado antes do fim', tom: 'neutro' };
    case 'interrompido':
      return { rotulo: 'Interrompido', tom: 'perigo' };
    case 'cancelado':
      return { rotulo: 'Não foi pedido', tom: 'neutro' };
  }
}

/** O que aconteceu depois do pedido, em uma frase; nulo enquanto espera a aprovação. */
export function andamentoDoTesteDeRegiao(t: RegionTestResponse): string | null {
  switch (t.status) {
    case 'pedido':
      return null;
    case 'criando':
    case 'pronto':
      return `Aprovado: o teste está pronto. Tirar ${t.district.name} dos anúncios ainda não está ligado no Liame, e nada mudou na Meta.`;
    case 'rodando':
      return t.started_on ? `Desde ${t.started_on.slice(8, 10)}/${t.started_on.slice(5, 7)}, ${t.district.name} está sem anúncio nas campanhas do Liame.` : `${t.district.name} está sem anúncio nas campanhas do Liame.`;
    case 'terminado':
      return `O teste terminou. ${t.district.name} voltou a receber os anúncios das campanhas do Liame.`;
    case 'encerrado':
      return `O teste foi encerrado antes do fim. ${t.district.name} voltou a receber os anúncios.`;
    case 'interrompido':
      return t.reason ?? 'O teste foi interrompido: o Liame não conclui.';
    case 'cancelado':
      return t.error ?? 'O pedido foi recusado ou expirou em Aprovações: nada mudou na Meta.';
  }
}

/** Os conjuntos das campanhas do Liame que mostram anúncio no bairro, numa frase (de onde o bairro sai no teste). */
export function conjuntosDoTesteDeRegiao(t: RegionTestResponse): string {
  const n = t.ad_sets.length;
  if (!n) return `Nenhum conjunto das campanhas do Liame mostra anúncio em ${t.district.name} agora.`;
  const campanhas = new Set(t.ad_sets.map((a) => a.campaign_id)).size;
  return `${n === 1 ? 'Um conjunto' : `${n} conjuntos`} de ${campanhas === 1 ? 'uma campanha' : `${campanhas} campanhas`} do Liame ${n === 1 ? 'mostra' : 'mostram'} anúncio em ${t.district.name}: é deles que o bairro sai no teste, por ${t.days} dias. A verba de cada campanha fica como está.`;
}
