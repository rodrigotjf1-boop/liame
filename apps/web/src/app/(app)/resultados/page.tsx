import type { Metadata } from 'next';
import { ResultadosTela } from '@/components/resultados/resultados-tela';

export const metadata: Metadata = { title: 'Resultados · Liame' };

export default function ResultadosPage() {
  return <ResultadosTela />;
}
