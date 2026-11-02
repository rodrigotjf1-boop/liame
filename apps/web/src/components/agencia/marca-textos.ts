import type { AgencyBrandResponse, AgencyReportMode, UpdateAgencyBrandRequest } from '@liame/contracts';
import { AGENCY_LOGO_LIMITS } from '@liame/contracts';
import { dataCompleta } from '@/lib/formato';

// As frases e as contas da tela "A marca da agência" (P29 aprovado; A7, W7, parte 5a). Quem decide é o servidor
// (`marca.service.ts`): aqui só se mostra e se evita mandar o que ele recusaria.

/** A situação do e-mail de resposta: confirmado, esperando o link, ou nenhum. */
export function situacaoDaResposta(b: Pick<AgencyBrandResponse, 'reply_to' | 'pending_reply_to'>): { tom: 'concluido' | 'aguardando'; texto: string }[] {
  const itens: { tom: 'concluido' | 'aguardando'; texto: string }[] = [];
  if (b.reply_to) itens.push({ tom: 'concluido', texto: `${b.reply_to.email}: confirmado em ${dataCompleta(b.reply_to.confirmed_at)}` });
  if (b.pending_reply_to) itens.push({ tom: 'aguardando', texto: `Esperando a confirmação: mandamos um link para ${b.pending_reply_to.email}` });
  return itens;
}

/** O arquivo do logo antes de mandar: o mesmo que o servidor confere primeiro (o tipo e o tamanho). */
export function problemaDoArquivo(arquivo: { type: string; size: number }): string | null {
  if (!['image/png', 'image/jpeg'].includes(arquivo.type)) return 'Mande o logo em PNG ou JPG. SVG não vale: ele pode levar código.';
  if (arquivo.size > AGENCY_LOGO_LIMITS.maxBytes) return 'O logo passa de 1 MB. Diminua a imagem e mande de novo.';
  return null;
}

/** O e-mail digitado parece um e-mail (o servidor confere de novo). */
export function emailValido(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}

/** O que mudou no formulário, para o `PATCH` (só o que mudou; o e-mail vazio tira o que havia). */
export function mudancasDaMarca(
  atual: Pick<AgencyBrandResponse, 'name' | 'reply_to' | 'pending_reply_to' | 'report_mode'>,
  form: { nome: string; resposta: string; modo: AgencyReportMode },
): Partial<UpdateAgencyBrandRequest> {
  const m: Partial<UpdateAgencyBrandRequest> = {};
  const nome = form.nome.trim();
  if (nome !== atual.name) m.name = nome;
  const resposta = form.resposta.trim().toLowerCase();
  const vale = atual.pending_reply_to?.email ?? atual.reply_to?.email ?? '';
  if (resposta !== vale) m.reply_to_email = resposta === '' ? null : resposta;
  if (form.modo !== atual.report_mode) m.report_mode = form.modo;
  return m;
}

/** O aviso depois de salvar: com e-mail novo, o link de confirmação. */
export function avisoDeSalvo(m: Partial<UpdateAgencyBrandRequest>): string {
  if (typeof m.reply_to_email === 'string') return `Marca salva. Mandamos um link para ${m.reply_to_email}: o e-mail novo vale depois da confirmação.`;
  return 'Marca salva. Vale para os próximos relatórios.';
}

/** As iniciais da agência, no lugar do logo. */
export function iniciaisDaAgencia(nome: string): string {
  const partes = nome.replace(/^ag[eê]ncia\s+/i, '').trim().split(/\s+/).filter(Boolean);
  return (partes.length > 1 ? `${partes[0]![0]}${partes[1]![0]}` : (partes[0] ?? nome).slice(0, 2)).toUpperCase();
}
