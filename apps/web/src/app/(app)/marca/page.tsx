import type { Metadata } from 'next';
import { MarcaTela } from '@/components/minha-marca/marca-tela';

export const metadata: Metadata = { title: 'Minha marca · Liame' };

export default function MarcaPage() {
  return <MarcaTela />;
}
