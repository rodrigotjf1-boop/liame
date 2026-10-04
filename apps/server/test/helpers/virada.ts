// A virada do dia nos testes (V89, ERR-092). A suíte leva minutos, e muitos arquivos guardam "hoje" quando são
// carregados (para semear dados e conferir períodos), enquanto as rotas usam o relógio de verdade na hora de cada
// teste. Se a meia-noite cai no meio de um arquivo, o "hoje" dele vira o "ontem" do serviço. O arquivo que seria
// carregado logo antes da virada espera ela passar: o dia que ele guarda vale até o fim dele. Sem banco e sem estado.

/** Os fusos em que a virada do dia muda o resultado de um teste: o das lojas dos testes e o do banco (UTC). */
export const FUSOS_DA_VIRADA = ['America/Sao_Paulo', 'UTC'] as const;

/** Um arquivo de teste leva bem menos que isto: carregado com essa folga antes da meia-noite, ele termina no mesmo dia. */
export const MARGEM_DA_VIRADA_MS = 120_000;

/** Quanto falta, em milissegundos, para a meia-noite do fuso. */
export function faltaParaAMeiaNoite(agora: Date, fuso: string): number {
  const partes = new Intl.DateTimeFormat('en-GB', { timeZone: fuso, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(agora);
  const de = (tipo: string) => Number(partes.find((p) => p.type === tipo)?.value ?? 0);
  const passado = (de('hour') * 3600 + de('minute') * 60 + de('second')) * 1000 + agora.getMilliseconds();
  return 86_400_000 - passado;
}

/**
 * Quanto o arquivo espera antes de carregar: zero longe da virada; perto dela (em qualquer dos fusos), o que falta para
 * a meia-noite e mais uma folga, para o relógio do banco e o da máquina já estarem no dia novo.
 */
export function esperaDaVirada(agora: Date, fusos: readonly string[] = FUSOS_DA_VIRADA, margemMs = MARGEM_DA_VIRADA_MS): number {
  const perto = fusos.map((f) => faltaParaAMeiaNoite(agora, f)).filter((falta) => falta <= margemMs);
  return perto.length ? Math.max(...perto) + 2_000 : 0;
}
