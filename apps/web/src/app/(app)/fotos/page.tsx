import type { Metadata } from 'next';
import { FotosTela } from '@/components/fotos/fotos-tela';

export const metadata: Metadata = { title: 'Fotos · Liame' };

export default function FotosPage() {
  return <FotosTela />;
}
