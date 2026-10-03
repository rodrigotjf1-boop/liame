import { dia } from '../registro/formatos.js';

// O que as escritas da conversa devolvem ao modelo (A3, I10 e I10b): o mesmo formato na produção
// (`conversa/conversa.service.ts`) e no eval (`ai/evals/conversa.ts`), que simula as escritas sem banco.
// Datas já como a pessoa lê (DD/MM/AAAA): o que voltar daqui vale como fonte de número na conferência.

export function valorDaDemanda(d: { titulo: string; quemCuida: string; situacao: string; paraQuando: string | null; nova: boolean }) {
  return {
    demanda: {
      titulo: d.titulo,
      quem_cuida: d.quemCuida,
      situacao: d.situacao,
      ...(d.paraQuando ? { para_quando: dia(d.paraQuando) } : {}),
      ...(d.nova ? {} : { observacao: 'Esta demanda já estava registrada para esta mensagem.' }),
    },
  };
}

/** `de`, `ate` e `expira` em AAAA-MM-DD (o prazo já convertido para o fuso da loja por quem chama). */
export function valorDaProposta(p: { codigo: string; loja: string; campanha: string | null; de: string; ate: string; expira: string }) {
  return {
    proposta: {
      situacao: 'esperando aprovação em Aprovações',
      cupom: p.codigo,
      loja: p.loja,
      campanha: p.campanha,
      validade: `${dia(p.de)} a ${dia(p.ate)}`,
      expira_sem_aprovacao_em: dia(p.expira),
    },
  };
}
