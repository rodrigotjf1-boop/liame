import type { Metadata } from 'next';
import { Suspense } from 'react';
import { TelaSenhaNova } from '@/components/entrada/tela-senha-nova';

export const metadata: Metadata = { title: 'Senha nova · Liame' };

// A tela lê a URL (volta, token): com Cache Components, isso fica dentro de um Suspense.
export default function Pagina() {
  return (
    <Suspense fallback={null}>
      <TelaSenhaNova />
    </Suspense>
  );
}
