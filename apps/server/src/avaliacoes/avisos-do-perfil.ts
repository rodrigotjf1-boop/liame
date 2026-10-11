import type { Tx } from '@liame/database';
import { sql } from 'drizzle-orm';
import { PROVEDOR_PERFIL_GOOGLE } from '../connectors/google-business/perfil-google.js';
import type { ItemAtencao } from '../media/atencao.js';

// Os avisos do Perfil da Empresa no Google na Atenção (A6, Z1), calculados na hora sobre o que o Liame guardou:
//   - as lojas do perfil que a autorização do Google alcança e que ninguém ligou ainda;
//   - a avaliação de 1 ou 2 estrelas que segue sem resposta;
//   - a loja do perfil que parou de ser lida (desconectada, sem permissão ou com defeito).
// O limite de cota (o Google ainda não liberou o acesso, ou pediu para esperar) NÃO vira aviso: não há o que a pessoa
// fazer, e ele passa sozinho. Nenhum aviso leva o texto da avaliação nem nada de quem avaliou: só a contagem, a nota
// e o nome da loja.

/** A avaliação que pede resposta: 1 ou 2 estrelas (a mesma faixa que só o dono aprova, D-A6-4). */
export const ESTRELAS_QUE_AVISAM = 2;
/** O aviso olha as avaliações feitas nos últimos 30 dias: depois disso, responder já não muda a conversa. */
export const DIAS_DO_AVISO_DE_AVALIACAO = 30;
const FUSO_PADRAO = 'America/Sao_Paulo';

export type LojaDoAviso = { id: string; marca: string; nome: string; status: string; motivo: string | null };
export type NotasBaixasDaLoja = { conta: string; quantas: number; estrelas: number; maisRecente: Date };
export type LojasPorLigar = { marca: string; lojas: number };
export type DadosDosAvisosDoPerfil = { lojas: LojaDoAviso[]; notasBaixas: NotasBaixasDaLoja[]; porLigar: LojasPorLigar[] };

/** A autorização do Google alcança lojas do perfil, e a marca não tem nenhuma ligada. */
export function avisoLojasPorLigar(lojas: number): ItemAtencao {
  return {
    kind: 'perfil_lojas_por_ligar',
    severity: 'atencao',
    title: 'O perfil da empresa no Google está pronto para ligar',
    detail: lojas === 1 ? 'A autorização do Google alcança 1 loja do perfil que ainda não está ligada.' : `A autorização do Google alcança ${lojas} lojas do perfil que ainda não estão ligadas.`,
    action: 'Escolha a loja em Contas conectadas para o Liame ler as avaliações.',
    connected_account_id: null,
    campaign_id: null,
    provider: 'google',
  };
}

/** As avaliações de nota baixa sem resposta de uma loja: uma só diz a nota dela; várias, quantas são. */
export function avisoAvaliacoesSemResposta(loja: { id: string; nome: string }, a: { quantas: number; estrelas: number; maisRecente: Date }, fuso = FUSO_PADRAO): ItemAtencao {
  const dia = a.maisRecente.toLocaleDateString('pt-BR', { timeZone: fuso, day: '2-digit', month: '2-digit' });
  const uma = a.quantas === 1;
  return {
    kind: 'avaliacao_sem_resposta',
    severity: 'atencao',
    title: uma ? `Avaliação de ${a.estrelas} ${a.estrelas === 1 ? 'estrela' : 'estrelas'} sem resposta` : `${a.quantas} avaliações de 1 ou 2 estrelas sem resposta`,
    // "Em <loja>": a preposição não muda com o nome da loja (V121).
    detail: uma ? `Em ${loja.nome}, no Google, feita em ${dia}.` : `Em ${loja.nome}, no Google. A mais recente é de ${dia}.`,
    action: 'Responda no perfil da empresa no Google.',
    connected_account_id: loja.id,
    campaign_id: null,
    provider: null,
  };
}

/** A loja do perfil que parou de ser lida; nulo quando ela está bem. */
export function avisoDaSituacaoDaLoja(loja: Pick<LojaDoAviso, 'id' | 'nome' | 'status' | 'motivo'>): ItemAtencao | null {
  const base = { connected_account_id: loja.id, campaign_id: null, provider: null };
  if (loja.status === 'desconectada') {
    return { ...base, kind: 'conta_desconectada', severity: 'critica', title: `${loja.nome} está desconectada`, detail: loja.motivo ?? 'O Google recusou a autorização desta loja.', action: 'Conecte o Google de novo em Contas conectadas: as avaliações voltam a ser lidas.' };
  }
  if (loja.status === 'sem_permissao') {
    return { ...base, kind: 'conta_sem_permissao', severity: 'atencao', title: `Sem permissão para ler ${loja.nome}`, detail: loja.motivo ?? 'O Google recusou a leitura do perfil desta loja.', action: 'Autorize o Google de novo em Contas conectadas, com a conta que cuida do perfil.' };
  }
  if (loja.status === 'erro') {
    return { ...base, kind: 'conta_com_erro', severity: 'atencao', title: `A leitura de ${loja.nome} está falhando`, detail: loja.motivo ?? 'A última leitura falhou.', action: 'Nada a fazer por enquanto: tentamos de novo sozinhos.' };
  }
  return null;
}

/**
 * Os avisos de uma marca, na ordem em que entram na lista. As avaliações só contam na loja que está sendo lida (a
 * desconectada já tem o aviso dela, e o número parado enganaria).
 */
export function avisosDoPerfilDaMarca(marca: string, dados: DadosDosAvisosDoPerfil): ItemAtencao[] {
  const itens: ItemAtencao[] = [];
  const lojas = dados.lojas.filter((l) => l.marca === marca);
  for (const l of lojas) {
    const situacao = avisoDaSituacaoDaLoja(l);
    if (situacao) itens.push(situacao);
    const notas = dados.notasBaixas.find((n) => n.conta === l.id);
    if (notas && notas.quantas > 0 && l.status !== 'desconectada') itens.push(avisoAvaliacoesSemResposta(l, notas));
  }
  const porLigar = dados.porLigar.find((p) => p.marca === marca);
  if (porLigar && porLigar.lojas > 0 && !lojas.length) itens.push(avisoLojasPorLigar(porLigar.lojas));
  return itens;
}

/**
 * Lê o que os avisos precisam, de todas as marcas da empresa ou de uma só. Na transação de quem chama, sob a RLS da
 * empresa. O relógio é o de quem chama (V34).
 */
export async function lerDadosDosAvisosDoPerfil(tx: Tx, brandId: string | undefined, agora: Date): Promise<DadosDosAvisosDoPerfil> {
  const instante = sql`${agora.toISOString()}::timestamptz`;
  const lojas = await tx.execute<{ id: string; marca: string; nome: string; status: string; motivo: string | null }>(sql`
    select a.id, a.brand_id as marca, a.name as nome, a.status, a.status_reason as motivo
      from liame.connected_account a
     where a.provider = ${PROVEDOR_PERFIL_GOOGLE} and a.disconnected_at is null ${brandId ? sql`and a.brand_id = ${brandId}` : sql``}
     order by a.name, a.id`);
  const notas = lojas.rows.length
    ? await tx.execute<{ conta: string; quantas: number; estrelas: number; mais_recente: Date | string }>(sql`
        select r.connected_account_id as conta, count(*)::int as quantas, min(r.stars)::int as estrelas, max(r.reviewed_at) as mais_recente
          from liame.profile_review r
         where r.connected_account_id in ${lojas.rows.map((l) => l.id)}
           and r.stars <= ${ESTRELAS_QUE_AVISAM} and r.reply_text is null
           and r.reviewed_at >= ${instante} - make_interval(days => ${DIAS_DO_AVISO_DE_AVALIACAO})
         group by r.connected_account_id`)
    : { rows: [] };
  // As lojas que alguma autorização do Google da marca alcança e que não estão ligadas a marca nenhuma da empresa.
  const porLigar = await tx.execute<{ marca: string; lojas: number }>(sql`
    select c.brand_id as marca, count(distinct d ->> 'external_id')::int as lojas
      from liame.oauth_connection c
      cross join lateral jsonb_array_elements(c.discovered) as d
     where c.provider = 'google' and c.status in ('ativa', 'aguardando_escolha') ${brandId ? sql`and c.brand_id = ${brandId}` : sql``}
       and d ->> 'provider' = ${PROVEDOR_PERFIL_GOOGLE}
       and not exists (
         select 1 from liame.connected_account a
          where a.tenant_id = c.tenant_id and a.provider = ${PROVEDOR_PERFIL_GOOGLE} and a.disconnected_at is null and a.external_id = d ->> 'external_id')
     group by c.brand_id`);
  return {
    lojas: lojas.rows,
    notasBaixas: notas.rows.map((n) => ({ conta: n.conta, quantas: n.quantas, estrelas: n.estrelas, maisRecente: new Date(n.mais_recente) })),
    porLigar: porLigar.rows,
  };
}
