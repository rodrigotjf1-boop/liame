import type { Metadata } from 'next';
import { ComentariosTela } from '@/components/comentarios/comentarios-tela';

export const metadata: Metadata = { title: 'Comentários · Liame' };

export default function ComentariosPage() {
  return <ComentariosTela />;
}
