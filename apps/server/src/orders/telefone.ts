// Telefone em E.164 antes de virar índice cego (ADR-019 item 8). O mesmo cliente chega do Regem
// ("(21) 99999-8888") e do WhatsApp (wa_id "552199998888", muitas vezes SEM o nono dígito): os dois
// precisam dar o mesmo texto, senão o índice cego não liga a conversa ao pedido (integrations.md §6.3).

/** Celular brasileiro com 8 dígitos (começa com 6 a 9) ganha o nono dígito; fixo (2 a 5) fica como está. */
function assinanteBr(numero: string): string | null {
  if (/^9\d{8}$/.test(numero)) return numero;
  if (/^[6-9]\d{7}$/.test(numero)) return `9${numero}`;
  if (/^[2-5]\d{7}$/.test(numero)) return numero;
  return null;
}

function brasil(nacional: string): string | null {
  const ddd = nacional.slice(0, 2);
  if (!/^[1-9][1-9]$/.test(ddd)) return null;
  const assinante = assinanteBr(nacional.slice(2));
  return assinante ? `+55${ddd}${assinante}` : null;
}

/**
 * Normaliza para E.164 (`+5521999998888`). Sem código de país, vale o Brasil. Devolve `null` quando
 * não dá para ter certeza do número: melhor sem ligação do que ligar a pessoa errada.
 */
export function normalizarTelefone(bruto: string | null | undefined): string | null {
  if (!bruto) return null;
  const texto = bruto.trim();
  if (!texto || texto.length > 40) return null;
  const internacional = texto.startsWith('+') || texto.startsWith('00');
  let digitos = texto.replace(/\D/g, '');
  if (texto.startsWith('00')) digitos = digitos.slice(2);

  if (internacional) {
    if (digitos.startsWith('55')) return brasil(digitos.slice(2));
    return /^[1-9]\d{7,14}$/.test(digitos) ? `+${digitos}` : null;
  }
  // Sem "+": número nacional (com ou sem o 0 de longa distância) ou com o 55 na frente, como o wa_id.
  if ((digitos.length === 12 || digitos.length === 13) && digitos.startsWith('55')) return brasil(digitos.slice(2));
  const nacional = digitos.replace(/^0+/, '');
  if (nacional.length === 10 || nacional.length === 11) return brasil(nacional);
  return null;
}
