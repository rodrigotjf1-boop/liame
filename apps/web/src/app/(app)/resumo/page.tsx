import type { Metadata } from 'next';
import { ResumoTela } from '@/components/resumo/resumo-tela';

export const metadata: Metadata = { title: 'Resumo · Liame' };

export default function ResumoPage() {
  return <ResumoTela />;
}
