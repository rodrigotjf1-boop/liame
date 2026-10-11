import { ErroConector } from './cliente-http.js';
import type { ProviderId } from './tipos.js';

// Janela de datas dos conectores: validação (a data vai para URL ou texto de consulta) e fatias.

const DIA_MS = 86_400_000;
const dia = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Só AAAA-MM-DD de verdade: nada de aspas, operador ou data impossível. O mês 13 e o dia 32 nem viram data (o
 * `toISOString` deles estoura um erro que não é do conector): a conferência vem antes.
 */
export function dataValida(provider: ProviderId, d: string): string {
  const formato = typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
  const data = formato ? new Date(`${d}T00:00:00Z`) : null;
  if (!data || Number.isNaN(data.getTime()) || dia(data) !== d) {
    throw new ErroConector('definitivo', provider, `data inválida: ${String(d).slice(0, 20)}`);
  }
  return d;
}

/** Dias corridos de [inicio, fim], contando os dois. */
export function diasNaJanela(inicio: string, fim: string): number {
  return (new Date(`${fim}T00:00:00Z`).getTime() - new Date(`${inicio}T00:00:00Z`).getTime()) / DIA_MS + 1;
}

/** Janela [inicio, fim] em fatias de até `dias` dias, sem buraco nem sobreposição. */
export function fatias(inicio: string, fim: string, dias: number): { since: string; until: string }[] {
  const out: { since: string; until: string }[] = [];
  let atual = new Date(`${inicio}T00:00:00Z`);
  const ultimo = new Date(`${fim}T00:00:00Z`);
  while (atual <= ultimo) {
    const fimFatia = new Date(Math.min(ultimo.getTime(), atual.getTime() + (dias - 1) * DIA_MS));
    out.push({ since: dia(atual), until: dia(fimFatia) });
    atual = new Date(fimFatia.getTime() + DIA_MS);
  }
  return out;
}
