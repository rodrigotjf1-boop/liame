import type { Metadata } from 'next';
import { Inicio } from '@/components/shell/inicio';

export const metadata: Metadata = { title: 'Liame' };

// A raiz do app logado leva à página inicial do modo da pessoa (Resumo no Lite, Atenção no Pro).
export default function InicioPage() {
  return <Inicio />;
}
