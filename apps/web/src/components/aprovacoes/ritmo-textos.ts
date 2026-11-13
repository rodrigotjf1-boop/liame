import type { RegionRhythmDetailResponse, RegionRhythmReason, RegionRhythmRef, RegionRhythmResponse, RegionRhythmStep } from '@liame/contracts';
import type { NomeIcone } from '@/components/ui/icone';
import { reaisDeMicros } from '@/lib/formato';

// O ritmo da semana em Aprovações (plano da região, R7, parte 1b-3; protótipo aprovado pelo dono em 13/11/2026): as
// frases da tela, sem React. O pedido é do Gestor de tráfego, por regra e sem IA: a verba de cada dia segue os pedidos
// da loja, a chuva prevista e as datas, sem gastar mais na semana. Aqui ficam o título, o porquê de cada dia, a
// situação do ritmo e de cada campanha, o caminho (o que o Liame já fez em cada dia) e o motivo do que ficou bloqueado.

export const FERRAMENTA_DO_RITMO = 'ritmo_da_semana';
export const FERRAMENTA_DA_VERBA_DO_DIA = 'orcamento_do_ritmo';
export const ehPedidoDoRitmo = (a: { tool: string }): boolean => a.tool === FERRAMENTA_DO_RITMO;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** O id do ritmo no recurso do pedido (`ritmo:<id>`), ou nulo quando o recurso é outro. */
export function idDoRitmo(recurso: string): string | null {
  const id = recurso.startsWith('ritmo:') ? recurso.slice('ritmo:'.length) : '';
  return UUID.test(id) ? id : null;
}

type Ritmo = RegionRhythmDetailResponse;
type Campanha = Ritmo['campaigns'][number];

const reais = (micros: number): string => reaisDeMicros(BigInt(Math.round(micros)));
const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'] as const;
const NO_DIA = ['no domingo', 'na segunda', 'na terça', 'na quarta', 'na quinta', 'na sexta', 'no sábado'] as const;
/** "16/11" de "2026-11-16". */
export const diaMes = (dia: string): string => `${dia.slice(8, 10)}/${dia.slice(5, 7)}`;
/** "Seg, 16/11". */
export const diaEscrito = (dia: string, diaDaSemana: number): string => `${DIAS[diaDaSemana] ?? ''}, ${diaMes(dia)}`;
export const tituloDoRitmo = (semana: { from: string; to: string }): string => `Ritmo da semana: ${diaMes(semana.from)} a ${diaMes(semana.to)}`;

/** "às 18:42 de 15/11", na hora de Brasília (a hora em que o pedido foi feito, aprovado ou parado). */
export function quandoEscrito(instante: string): string {
  const partes = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(instante));
  const de = (tipo: string) => partes.find((p) => p.type === tipo)?.value ?? '';
  return `${de('day')}/${de('month')} às ${de('hour')}:${de('minute')}`;
}

/** Quanto o dia muda sobre a verba de hoje: "+9%", "−10%" ou "igual a hoje". */
export function variacaoDoDia(peso: number): { texto: string; tom: 'mais' | 'menos' | 'igual' } {
  const pct = Math.round((peso - 1) * 100);
  if (pct === 0) return { texto: 'igual a hoje', tom: 'igual' };
  return { texto: `${pct > 0 ? '+' : '−'}${Math.abs(pct)}%`, tom: pct > 0 ? 'mais' : 'menos' };
}

/** O porquê do peso de um dia, com o ícone: os pedidos da loja, a referência do setor, a chuva prevista ou a data. */
export function porqueDoDia(r: RegionRhythmReason): { icone: NomeIcone; texto: string } {
  if (r.kind === 'pedidos') {
    const p = r.share_pct ?? 0;
    const texto =
      p <= 10
        ? `Dia fraco: ${p}% dos pedidos da semana (a média de um dia é 14%)`
        : p <= 13
          ? `Abaixo da média: ${p}% dos pedidos da semana`
          : p <= 15
            ? `Na média: ${p}% dos pedidos da semana`
            : p <= 18
              ? `Acima da média: ${p}% dos pedidos da semana`
              : `Dia forte: ${p}% dos pedidos da semana`;
    return { icone: 'chart', texto };
  }
  if (r.kind === 'chuva') {
    const previsao = (r.text ?? 'chuva').trim();
    const graus = r.min !== null && r.max !== null ? `, ${r.min}° a ${r.max}°` : '';
    return { icone: 'cloud-rain', texto: `Chuva prevista: ${previsao.charAt(0).toLocaleLowerCase('pt-BR')}${previsao.slice(1)}${graus}` };
  }
  if (r.kind === 'data') return { icone: 'calendar', texto: r.eve ? `Véspera: ${r.text ?? 'data do calendário'}` : (r.text ?? 'Data do calendário') };
  // Sem pedidos que bastem da loja: a referência do setor, dita como referência.
  return { icone: 'info', texto: 'Sem pedidos que bastem da loja: vale a referência do setor (mais peso de sexta a domingo)' };
}

export type SituacaoDoRitmo = { rotulo: string; tom: 'espera' | 'concluido' | 'info' | 'perigo' | 'neutro' };

/** A situação do ritmo para o selo do topo. */
export function situacaoDoRitmo(r: Pick<Ritmo, 'status' | 'today' | 'week'>): SituacaoDoRitmo {
  if (r.status === 'pedido') return { rotulo: 'Espera a aprovação', tom: 'espera' };
  if (r.status === 'cancelado') return { rotulo: 'Não aprovado', tom: 'neutro' };
  if (r.status === 'parado') return { rotulo: 'Parado', tom: 'perigo' };
  if (r.status === 'encerrado') return { rotulo: 'Encerrado', tom: 'neutro' };
  if (r.today < r.week.from) return { rotulo: 'Aprovado: começa na segunda', tom: 'info' };
  return r.today <= r.week.to ? { rotulo: 'Rodando', tom: 'concluido' } : { rotulo: 'Voltando à verba de antes', tom: 'info' };
}

const lista = (itens: readonly string[]): string => (itens.length <= 1 ? (itens[0] ?? '') : `${itens.slice(0, -1).join(', ')} e ${itens.at(-1)}`);

/**
 * A frase do pedido: onde a verba desce e onde sobe, e o total da semana. Os dias com menos de 3% de diferença ficam
 * como "igual a hoje" e não entram na frase.
 */
export function fraseDoRitmo(r: Pick<Ritmo, 'days' | 'source' | 'week_micros' | 'base_week_micros' | 'campaigns'>): { dias: string; semana: string } {
  const menos = r.days.filter((d) => d.weight < 0.97).map((d) => NO_DIA[d.weekday] ?? '');
  const mais = r.days.filter((d) => d.weight > 1.03).map((d) => NO_DIA[d.weekday] ?? '');
  const base = r.source === 'loja' ? 'os pedidos da loja' : 'a referência do setor';
  const partes = [menos.length ? `menos ${lista(menos)}` : null, mais.length ? `mais ${lista(mais)}` : null].filter((x): x is string => x !== null);
  const dias = partes.length ? `Nesta semana, a verba de cada dia segue ${base}: ${partes.join('; ')}.` : `Nesta semana, a verba de cada dia fica igual à de hoje: ${base} não ${r.source === 'loja' ? 'pedem' : 'pede'} mudança.`;
  const n = r.campaigns.length;
  const semana = `A semana não gasta mais: ${reais(r.week_micros)} nos 7 dias (sem o ritmo, ${reais(r.base_week_micros)}), em ${n === 1 ? '1 campanha' : `${n} campanhas`}.`;
  return { dias, semana };
}

const MOTIVOS_DO_PORTAO: Record<string, string> = {
  ritmo_parado: 'o ritmo foi parado antes de o passo sair',
  ritmo_nao_aprovado: 'o ritmo não está aprovado',
  fora_do_dia: 'o pedido ficou na fila e o dia virou',
  funcao_desligada: 'a função do ritmo está desligada',
  acima_do_aprovado: 'passaria do que foi aprovado para o dia',
  acima_do_teto_por_campanha: 'passaria do teto por campanha',
  passo_desconhecido: 'o Liame não achou o passo deste pedido',
};

/** O motivo de um passo bloqueado, em palavras: o servidor guarda o código e a frase da recusa. */
export function motivoDoBloqueio(motivo: string | null): string {
  if (!motivo) return 'não coube nos limites de agora';
  const doPortao = /^ritmo(?: da semana|-segurado):.*?\(?([a-z_]+)\)?\.?$/.exec(motivo);
  if (doPortao?.[1] && MOTIVOS_DO_PORTAO[doPortao[1]]) return MOTIVOS_DO_PORTAO[doPortao[1]]!;
  // "orcamento-insuficiente: Não cabe na verba de novembro: …" → fica a frase, sem o código.
  const semCodigo = motivo.replace(/^[a-z-]+: /, '');
  return semCodigo.charAt(0).toLocaleLowerCase('pt-BR') + semCodigo.slice(1).replace(/\.$/, '');
}

export type CampanhaNoRitmo = { rotulo: string; tom: 'concluido' | 'info' | 'perigo' | 'neutro'; nota: string | null };

/** A situação de uma campanha no ritmo, com o que a pessoa precisa saber dela. */
export function campanhaNoRitmo(c: Pick<Campanha, 'state' | 'left_micros' | 'base_micros' | 'steps'>): CampanhaNoRitmo | null {
  const ultimo = c.steps.at(-1);
  if (c.state === 'fora') {
    const dia = c.steps.find((p) => p.status === 'fora')?.day;
    return {
      rotulo: 'Saiu do ritmo',
      tom: 'perigo',
      nota: `${dia ? `Em ${diaMes(dia)}, ` : ''}a verba dela na Meta não era a que o Liame tinha deixado (ou ela foi pausada): alguém mudou por fora. O Liame não mexe mais nela nesta semana, e ela fica como está.`,
    };
  }
  if (c.state === 'voltando') {
    const presa = ultimo?.status === 'bloqueado' ? ` A volta de ${diaMes(ultimo.day)} não saiu: ${motivoDoBloqueio(ultimo.reason)}. O Liame tenta de novo todo dia.` : ' A volta respeita o limite de 10% por mudança.';
    return { rotulo: 'Voltando à verba de antes', tom: 'info', nota: `Está em ${reais(c.left_micros)} por dia; a de antes é ${reais(c.base_micros)}.${presa}` };
  }
  if (c.state === 'voltou') return { rotulo: 'De volta à verba de antes', tom: 'neutro', nota: null };
  if (c.state === 'no_ritmo') {
    return ultimo?.status === 'bloqueado'
      ? { rotulo: 'No ritmo', tom: 'concluido', nota: `O passo de ${diaMes(ultimo.day)} não saiu: ${motivoDoBloqueio(ultimo.reason)}.` }
      : { rotulo: 'No ritmo', tom: 'concluido', nota: null };
  }
  return null;
}

export type PassoDaTrilha = { estado: 'ok' | 'espera' | 'falha' | 'depois'; titulo: string; sub: string | null };

const contar = (n: number, um: string, varios: string): string => (n === 1 ? `1 ${um}` : `${n} ${varios}`);

/** O que aconteceu num dia, somadas as campanhas: quantas ficaram na verba do dia, quantas saíram ou ficaram bloqueadas. */
function resumoDoDia(passos: readonly RegionRhythmStep[]): { texto: string; falhou: boolean; naFila: boolean } {
  const de = (status: string) => passos.filter((p) => p.status === status).length;
  const [feitos, iguais, fila, fora, bloqueados] = [de('feito'), de('igual'), de('pedido'), de('fora'), de('bloqueado')];
  const partes = [
    feitos + iguais ? `${contar(feitos + iguais, 'campanha', 'campanhas')} na verba do dia` : null,
    fila ? `${contar(fila, 'mudança', 'mudanças')} na fila` : null,
    fora ? `${contar(fora, 'saiu', 'saíram')} do ritmo` : null,
    bloqueados ? `${contar(bloqueados, 'ficou bloqueada', 'ficaram bloqueadas')}` : null,
  ].filter((x): x is string => x !== null);
  return { texto: partes.join(' · '), falhou: fora + bloqueados > 0, naFila: fila > 0 };
}

/**
 * O caminho do ritmo: o pedido, a aprovação, cada dia da semana (o que o Liame fez, o dia de hoje e os que faltam), a
 * parada e a volta à verba de antes.
 */
export function trilhaDoRitmo(r: Ritmo): PassoDaTrilha[] {
  const trilha: PassoDaTrilha[] = [{ estado: 'ok', titulo: 'Pedido pelo Gestor de tráfego', sub: quandoEscrito(r.requested_at) }];
  if (r.status === 'pedido') return [...trilha, { estado: 'espera', titulo: 'Espera a sua aprovação, com o código do app', sub: 'uma aprovação vale para os 7 dias' }];
  if (r.status === 'cancelado') return [...trilha, { estado: 'falha', titulo: 'Não aprovado: recusado, ou o prazo acabou', sub: 'nada mudou nas campanhas' }];
  if (r.approved_at) trilha.push({ estado: 'ok', titulo: `Aprovado${r.approved_by ? ` por ${r.approved_by.name}` : ''}, com o código do app`, sub: quandoEscrito(r.approved_at) });
  const doRitmo = r.campaigns.flatMap((c) => c.steps.filter((p) => p.kind === 'ritmo'));
  const paradoEm = r.stopped_at ? r.stopped_at.slice(0, 10) : null;
  for (const d of r.days) {
    const dia = diaEscrito(d.day, d.weekday);
    const passos = doRitmo.filter((p) => p.day === d.day);
    if (passos.length) {
      const resumo = resumoDoDia(passos);
      const hoje = d.day === r.today ? ' (hoje)' : '';
      trilha.push({ estado: resumo.falhou ? 'falha' : resumo.naFila ? 'espera' : 'ok', titulo: `${dia}${hoje}: verba do dia ${reais(d.total_micros)}`, sub: resumo.texto });
    } else if (r.status === 'aprovado' && d.day === r.today) {
      trilha.push({ estado: 'espera', titulo: `${dia} (hoje): verba do dia ${reais(d.total_micros)}`, sub: 'o Liame põe a verba do dia em instantes' });
    } else if (r.status === 'aprovado' && d.day > r.today) {
      trilha.push({ estado: 'depois', titulo: `${dia}: ${reais(d.total_micros)}`, sub: null });
    }
    // Os dias de antes da aprovação, e os de depois da parada, não têm passo: ficam fora do caminho.
    if (paradoEm === d.day && r.status === 'parado') break;
  }
  if (r.stopped_at) trilha.push({ estado: 'falha', titulo: `Parado${r.stopped_by ? ` por ${r.stopped_by.name}` : ''}`, sub: quandoEscrito(r.stopped_at) });
  const semVoltar = r.campaigns.filter((c) => c.state === 'voltando').length;
  const fora = r.campaigns.filter((c) => c.state === 'fora').length;
  if (r.status === 'aprovado' && r.today <= r.week.to) {
    trilha.push({ estado: 'depois', titulo: `Depois de ${diaMes(r.week.to)}: a verba volta à de antes (${reais(r.base_micros)} por dia)`, sub: 'em até 10% por dia' });
  } else if (semVoltar) {
    trilha.push({ estado: 'espera', titulo: `A verba está voltando à de antes: ${contar(semVoltar, 'campanha ainda não chegou', 'campanhas ainda não chegaram')}`, sub: 'em até 10% por dia' });
  } else {
    trilha.push({ estado: 'ok', titulo: `A verba voltou à de antes (${reais(r.base_micros)} por dia)`, sub: fora ? `${contar(fora, 'campanha saiu', 'campanhas saíram')} do ritmo e ${fora === 1 ? 'ficou' : 'ficaram'} como estava na Meta` : null });
  }
  return trilha;
}

export type LinhaDoRitmoNaRegiao = { chave: string; icone: NomeIcone; titulo: string; texto: string; href: string | null };

const DA_SEMANA_QUE_VEM: Record<string, { titulo: string; texto: string }> = {
  pedido: { titulo: 'O ritmo da semana que vem espera a sua aprovação', texto: 'o Gestor de tráfego montou a verba de cada dia pelos pedidos da loja, pela previsão do tempo e pelas datas' },
  aprovado: { titulo: 'O ritmo da semana que vem está aprovado', texto: 'começa na segunda, e o Liame muda a verba no começo de cada dia' },
  cancelado: { titulo: 'O ritmo da semana que vem não foi aprovado', texto: 'a verba de cada campanha fica como está' },
  parado: { titulo: 'O ritmo da semana que vem foi parado', texto: 'a verba de cada campanha fica como está' },
};

/**
 * A linha do ritmo em Sua região › A semana que vem (D-RG-65): o ritmo que roda nesta semana e o que foi pedido para a
 * que vem, cada um com o caminho para Aprovações. Sem ritmo nenhum, a lista vem vazia e a tela não mostra nada.
 */
export function linhasDoRitmoNaRegiao(r: Pick<RegionRhythmResponse, 'running' | 'proposed'>): LinhaDoRitmoNaRegiao[] {
  const semana = (x: RegionRhythmRef) => `De ${diaMes(x.week.from)} a ${diaMes(x.week.to)}`;
  const href = (x: RegionRhythmRef) => (x.action_id ? `/aprovacoes?pedido=${x.action_id}` : null);
  const linhas: LinhaDoRitmoNaRegiao[] = [];
  const agora = r.running;
  if (agora) {
    linhas.push(
      agora.status === 'parado'
        ? { chave: agora.id, icone: 'pause', titulo: 'O ritmo desta semana foi parado', texto: `${semana(agora)}: a verba de cada campanha volta à de antes, até 10% por dia.`, href: href(agora) }
        : { chave: agora.id, icone: 'chart', titulo: 'O ritmo desta semana está rodando', texto: `${semana(agora)}: o Liame muda a verba no começo de cada dia, dentro do que foi aprovado.`, href: href(agora) },
    );
  }
  const vem = r.proposed;
  const frase = vem && vem.id !== agora?.id ? DA_SEMANA_QUE_VEM[vem.status] : undefined;
  if (vem && frase) linhas.push({ chave: vem.id, icone: 'calendar', titulo: frase.titulo, texto: `${semana(vem)}: ${frase.texto}.`, href: href(vem) });
  return linhas;
}
