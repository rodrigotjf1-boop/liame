import type { AcaoSombra } from '../sombra/regras.js';
import { type ItemCiclo, reais } from './atencao-ciclo.js';

// A recomendação da sombra que aparece na Atenção (A3, I13): só quando a ação, naquela conta, saiu de Sombra (a
// pessoa aprovou a promoção para Sugerir, ou a política da empresa diz outro modo). Na A3 nada é executado: o
// aviso diz o que o Gestor de tráfego faria, com os números do retrato da decisão (os mesmos da tela Resultados),
// e quem muda na plataforma é a pessoa. Função pura: quem lê o banco é o `AtencaoCicloService`.

/** "na Meta", "no Google Ads": a plataforma com a preposição certa. */
const NA_PLATAFORMA: Record<string, string> = { meta_ads: 'na Meta', google_ads: 'no Google Ads' };

/** A recomendação em aberto, com o retrato do dia em que foi feita. */
export interface SugestaoDaSombra {
  tool: AcaoSombra;
  campaignId: string;
  connectedAccountId: string;
  provider: string;
  /** Só nas de verba. */
  percent: number | null;
  /** O retrato gravado pela sombra (`shadow_decision.state_snapshot`). */
  retrato: {
    campanha?: { nome?: string; verba_diaria_micros?: string | null };
    janela?: { ate?: string };
    plataforma?: { spend_micros?: string };
    caixa?: { margin_known_micros?: string | null };
  };
}

/** "14/09" a partir de "2026-09-14". */
const diaMes = (dia: string) => `${dia.slice(8, 10)}/${dia.slice(5, 7)}`;

/** O aviso da recomendação, ou nulo se o retrato não tem os números (retrato antigo ou incompleto). */
export function avisoDaSugestao(s: SugestaoDaSombra): ItemCiclo | null {
  const nome = s.retrato.campanha?.nome;
  const ate = s.retrato.janela?.ate;
  const gasto = s.retrato.plataforma?.spend_micros;
  const margem = s.retrato.caixa?.margin_known_micros;
  if (!nome || !ate || gasto === undefined || margem === undefined || margem === null) return null;
  const plataforma = NA_PLATAFORMA[s.provider] ?? `em ${s.provider}`;
  const base = { severity: 'atencao' as const, connected_account_id: s.connectedAccountId, campaign_id: s.campaignId, provider: s.provider };
  const numeros = `Nos 7 dias até ${diaMes(ate)}, ela gastou ${reais(BigInt(gasto))} e deixou ${reais(BigInt(margem))} de margem conhecida no caixa`;
  const verba = s.retrato.campanha?.verba_diaria_micros;
  const novaVerba = (sinal: 1 | -1) => (verba && s.percent ? (BigInt(verba) * BigInt(100 + sinal * s.percent)) / 100n : null);

  if (s.tool === 'campanha_pausar') {
    return {
      ...base,
      kind: 'sugestao_pausar_campanha',
      title: `Sugestão do Gestor de tráfego: pausar a campanha "${nome}"`,
      detail: `${numeros}: menos da metade do que gastou.`,
      action: `Se concordar, pause a campanha ${plataforma}. Nada muda sem você.`,
    };
  }
  const reduzir = s.tool === 'orcamento_reduzir';
  const nova = novaVerba(reduzir ? -1 : 1);
  const daVerba = verba && nova !== null ? ` A verba diária iria de ${reais(BigInt(verba))} para ${reais(nova)}.` : '';
  return {
    ...base,
    kind: reduzir ? 'sugestao_reduzir_verba' : 'sugestao_aumentar_verba',
    title: `Sugestão do Gestor de tráfego: ${reduzir ? 'reduzir' : 'aumentar'} a verba da campanha "${nome}"${s.percent ? ` em ${s.percent}%` : ''}`,
    detail: `${numeros}${reduzir ? ': prejuízo.' : ', com a verba no limite.'}${daVerba}`,
    action: `Se concordar, ${reduzir ? 'reduza' : 'aumente'} a verba ${plataforma}. Nada muda sem você.`,
  };
}
