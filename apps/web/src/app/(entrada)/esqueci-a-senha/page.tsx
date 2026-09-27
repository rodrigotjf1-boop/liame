import type { Metadata } from 'next';
import { Suspense } from 'react';
import { TelaEsqueciSenha } from '@/components/entrada/tela-esqueci-senha';

export const metadata: Metadata = { title: 'Esqueci a senha · Liame' };

// A tela lê a URL (volta, token): com Cache Components, isso fica dentro de um Suspense.
export default function Pagina() {
  return (
    <Suspense fallback={null}>
      <TelaEsqueciSenha />
    </Suspense>
  );
}
