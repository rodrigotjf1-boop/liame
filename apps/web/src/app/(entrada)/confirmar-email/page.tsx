import type { Metadata } from 'next';
import { Suspense } from 'react';
import { TelaConfirmarEmail } from '@/components/entrada/tela-confirmar-email';

export const metadata: Metadata = { title: 'Confirmar e-mail · Liame' };

// A tela lê a URL (volta, token): com Cache Components, isso fica dentro de um Suspense.
export default function Pagina() {
  return (
    <Suspense fallback={null}>
      <TelaConfirmarEmail />
    </Suspense>
  );
}
