import type { Metadata } from 'next';
import { Suspense } from 'react';
import { TelaEntrar } from '@/components/entrada/tela-entrar';

export const metadata: Metadata = { title: 'Entrar · Liame' };

// A tela lê a URL (volta, token): com Cache Components, isso fica dentro de um Suspense.
export default function Pagina() {
  return (
    <Suspense fallback={null}>
      <TelaEntrar />
    </Suspense>
  );
}
