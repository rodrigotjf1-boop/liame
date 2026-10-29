import type { Metadata } from 'next';
import { AgendaTela } from '@/components/agenda/agenda-tela';

export const metadata: Metadata = { title: 'Agenda · Liame' };

export default function AgendaPage() {
  return <AgendaTela />;
}
