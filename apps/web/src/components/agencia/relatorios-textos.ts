import type { AgencyReportItem, AgencyReportRecipient } from '@liame/contracts';
import { dataDe } from '@/components/equipe/textos';
import { diaHora } from '@/lib/formato';

// As frases da tela Relatórios da agência (P29 aprovado; A7, W7, parte 5b): a situação do relatório do mês de cada
// marca de cada cliente, o resumo do envio e o mês. Quem decide é o servidor (`relatorios.service.ts`).

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

/** "outubro" de "2026-10" (ou de "2026-10-01"). */
export function nomeDoMes(mes: string): string {
  return MESES[Number(mes.slice(5, 7)) - 1] ?? mes;
}

/** "Outubro de 2026" de "2026-10". */
export function mesDoTitulo(mes: string): string {
  const nome = nomeDoMes(mes);
  return `${nome.charAt(0).toUpperCase()}${nome.slice(1)} de ${mes.slice(0, 4)}`;
}

export const pessoas = (n: number) => `${n} ${n === 1 ? 'pessoa' : 'pessoas'}`;

export type SituacaoDoRelatorio = { tom: 'aguardando' | 'concluido' | 'perigo' | 'espera'; rotulo: string; texto: string; acao: 'revisar' | 'ver' | null };

/** A situação de um relatório na lista: o selo, a frase de baixo e o botão. Um `state` desconhecido fica neutro (ERR-015). */
export function situacaoDoRelatorio(i: AgencyReportItem, cuida: boolean, agora = new Date()): SituacaoDoRelatorio {
  if (i.state === 'esperando' && i.generated_at) {
    return {
      tom: 'aguardando',
      rotulo: `Pronto desde ${diaHora(i.generated_at, agora)} · esperando você`,
      texto: i.liame_email_waits_until ? `O e-mail do Liame do mês espera você até ${diaHora(i.liame_email_waits_until, agora)}.` : '',
      acao: 'revisar',
    };
  }
  if (i.state === 'mandado' && i.last_send) {
    const s = i.last_send;
    const quem = s.mode === 'sozinho' ? 'Saiu sozinho' : `Mandado por ${s.sent_by_name ?? 'alguém da agência'}`;
    return {
      tom: 'concluido',
      rotulo: `${quem} em ${diaHora(s.sent_at, agora)}, para ${pessoas(s.recipients)}${s.version > 1 ? ' · versão corrigida' : ''}`,
      texto: s.has_comment ? 'Com o comentário da agência.' : 'Sem comentário.',
      acao: 'ver',
    };
  }
  if (i.state === 'suspensa') {
    return {
      tom: 'perigo',
      rotulo: `Conta suspensa${i.suspended_since ? ` desde ${dataDe(i.suspended_since)}` : ''}`,
      texto: `O relatório fica só com o dono${i.owner_name ? `, ${i.owner_name},` : ''} até a conta voltar.`,
      acao: null,
    };
  }
  if (i.state === 'sem_relatorio') return { tom: 'espera', rotulo: 'O relatório deste mês não saiu', texto: 'Ele sai no dia 1º, para os meses com as vendas conectadas.', acao: null };
  if (i.state === 'sem_acesso') {
    return { tom: 'espera', rotulo: 'Sem acesso aos resultados', texto: 'O seu nível neste cliente não vê os resultados. Quem escolhe é a dona ou um administrador da agência.', acao: null };
  }
  if (i.state === 'fora_do_time') {
    return {
      tom: 'espera',
      rotulo: 'Você não está no time deste cliente',
      texto: cuida ? 'Coloque-se em "Escolher quem entra", em Clientes, para revisar o relatório.' : '',
      acao: null,
    };
  }
  return { tom: 'espera', rotulo: 'Situação sem tela ainda', texto: '', acao: null };
}

/** "4 relatórios · 1 esperando você". */
export function contagemDosRelatorios(itens: AgencyReportItem[]): string {
  const esperando = itens.filter((i) => i.state === 'esperando').length;
  return `${itens.length} ${itens.length === 1 ? 'relatório' : 'relatórios'} · ${esperando ? `${esperando} esperando você` : 'nenhum esperando você'}`;
}

/** O nome da linha: a marca e, quando é outro, o nome da empresa. */
export function nomeDaLinha(i: AgencyReportItem): { nome: string; empresa: string | null } {
  if (!i.brand) return { nome: i.organization.name, empresa: null };
  return { nome: i.brand.name, empresa: i.brand.name === i.organization.name ? null : i.organization.name };
}

/** Quem recebe por padrão: no primeiro envio, o Dono e os Administradores; ao mandar de novo, quem recebeu antes. */
export function marcadosDePartida(recipients: AgencyReportRecipient[], antes: { name: string; role: string }[] | null): Set<string> {
  if (antes) {
    const chave = new Set(antes.map((p) => `${p.name}|${p.role}`));
    return new Set(recipients.filter((p) => !p.always && chave.has(`${p.name}|${p.role}`)).map((p) => p.user_id));
  }
  return new Set(recipients.filter((p) => p.role === 'administrador').map((p) => p.user_id));
}

/** O assunto do e-mail, como sai (o mesmo do servidor). */
export function assuntoDoEmail(agencia: string, mes: string, marca: string, corrigida: boolean): string {
  return `${agencia}: o relatório de ${nomeDoMes(mes)} da ${marca}${corrigida ? ' (versão corrigida)' : ''}`;
}

/** O comentário no resumo do envio: até 80 caracteres, ou "Sem comentário". */
export function comentarioCurto(c: string): string {
  const t = c.trim();
  if (!t) return 'Sem comentário';
  return t.length > 80 ? `${t.slice(0, 80).trimEnd()}…` : t;
}

/** O aviso depois de mandar. */
export function avisoDeMandado(r: { recipients: number; failed: number; version: number }): string {
  const base = `Relatório mandado a ${pessoas(r.recipients)}${r.version > 1 ? ', como versão corrigida' : ''}.`;
  return r.failed ? `${base} ${r.failed === 1 ? 'Um e-mail não saiu' : `${r.failed} e-mails não saíram`}: tente mandar de novo mais tarde.` : base;
}
