import { TEAM_MEMBERS } from '@liame/contracts';
import { z } from 'zod';
import type { FerramentaDef } from './definicoes.js';

// Ferramentas de leitura dos funcionários de IA (R0). Só a definição: o que o modelo lê para decidir
// usar e o formato dos parâmetros. A execução está em `leituras.ts`, sempre pelos mesmos serviços das
// rotas, com a permissão da pessoa e na transação da empresa; o modelo recebe a visão já formatada
// (`visoes/`), nunca o número cru.

const Dia = z.iso.date();

const DaMarca = z.strictObject({
  /** Sem a marca, todas as marcas da empresa. */
  brand_id: z.uuid().optional(),
});
const SoDaMarca = z.strictObject({ brand_id: z.uuid() });
const Periodo = { from: Dia, to: Dia };

export const LEITURAS: FerramentaDef[] = [
  {
    name: 'fontes_frescor',
    version: 1,
    description:
      'Situação das contas conectadas (Meta, Google Ads, GA4, Regem) e o frescor de cada conjunto de dados: quando foi a última leitura e se está em dia, atrasada ou parada. Use antes de comentar números, para dizer de quando eles são.',
    risk: 'R0',
    permission: 'contas.ver',
    owner: 'midia',
    input: DaMarca,
  },
  {
    name: 'atencao_avisos',
    version: 1,
    description:
      'Avisos que precisam de alguém agora, calculados pelo sistema: conta que parou de ler, dado atrasado, autorização perto de vencer, gasto fora do normal, campanha sem pedido confirmado, cupom sem uso, diferença entre a plataforma e o caixa. Cada aviso traz a gravidade, o detalhe com os números e o que fazer.',
    risk: 'R0',
    permission: 'campanhas.ver',
    owner: 'midia',
    input: DaMarca,
  },
  {
    name: 'resultados_ciclo_fechado',
    version: 1,
    description:
      'Resultado das campanhas de uma marca num período (até 92 dias): investimento, o que a plataforma de anúncios informa (com a janela dela) e o que o caixa da loja confirma (pedidos, receita, ROAS confirmado, custo por pedido, margem e se deu lucro, empate ou prejuízo), no total, por plataforma e por campanha. Traz também os pedidos sem origem, os canais sem clique e o frescor de cada fonte. Os dias são os do fuso da loja.',
    risk: 'R0',
    permission: 'vendas.ver',
    owner: 'vendas',
    input: z.strictObject({ brand_id: z.uuid(), unit_id: z.uuid().optional(), ...Periodo }),
  },
  {
    name: 'midia_entrega',
    version: 1,
    description:
      'Entrega dos anúncios num período (até 92 dias), por campanha e por dia: investimento, impressões, cliques, cliques no link, CTR, custo por clique e custo por mil impressões. Para conversões, valor de venda e ROAS, use `resultados_ciclo_fechado`.',
    risk: 'R0',
    permission: 'campanhas.ver',
    owner: 'midia',
    input: z.strictObject({ brand_id: z.uuid().optional(), ...Periodo }),
  },
  {
    name: 'cupons_campanha',
    version: 1,
    description:
      'Cupons das lojas de uma marca: regra de desconto, validade, usos e receita dos últimos 7 dias, a campanha a que cada um está ligado (só o cupom exclusivo prova de onde veio o pedido), os pedidos de criação em andamento e a plataforma de pedidos de cada loja.',
    risk: 'R0',
    permission: 'vendas.ver',
    owner: 'vendas',
    input: SoDaMarca,
  },
  {
    name: 'links_rastreio',
    version: 1,
    description:
      'Links de campanha de uma marca (com os pedidos dos últimos 7 dias de cada um) e a conferência do rastreio dos anúncios ativos: quantos levam o link com rastreio, quantos não, e o que arrumar em cada anúncio.',
    risk: 'R0',
    permission: 'vendas.ver',
    owner: 'vendas',
    input: SoDaMarca,
  },
  {
    name: 'equipe_trabalho',
    version: 1,
    description:
      'O trabalho da equipe do Liame para uma marca, como a tela Sua equipe mostra: a situação de cada funcionário (ativo, em sombra, desligado, parado), o que cada um fez no mês contado pelo sistema (respostas, explicações, revisões da semana, planos, páginas lidas, textos barrados, recomendações em sombra), o custo de IA de cada um e o gasto e o limite de IA da empresa no mês. Com `funcionario` (`lia`, `analista` para o Analista de dados, `relatorios`, `compliance`, `estrategista`, `pesquisador` ou `trafego` para o Gestor de tráfego), traz só esse funcionário e os últimos acontecimentos dele (o que fez e quando). Use quando a pessoa perguntar sobre o trabalho, a situação ou o custo de um funcionário ou da equipe.',
    risk: 'R0',
    // A rota de Sua equipe pede também `vendas.ver` e uma pessoa na sessão: `EXIGE`, em `leituras.ts`.
    permission: 'campanhas.ver',
    owner: 'equipe',
    input: z.strictObject({ brand_id: z.uuid(), funcionario: z.enum(TEAM_MEMBERS).optional() }),
  },
];

/**
 * As leituras dos números da marca (frescor, avisos, resultados, entrega, cupons e links): as que o Estrategista usa
 * para montar um plano. A leitura da equipe é só da conversa.
 */
export const LEITURAS_DE_DADOS = ['fontes_frescor', 'atencao_avisos', 'resultados_ciclo_fechado', 'midia_entrega', 'cupons_campanha', 'links_rastreio'] as const;
