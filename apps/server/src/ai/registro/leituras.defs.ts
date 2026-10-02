import { z } from 'zod';
import type { FerramentaDef } from './definicoes.js';

// Ferramentas de leitura dos funcionários de IA (R0). Só a definição: o que o modelo lê para decidir
// usar e o formato dos parâmetros. A execução está em `leituras.ts`, sempre pelos mesmos serviços das
// rotas, com a permissão da pessoa e na transação da empresa. As demais leituras do plano (resultados do
// ciclo fechado, métricas de mídia, cupons e links) entram na sequência, cada uma com a sua visão para o
// modelo (números já formatados).

const DaMarca = z.strictObject({
  /** Sem a marca, todas as marcas da empresa. */
  brand_id: z.uuid().optional(),
});

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
];
