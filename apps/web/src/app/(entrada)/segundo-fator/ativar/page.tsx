import type { Metadata } from 'next';
import { Suspense } from 'react';
import { TelaAtivarApp } from '@/components/entrada/tela-ativar-app';

export const metadata: Metadata = { title: 'Ativar o app autenticador · Liame' };

// A tela lê a URL (volta, token): com Cache Components, isso fica dentro de um Suspense.
export default function Pagina() {
  return (
    <Suspense fallback={null}>
      <TelaAtivarApp />
    </Suspense>
  );
}
