import type { AttentionItem, MediaFreshnessResponse } from '@liame/contracts';

// A "visão para o modelo" de cada leitura: o mesmo dado da rota, enxuto e com tudo já formatado como a
// pessoa lê (datas no fuso da empresa, dinheiro em reais). Número cru de 10 dígitos ou mais sairia na
// limpeza de dado pessoal do gateway, e a IA não calcula número final: recebe pronto.

const PLATAFORMA: Record<string, string> = { meta_ads: 'Meta', google_ads: 'Google Ads', ga4: 'GA4', regem: 'Regem', regemcast: 'RegemCast' };
const FRESCOR: Record<string, string> = { fresh: 'em dia', delayed: 'atrasado', stale: 'parado', unknown: 'nunca leu' };
const GRAVIDADE = ['critica', 'atencao', 'info'];

/** Máximo de avisos entregues ao modelo (os mais graves primeiro). */
export const AVISOS_MAXIMO = 40;

export const plataforma = (provider: string | null): string | null => (provider ? (PLATAFORMA[provider] ?? provider) : null);
/** `fresh` → "em dia", `delayed` → "atrasado", `stale` → "parado", `unknown` → "nunca leu". */
export const frescorDe = (frescor: string): string => FRESCOR[frescor] ?? frescor;

/** "02/10/2026 01:54" no fuso da empresa; nulo fica nulo. */
export function quando(iso: string | null, fuso: string): string | null {
  if (!iso) return null;
  const p = new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso));
  const de = (tipo: string) => p.find((x) => x.type === tipo)?.value ?? '';
  return `${de('day')}/${de('month')}/${de('year')} ${de('hour')}:${de('minute')}`;
}

export function visaoDoFrescor(r: MediaFreshnessResponse, fuso: string) {
  return {
    fuso,
    contas: r.items.map((a) => ({
      plataforma: plataforma(a.provider),
      conta: a.name,
      situacao: a.status,
      ...(a.status_reason ? { motivo: a.status_reason } : {}),
      dados: a.datasets.map((d) => ({
        conjunto: d.dataset,
        frescor: FRESCOR[d.freshness] ?? d.freshness,
        ultima_leitura: quando(d.last_success_at, fuso),
        proxima_leitura: quando(d.next_at, fuso),
        ...(d.last_error ? { ultima_falha: d.last_error } : {}),
      })),
    })),
  };
}

export function visaoDosAvisos(itens: AttentionItem[], geradoEm: string, fuso: string) {
  const ordem = (i: AttentionItem) => (GRAVIDADE.indexOf(i.severity) + 1 || GRAVIDADE.length + 1);
  const ordenados = [...itens].sort((a, b) => ordem(a) - ordem(b));
  return {
    gerado_em: quando(geradoEm, fuso),
    total: itens.length,
    ...(itens.length > AVISOS_MAXIMO ? { mostrando: AVISOS_MAXIMO } : {}),
    avisos: ordenados.slice(0, AVISOS_MAXIMO).map((i) => ({
      gravidade: i.severity,
      tipo: i.kind,
      ...(i.provider ? { plataforma: plataforma(i.provider) } : {}),
      titulo: i.title,
      detalhe: i.detail,
      o_que_fazer: i.action,
    })),
  };
}
