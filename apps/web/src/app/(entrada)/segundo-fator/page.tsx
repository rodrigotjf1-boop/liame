import type { Metadata } from 'next';
import { Suspense } from 'react';
import { TelaSegundoFator } from '@/components/entrada/tela-segundo-fator';

export const metadata: Metadata = { title: 'Código do app · Liame' };

// A tela lê a URL (volta, token): com Cache Components, isso fica dentro de um Suspense.
export default function Pagina() {
  return (
    <Suspense fallback={null}>
      <TelaSegundoFator />
    </Suspense>
  );
}
