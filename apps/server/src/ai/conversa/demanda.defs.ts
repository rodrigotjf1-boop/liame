import { z } from 'zod';
import type { FerramentaDef } from '../registro/definicoes.js';
import { FERRAMENTA_ABRIR_DEMANDA } from './prompt.js';

// A única escrita da LIA na conversa nesta entrega (A3, I10): registrar o pedido da pessoa como demanda para a
// equipe. Não é ação em plataforma (não passa pelo Action Service): grava uma linha do Liame, que o Estrategista
// transforma em plano para aprovar (I11). A marca é a da conversa (o modelo não escolhe), e a execução está em
// `conversa/demandas.service.ts`, com a permissão de quem pede e a auditoria em nome do agente.

export const TIPOS_DE_DEMANDA = ['promocao', 'plano', 'pauta', 'analise', 'outro'] as const;

export const AbrirDemandaInput = z.strictObject({
  tipo: z.enum(TIPOS_DE_DEMANDA),
  /** Um título curto ("Promoção de sexta-feira com o combo"). */
  titulo: z.string().trim().min(3).max(120),
  /** O pedido, nas palavras da pessoa. */
  pedido: z.string().trim().min(1).max(1000),
  /** O que a LIA já leu e ajuda quem cuida (números copiados das leituras). */
  anotacoes: z.string().trim().min(1).max(1000).optional(),
  /** Para quando a pessoa pediu, se ela disse (AAAA-MM-DD). */
  para_quando: z.iso.date().optional(),
});
export type AbrirDemandaInput = z.infer<typeof AbrirDemandaInput>;

export const ABRIR_DEMANDA: FerramentaDef = {
  name: FERRAMENTA_ABRIR_DEMANDA,
  version: 1,
  description:
    'Registra o pedido da pessoa como demanda para a equipe de IA: promoção, plano de 90 dias, pauta da semana, análise ou outro trabalho. Quem cuida é o Estrategista, que devolve um plano para a pessoa aprovar, editar ou recusar em Aprovações. Não executa nem publica nada. Use uma vez por pedido, sem dado de cliente.',
  risk: 'R1',
  permission: 'demanda.abrir',
  owner: 'estrategia',
  input: AbrirDemandaInput,
};

/** Os funcionários que cuidam de demanda, com o nome que a tela mostra. */
export const QUEM_CUIDA: Record<string, string> = { estrategista: 'Estrategista' };
