import type { Metadata } from 'next';
import { TimeTela } from '@/components/agencia/time-tela';

export const metadata: Metadata = { title: 'Time da agência · Liame' };

// Time da agência (P27 aprovado; A7, W6, parte 5).
export default function TimePage() {
  return <TimeTela />;
}
