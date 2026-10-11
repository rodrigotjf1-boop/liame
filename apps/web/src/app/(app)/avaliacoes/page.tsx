import type { Metadata } from 'next';
import { AvaliacoesTela } from '@/components/avaliacoes/avaliacoes-tela';

export const metadata: Metadata = { title: 'Avaliações · Liame' };

export default function AvaliacoesPage() {
  return <AvaliacoesTela />;
}
