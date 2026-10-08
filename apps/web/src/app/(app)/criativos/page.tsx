import type { Metadata } from 'next';
import { Suspense } from 'react';
import { CriativosTela } from '@/components/criativos/criativos-tela';

export const metadata: Metadata = { title: 'Criativos · Liame' };

export default function CriativosPage() {
  // A tela lê `?peca=` do endereço: o Next pede a fronteira de espera para quem lê os parâmetros da busca.
  return (
    <Suspense>
      <CriativosTela />
    </Suspense>
  );
}
