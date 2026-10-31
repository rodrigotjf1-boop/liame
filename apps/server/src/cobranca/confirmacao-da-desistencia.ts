import { dinheiro } from '../ai/registro/formatos.js';

// A confirmação da desistência em 7 dias (A7; `plano-a7.md` D-A7-19 e D-A7-43; Termos 11.1; Decreto 7.962/2013, art.
// 5º: a desistência pela mesma ferramenta da contratação, com a confirmação imediata). O protocolo sai da própria
// assinatura (o mesmo na resposta da rota, na tela, na auditoria e no e-mail, sem tabela nova), e o e-mail vai a quem
// desistiu, só texto, depois de a transação gravar.

/**
 * O protocolo da desistência: "L-2026-1A2B3C4D", o ano do pedido e os 8 últimos caracteres do id da assinatura (a parte
 * aleatória do UUID v7). Não muda: pedir de novo a tela ou o e-mail dá o mesmo número.
 */
export function protocoloDaDesistencia(assinaturaId: string, quando: Date): string {
  return `L-${quando.getUTCFullYear()}-${assinaturaId.replace(/-/g, '').slice(-8).toUpperCase()}`;
}

export interface DadosDaDesistencia {
  marca: string;
  protocolo: string;
  /** O instante do pedido e o fuso da empresa (a data e a hora do e-mail são as do calendário dela). */
  quando: Date;
  fuso: string;
  /** O que volta, em centavos, e por onde (a forma da assinatura). */
  devolveCents: number;
  forma: string;
  /** O endereço de Plano e cobrança da marca. */
  link: string;
}

const dataEHora = (quando: Date, fuso: string) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(quando)
      .map((x) => [x.type, x.value]),
  );
  return { data: `${p.day}/${p.month}/${p.year}`, hora: `${p.hour}:${p.minute}` };
};

/** O e-mail da confirmação (só texto): o pedido, o protocolo, a devolução e onde acompanhar. */
export function emailDaDesistencia(d: DadosDaDesistencia): { subject: string; text: string } {
  const { data, hora } = dataEHora(d.quando, d.fuso);
  const para = d.forma === 'cartao' ? 'pelo estorno no cartão' : 'para a conta que pagou o PIX';
  // `dinheiro` recebe micros (centavos × 10.000), com o espaço comum depois do "R$" (V63).
  const devolucao = d.devolveCents > 0 ? `Devolução: ${dinheiro((BigInt(d.devolveCents) * 10_000n).toString())}, ${para}.` : 'Devolução: nada foi pago nesta assinatura, então não há o que devolver.';
  return {
    subject: `Liame: recebemos a sua desistência da assinatura da ${d.marca}`,
    text: [
      `Recebemos o seu pedido de desistência da assinatura da ${d.marca} em ${data}, às ${hora}.`,
      '',
      `Protocolo: ${d.protocolo}`,
      devolucao,
      '',
      'A assinatura terminou no pedido. A devolução foi pedida ao meio de pagamento e aparece em Plano e cobrança quando for feita.',
      '',
      `Plano e cobrança: ${d.link}`,
      '',
      'Este e-mail é a confirmação do seu pedido (Termos de Uso, item 11.1). Guarde o protocolo.',
    ].join('\n'),
  };
}
