import type { SupportContact } from '@liame/contracts';

/**
 * O atendimento da Liame: para onde leva "Falar com uma pessoa" enquanto não houver atendimento dentro do
 * aplicativo. E-mail, horário e prazo são os dos Termos de Uso (12.2): muda junto com eles.
 */
export const ATENDIMENTO: SupportContact = {
  email: 'suporte@agencialiame.com',
  hours: 'de segunda a sexta-feira, das 9h às 18h (horário de Brasília)',
  response_time: 'em até 1 dia útil',
};
