import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ContasTela } from '@/components/contas/contas-tela';

export const metadata: Metadata = { title: 'Contas conectadas · Liame' };

// A tela lê a volta da autorização na URL (?conexao, ?erro): com Cache Components, isso fica dentro de um Suspense.
export default function ContasPage() {
  return (
    <Suspense fallback={null}>
      <ContasTela />
    </Suspense>
  );
}
