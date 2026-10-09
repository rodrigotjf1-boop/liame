import type { Metadata } from 'next';
import { MensagensTela } from '@/components/mensagens/mensagens-tela';

export const metadata: Metadata = { title: 'Mensagens · Liame' };

export default function MensagensPage() {
  return <MensagensTela />;
}
