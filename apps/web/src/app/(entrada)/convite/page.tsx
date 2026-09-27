import type { Metadata } from 'next';
import { Suspense } from 'react';
import { TelaConvite } from '@/components/entrada/tela-convite';

export const metadata: Metadata = { title: 'Convite · Liame' };

// A tela lê a URL (volta, token): com Cache Components, isso fica dentro de um Suspense.
export default function Pagina() {
  return (
    <Suspense fallback={null}>
      <TelaConvite />
    </Suspense>
  );
}
