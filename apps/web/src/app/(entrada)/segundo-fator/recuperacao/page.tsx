import type { Metadata } from 'next';
import { Suspense } from 'react';
import { TelaRecuperacao } from '@/components/entrada/tela-recuperacao';

export const metadata: Metadata = { title: 'Recuperar a conta · Liame' };

// A tela lê a URL (volta): com Cache Components, isso fica dentro de um Suspense.
export default function Pagina() {
  return (
    <Suspense fallback={null}>
      <TelaRecuperacao />
    </Suspense>
  );
}
