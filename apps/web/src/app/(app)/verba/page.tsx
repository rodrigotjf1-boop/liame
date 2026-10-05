import type { Metadata } from 'next';
import { VerbaTela } from '@/components/verba/verba-tela';

export const metadata: Metadata = { title: 'Verba do mês · Liame' };

export default function VerbaPage() {
  return <VerbaTela />;
}
