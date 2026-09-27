import type { Metadata } from 'next';
import { Suspense } from 'react';
import { TelaCriarConta } from '@/components/entrada/tela-criar-conta';

export const metadata: Metadata = { title: 'Criar conta · Liame' };

// A tela lê a URL (volta, token): com Cache Components, isso fica dentro de um Suspense.
export default function Pagina() {
  return (
    <Suspense fallback={null}>
      <TelaCriarConta />
    </Suspense>
  );
}
