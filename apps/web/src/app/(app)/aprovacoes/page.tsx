import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AprovacoesTela } from '@/components/aprovacoes/aprovacoes-tela';

export const metadata: Metadata = { title: 'Aprovações · Liame' };

// A tela lê o pedido a abrir na URL (?pedido, do e-mail e da aba Cupons): com Cache Components, isso fica dentro de um Suspense.
export default function AprovacoesPage() {
  return (
    <Suspense fallback={null}>
      <AprovacoesTela />
    </Suspense>
  );
}
