// Frescor de cada fonte (data-model §3.1): toda métrica entregue a tela ou agente leva o seu.
// fresh: dentro do intervalo esperado (com folga de 50%); delayed: até 3 intervalos; stale: além disso;
// unknown: nunca sincronizou.

export type Frescor = 'fresh' | 'delayed' | 'stale' | 'unknown';

export function frescor(estado: { lastSuccessAt: Date | string | null; expectedEveryMinutes: number }, agora: Date = new Date()): Frescor {
  if (!estado.lastSuccessAt) return 'unknown';
  const idadeMin = (agora.getTime() - new Date(estado.lastSuccessAt).getTime()) / 60_000;
  if (idadeMin <= estado.expectedEveryMinutes * 1.5) return 'fresh';
  if (idadeMin <= estado.expectedEveryMinutes * 3) return 'delayed';
  return 'stale';
}
