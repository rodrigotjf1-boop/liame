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
    // v2 (04/10/2026): não manda mais ler antes de todo número; os resultados e os cupons já trazem o frescor deles.
    version: 2,
    description:
      'Situação das contas conectadas (Meta, Google Ads, GA4, Regem) e o frescor de cada conjunto de dados: quando foi a última leitura e se está em dia, atrasada ou parada. Use quando a pergunta for sobre as contas conectadas ou sobre de quando são os dados; as leituras dos resultados e dos cupons já trazem o frescor das fontes delas.',
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
    name: 'como_te_acham',
    version: 1,
    description:
      'Como as pessoas acham a marca no Google, como o cartão "Como te acham no Google" de Resultados mostra: o perfil da empresa no Google (as vezes em que ele apareceu na busca do Google e no Google Maps, e o que as pessoas fizeram: pedidos de rota, ligações, cliques no site e no cardápio) e o site no Search Console (os cliques vindos das buscas, as vezes em que o site apareceu, a posição média e os cliques de cada dia), nos últimos 7 ou 30 dias que o Google já informou (ele entrega com dois a três dias de atraso), com os dias anteriores do mesmo tamanho; e as buscas que mais trouxeram cliques ao site na última semana fechada. Cada parte só vem quando está disponível para a empresa, e cada loja e cada site trazem o frescor da leitura. Use quando a pergunta for sobre o Google fora dos anúncios: o perfil, o Maps, as buscas, o site.',
    risk: 'R0',
    permission: 'vendas.ver',
    owner: 'vendas',
    input: z.strictObject({ brand_id: z.uuid(), dias: z.enum(['7', '30']).optional() }),
  },
  {
    name: 'equipe_trabalho',
    // v2 (09/10/2026): o Criativo entrou na equipe (A4, P12): `funcionario` aceita `criativo`, e os números trazem as peças.
    // v3 (09/10/2026): o CRM e mensageria entrou na equipe (A5, P16): `funcionario` aceita `crm`, e os números trazem as mensagens.
    // v4 (29/10/2026): o Social media entrou na equipe (A6, P21, sem os posts): `funcionario` aceita `social`, e os números trazem as respostas às avaliações.
    // v5 (30/10/2026): os posts do Social media (A6, Z6, os posts, parte 3): os números, a fila dos dias da pauta, o que segura os posts e os acontecimentos deles.
    version: 5,
    description:
      'O trabalho da equipe do Liame para uma marca, como a tela Sua equipe mostra: a situação de cada funcionário (ativo, em sombra, desligado, parado), o que cada um fez no mês contado pelo sistema (respostas, explicações, revisões da semana, planos, páginas lidas, textos barrados, peças de anúncio, mensagens de WhatsApp propostas, posts propostos a partir da pauta e respostas às avaliações do Google sugeridas, recomendações em sombra), o custo de IA de cada um e o gasto e o limite de IA da empresa no mês. Com `funcionario` (`lia`, `analista` para o Analista de dados, `relatorios`, `compliance`, `estrategista`, `pesquisador`, `criativo`, `crm` para o CRM e mensageria, `social` para o Social media, ou `trafego` para o Gestor de tráfego), traz só esse funcionário e os últimos acontecimentos dele (o que fez e quando). Use quando a pessoa perguntar sobre o trabalho, a situação ou o custo de um funcionário ou da equipe.',
    risk: 'R0',
    // A rota de Sua equipe pede também `vendas.ver` e uma pessoa na sessão: `EXIGE`, em `leituras.ts`.
    permission: 'campanhas.ver',
    owner: 'equipe',
    input: z.strictObject({ brand_id: z.uuid(), funcionario: z.enum(TEAM_MEMBERS).optional() }),
  },
];

/**
 * As leituras dos números da marca (frescor, avisos, resultados, entrega, cupons, links e o Google): as que o
 * Estrategista usa para montar um plano. A leitura da equipe é só da conversa.
 */
export const LEITURAS_DE_DADOS = ['fontes_frescor', 'atencao_avisos', 'resultados_ciclo_fechado', 'midia_entrega', 'cupons_campanha', 'links_rastreio', 'como_te_acham'] as const;
