import { comArtigo } from '../registro/leituras.visoes.js';
import type { ContextoDaExplicacao } from './contexto.js';
import type { Explicacao } from './resposta.js';

// A explicação sem IA (A3-6): o mesmo formato, montado por regra a partir dos mesmos números. É o que a
// tela mostra com a IA desligada, fora do ar, no teto de custo, com dado velho ou quando a resposta da IA
// é recusada. Texto simples e sempre verdadeiro; a IA, quando entra, só diz melhor.

const sobe = (v: string | null) => v !== null && v.startsWith('+');
const cai = (v: string | null) => v !== null && v.startsWith('-');
const movimento = (v: string | null) => (sobe(v) ? `subiu ${v!.slice(1)}` : cai(v) ? `caiu ${v!.slice(1)}` : 'ficou igual');

export function explicacaoSemIa(c: ContextoDaExplicacao): Explicacao {
  const t = c.resultado.totais;
  const origem = t.com_origem_provada;
  const periodo = `De ${c.resultado.periodo.de} a ${c.resultado.periodo.ate}`;
  const semInvestimento = t.investimento === 'R$ 0,00';
  const aconteceu = [
    semInvestimento
      ? `${periodo} não houve investimento em anúncios lido pelo Liame.`
      : `${periodo} o investimento em anúncios foi de ${t.investimento} e o caixa confirmou ${origem.pedidos ?? '0'} pedido(s) com origem provada em campanha, com receita de ${origem.receita ?? 'R$ 0,00'}.`,
  ];
  if (origem.roas) aconteceu.push(`O ROAS confirmado no caixa foi ${origem.roas} (quanto voltou em vendas para cada real investido).`);
  const cmp = c.comparacao;
  if (cmp && (cmp.investimento.variacao || cmp.receita_com_origem.variacao)) {
    const partes = [
      cmp.investimento.variacao ? `o investimento ${movimento(cmp.investimento.variacao)}` : null,
      cmp.receita_com_origem.variacao ? `a receita com origem provada ${movimento(cmp.receita_com_origem.variacao)}` : null,
    ].filter((p): p is string => p !== null);
    aconteceu.push(`Em relação ao período anterior, ${partes.join(' e ')}.`);
  }

  const motivos: string[] = [];
  const maior = c.resultado.campanhas[0];
  if (maior?.plataforma_informa.investimento) {
    motivos.push(
      `A campanha com mais investimento foi "${maior.campanha}" (${maior.plataforma_informa.investimento}), com ${maior.caixa_confirma.pedidos ?? '0'} pedido(s) confirmado(s) no caixa.`,
    );
  }
  const plataforma = c.resultado.plataformas[0];
  if (plataforma?.plataforma_informa.roas && plataforma.caixa_confirma.roas && plataforma.plataforma_informa.roas !== plataforma.caixa_confirma.roas) {
    motivos.push(`${comArtigo(plataforma.plataforma ?? 'plataforma', true)} informa ROAS de ${plataforma.plataforma_informa.roas}; o caixa confirma ${plataforma.caixa_confirma.roas}. Para decidir, vale o do caixa.`);
  }
  if (t.sem_origem.pedidos && t.sem_origem.pedidos !== '0') {
    motivos.push(`${t.sem_origem.pedidos} pedido(s) dos canais com clique ficaram sem origem provada${t.sem_origem.parte_dos_pedidos_com_clique ? ` (${t.sem_origem.parte_dos_pedidos_com_clique})` : ''}: não dá para dizer de que campanha vieram.`);
  }
  if (!motivos.length) motivos.push('Ainda não há campanha com investimento e pedido confirmado neste período para comparar.');

  // O risco e o porquê dele, pela regra do sistema (a mesma do veredito da tela Resultados).
  const piorou = sobe(cmp?.investimento.variacao ?? null) && cai(cmp?.receita_com_origem.variacao ?? null);
  const [risco, porque]: [Explicacao['risco'], string] =
    origem.resultado === 'prejuízo'
      ? ['alto', 'o período deu prejuízo depois de pagar os anúncios.']
      : origem.resultado === 'lucro'
        ? ['baixo', 'o período deu lucro depois de pagar os anúncios.']
        : origem.resultado === 'empata'
          ? ['medio', 'o período empata: a margem conhecida fica perto do investimento.']
          : piorou
            ? ['alto', 'o investimento subiu e a receita com origem provada caiu.']
            : semInvestimento
              ? ['medio', 'sem investimento em anúncios lido, não há retorno para avaliar.']
              : ['medio', 'falta custo cadastrado para dizer se o período deu lucro.'];

  const fazer: string[] = [];
  if (c.fontes_fora_do_dia.length) fazer.push('Confira em Contas conectadas as fontes que não estão em dia antes de decidir com estes números.');
  if (t.sem_origem.pedidos && t.sem_origem.pedidos !== '0') fazer.push('Use um cupom exclusivo por campanha e o link com rastreio nos anúncios, para provar de onde vem cada pedido.');
  if (risco === 'alto') fazer.push('Olhe as campanhas com mais investimento e menos pedidos confirmados antes de manter a verba.');
  if (!fazer.length) fazer.push('Acompanhe os avisos da Atenção: eles apontam o que precisa de você.');

  return { o_que_aconteceu: aconteceu.join(' '), motivos: motivos.slice(0, 4), risco, risco_motivo: `pela regra do sistema, ${porque}`, o_que_fazer: fazer.slice(0, 3) };
}
